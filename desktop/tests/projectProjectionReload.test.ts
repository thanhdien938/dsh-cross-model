import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { ReadProjection } from '../electron/main/services/readProjection';

// P7-R0.4 Part Q: direct, real-filesystem tests for
// ReadProjection.reloadProjects() (finding P7-M04 — the Desktop sidebar
// stayed at 2 projects after Add Folder added a real 3rd one, because
// ReadProjection cached `this.projects` once at initialize() time and
// nothing ever reloaded it).
//
// `initialize()` requires a real Postgres DSN env var and a real SQLite
// file to exist, but neither actually needs to be REACHABLE for these
// tests: `pg.Pool` is lazy (never connects until a query runs, and
// reloadProjects() never queries it), and better-sqlite3 only needs the
// file to exist with `fileMustExist: true` — a freshly-created empty file
// satisfies that. So every test here runs against a real ReadProjection
// instance, a real temp config/projects_file pair, and real fs operations
// — no mocking of ReadProjection itself, matching this repo's preference
// for real-behavior tests over mocks wherever practical.

let dir: string;
let configPath: string;
let projectsPath: string;
let sqlitePath: string;
let repoADir: string;
let repoBDir: string;
let repoCDir: string;

function writeProjectsYaml(projects: Array<{ id: string; display_name?: string; repo_path: string }>) {
  const lines = ['projects:'];
  for (const p of projects) {
    lines.push(`  - id: ${p.id}`);
    if (p.display_name) lines.push(`    display_name: ${p.display_name}`);
    lines.push(`    repo_path: ${p.repo_path}`);
  }
  fs.writeFileSync(projectsPath, lines.join('\n') + '\n', 'utf8');
}

function writeConfigYaml() {
  fs.writeFileSync(
    configPath,
    [
      `projects_file: projects.yaml`,
      `postgres:`,
      `  dsn_env: DSH_TEST_PROJECTION_DSN`,
      `sqlite:`,
      `  path: state.sqlite`,
      '',
    ].join('\n'),
    'utf8',
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-projection-reload-'));
  configPath = path.join(dir, 'local-config.production.yaml');
  projectsPath = path.join(dir, 'projects.yaml');
  sqlitePath = path.join(dir, 'state.sqlite');
  repoADir = path.join(dir, 'repo-a');
  repoBDir = path.join(dir, 'repo-b');
  repoCDir = path.join(dir, 'repo-c');
  fs.mkdirSync(repoADir);
  fs.mkdirSync(repoBDir);
  // repoCDir deliberately NOT created for the PATH_MISSING test.

  writeConfigYaml();
  writeProjectsYaml([
    { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
    { id: 'proj-b', display_name: 'Project B', repo_path: './repo-b' },
  ]);
  new Database(sqlitePath).close(); // real, empty, valid sqlite file
  process.env.DSH_TEST_PROJECTION_DSN = 'postgresql://fake-host-never-connected/fake';
});

afterEach(() => {
  delete process.env.DSH_TEST_PROJECTION_DSN;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function initializedProjection(): Promise<ReadProjection> {
  const projection = new ReadProjection(dir, configPath);
  await projection.initialize();
  return projection;
}

describe('ReadProjection.reloadProjects()', () => {
  it('1. refuses to run before initialize() — never touches an uninitialized instance', async () => {
    const projection = new ReadProjection(dir, configPath);
    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_NOT_INITIALIZED', message: expect.any(String) });
  });

  it('2. initializes with 2 projects, projects.yaml mutates to 3, reload picks up exactly 3', async () => {
    const projection = await initializedProjection();
    await expect(projection.getProjects()).resolves.toHaveLength(2);

    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-b', display_name: 'Project B', repo_path: './repo-b' },
      { id: 'proj-c', display_name: 'Project C', repo_path: './repo-c' },
    ]);
    // Make repo-c a real directory this time so it comes back READY.
    fs.mkdirSync(repoCDir);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: true, count: 3 });

    const projects = await projection.getProjects();
    expect(projects).toHaveLength(3);
    expect(projects.map((p) => p.id).sort()).toEqual(['proj-a', 'proj-b', 'proj-c']);
    const added = projects.find((p) => p.id === 'proj-c')!;
    expect(added.name).toBe('Project C');
    expect(added.state).toBe('READY');

    await projection.close();
  });

  it('3. Postgres pool and SQLite handle identity are unchanged by a reload (no reconnect, no reopen)', async () => {
    const projection = await initializedProjection();
    const pgBefore = (projection as any).pgPool;
    const sqliteBefore = (projection as any).sqliteDb;

    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-b', display_name: 'Project B', repo_path: './repo-b' },
      { id: 'proj-c', display_name: 'Project C', repo_path: './repo-c' },
    ]);
    fs.mkdirSync(repoCDir);

    const result = await projection.reloadProjects();
    expect(result.ok).toBe(true);
    expect((projection as any).pgPool).toBe(pgBefore);
    expect((projection as any).sqliteDb).toBe(sqliteBefore);

    await projection.close();
  });

  it('4. a missing projects_file on reload fails closed and keeps the prior 2-project list', async () => {
    const projection = await initializedProjection();
    fs.unlinkSync(projectsPath);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_FILE_MISSING', message: expect.any(String) });

    const projects = await projection.getProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.id).sort()).toEqual(['proj-a', 'proj-b']);

    await projection.close();
  });

  it('5. a malformed (unparsable YAML) projects_file on reload fails closed and keeps the prior list', async () => {
    const projection = await initializedProjection();
    fs.writeFileSync(projectsPath, '  projects:\n  - id: [unterminated\n', 'utf8');

    const result = await projection.reloadProjects();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('PROJECT_RELOAD_FAILED');

    const projects = await projection.getProjects();
    expect(projects).toHaveLength(2);

    await projection.close();
  });

  it('6. a missing production config file on reload fails closed and keeps the prior list', async () => {
    const projection = await initializedProjection();
    fs.unlinkSync(configPath);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_CONFIG_MISSING', message: expect.any(String) });

    await expect(projection.getProjects()).resolves.toHaveLength(2);

    await projection.close();
  });

  it('7. a config file missing projects_file on reload fails closed and keeps the prior list', async () => {
    const projection = await initializedProjection();
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_PROJECTION_DSN\nsqlite:\n  path: state.sqlite\n', 'utf8');

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_CONFIG_INVALID', message: expect.any(String) });
    await expect(projection.getProjects()).resolves.toHaveLength(2);

    await projection.close();
  });

  it('8. duplicate project ids on reload fail closed with PROJECT_RELOAD_DUPLICATE_ID and keep the prior list', async () => {
    const projection = await initializedProjection();
    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-a', display_name: 'Project A duplicate', repo_path: './repo-b' },
    ]);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_DUPLICATE_ID', message: expect.any(String) });

    const projects = await projection.getProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.id).sort()).toEqual(['proj-a', 'proj-b']);

    await projection.close();
  });

  it('9. a project entry missing a valid id fails closed with PROJECT_RELOAD_INVALID_ENTRY', async () => {
    const projection = await initializedProjection();
    fs.writeFileSync(projectsPath, 'projects:\n  - display_name: No Id\n    repo_path: ./repo-a\n', 'utf8');

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: false, code: 'PROJECT_RELOAD_INVALID_ENTRY', message: expect.any(String) });

    await projection.close();
  });

  it('10. a project whose repo_path does not exist reloads as PATH_MISSING, not an error and not dropped', async () => {
    const projection = await initializedProjection();
    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-b', display_name: 'Project B', repo_path: './repo-b' },
      { id: 'proj-c', display_name: 'Project C', repo_path: './repo-c' }, // repo-c never created
    ]);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: true, count: 3 });

    const projects = await projection.getProjects();
    const missing = projects.find((p) => p.id === 'proj-c')!;
    expect(missing).toBeDefined();
    expect(missing.state).toBe('PATH_MISSING');

    await projection.close();
  });

  it('11. a newly-added project carries no arming/selection state of its own — reload only ever returns id/name/path/state/pushRemotePolicy', async () => {
    const projection = await initializedProjection();
    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-b', display_name: 'Project B', repo_path: './repo-b' },
      { id: 'proj-c', display_name: 'Project C', repo_path: './repo-c' },
    ]);
    fs.mkdirSync(repoCDir);

    await projection.reloadProjects();
    const projects = await projection.getProjects();
    const added = projects.find((p) => p.id === 'proj-c')!;
    // Selection/arming is exclusively renderer-side state (App.tsx); the
    // projection's Project shape has no armed/selected field to assert
    // false on — its ABSENCE here is exactly what keeps reload from being
    // able to auto-arm anything. P12-R5A: `pushRemotePolicy` is additive
    // (the new safe PUSH_REMOTE projection, Part P) — every other field is
    // unchanged.
    expect(Object.keys(added).sort()).toEqual(['id', 'name', 'path', 'pushRemotePolicy', 'state']);

    await projection.close();
  });

  it('12. reload is idempotent: calling it twice in a row with no file changes yields the same 2 projects, not a duplicate', async () => {
    const projection = await initializedProjection();
    const first = await projection.reloadProjects();
    const second = await projection.reloadProjects();
    expect(first).toEqual({ ok: true, count: 2 });
    expect(second).toEqual({ ok: true, count: 2 });
    const projects = await projection.getProjects();
    expect(projects).toHaveLength(2);

    await projection.close();
  });

  it('13. a reload that removes a project reflects the shrink, not a stale union of old and new', async () => {
    const projection = await initializedProjection();
    writeProjectsYaml([{ id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' }]);

    const result = await projection.reloadProjects();
    expect(result).toEqual({ ok: true, count: 1 });
    const projects = await projection.getProjects();
    expect(projects.map((p) => p.id)).toEqual(['proj-a']);

    await projection.close();
  });

  it('14. a reload atomically replaces the list — a caller reading getProjects() never observes a partially-built array', async () => {
    const projection = await initializedProjection();
    writeProjectsYaml([
      { id: 'proj-a', display_name: 'Project A', repo_path: './repo-a' },
      { id: 'proj-b-dup', display_name: 'B', repo_path: './repo-b' },
      { id: 'proj-b-dup', display_name: 'B again', repo_path: './repo-b' },
    ]);
    const result = await projection.reloadProjects();
    expect(result.ok).toBe(false);
    // Old 2-project list is exactly what is still there — not 1, not 3.
    const projects = await projection.getProjects();
    expect(projects).toHaveLength(2);

    await projection.close();
  });

  it('15. close() after a successful reload still tears down pgPool/sqliteDb normally', async () => {
    const projection = await initializedProjection();
    await projection.reloadProjects();
    await projection.close();
    await expect(projection.getProjects()).rejects.toThrow('Projection not initialized');
  });
});
