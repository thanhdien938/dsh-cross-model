// P13-R1 §3.2: canonical PHYSICAL workspace identity --
// workspace_id := sha256(normalize(realpath(project.repo_path))) -- derived
// once by p5-production-config.mjs's validateProjects(), runtime-
// authoritative, NEVER project.id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';

function writeProjectsConfig(root, projectsYaml) {
  writeFileSync(join(root, 'projects.yaml'), projectsYaml);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(
    join(root, 'config.yaml'),
    `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions: []\n`,
  );
  return { path: join(root, 'config.yaml'), env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } };
}

test('workspace_id is a non-empty string, stable across independent loads of the same config, and is not project.id', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-ws-stable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-a'));
  const f = writeProjectsConfig(root, `projects:\n  - id: proj-a\n    repo_path: ./repo-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  const first = await loadP5ProductionConfig(f.path, { env: f.env });
  const second = await loadP5ProductionConfig(f.path, { env: f.env });
  const a1 = first.projects.find((p) => p.id === 'proj-a');
  const a2 = second.projects.find((p) => p.id === 'proj-a');
  assert.equal(typeof a1.workspace_id, 'string');
  assert.ok(a1.workspace_id.length > 0);
  assert.equal(a1.workspace_id, a2.workspace_id, 'the same physical path must always derive the same workspace_id');
  assert.notEqual(a1.workspace_id, a1.id);
  assert.equal(a1.workspace_verified, true);
});

test('two projects with genuinely different repo_paths get different workspace_id', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-ws-distinct-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-a'));
  mkdirSync(join(root, 'repo-b'));
  const f = writeProjectsConfig(root, `projects:\n  - id: proj-a\n    repo_path: ./repo-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n  - id: proj-b\n    repo_path: ./repo-b\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const a = config.projects.find((p) => p.id === 'proj-a');
  const b = config.projects.find((p) => p.id === 'proj-b');
  assert.notEqual(a.workspace_id, b.workspace_id);
});

// The acceptance scenario named explicitly in the architecture plan (§3.2):
// project A and project B both pointing at repo_path = E:\repo-x resolve to
// the SAME workspace_id despite differing project.id.
test('two DIFFERENT project ids pointing at the exact same repo_path resolve to the identical workspace_id', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-ws-same-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-x'));
  const f = writeProjectsConfig(root, `projects:\n  - id: proj-alpha\n    repo_path: ./repo-x\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n  - id: proj-beta\n    repo_path: ./repo-x\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const alpha = config.projects.find((p) => p.id === 'proj-alpha');
  const beta = config.projects.find((p) => p.id === 'proj-beta');
  assert.equal(alpha.workspace_id, beta.workspace_id);
  assert.notEqual(alpha.id, beta.id);
});

test('P15-C-008 existing path aliases: trailing separator, slash direction, and drive-letter case preserve one workspace identity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p15-ws-text-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo-real');
  mkdirSync(repo);
  const variants = [repo, `${repo}${process.platform === 'win32' ? '\\' : '/'}`];
  if (process.platform === 'win32') {
    variants.push(repo.replaceAll('\\', '/'));
    variants.push(`${repo[0] === repo[0].toUpperCase() ? repo[0].toLowerCase() : repo[0].toUpperCase()}${repo.slice(1)}`);
  }
  const projectsYaml = `projects:\n${variants.map((variant, index) => `  - id: proj-${index}\n    repo_path: '${variant.replaceAll("'", "''")}'\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}`).join('\n')}\n`;
  const f = writeProjectsConfig(root, projectsYaml);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(new Set(config.projects.map((project) => project.workspace_id)).size, 1, 'every executable alias realpath()s to one physical identity');
  assert.equal(config.projects.every((project) => project.workspace_verified), true);
});

// realpath alias handling: a directory symlink/junction pointing at the
// SAME physical directory as another registered project must resolve to
// the identical workspace_id -- this is the whole reason §3.2 requires
// realpath(), not a textual path comparison.
test('realpath alias: a directory junction pointing at another project\'s physical path resolves to the identical workspace_id', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-ws-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-real'));
  let aliasSupported = true;
  try { symlinkSync(join(root, 'repo-real'), join(root, 'repo-alias'), 'junction'); }
  catch { aliasSupported = false; }
  if (!aliasSupported) { t.skip('directory symlink/junction creation is not permitted in this environment'); return; }
  const f = writeProjectsConfig(root, `projects:\n  - id: proj-real\n    repo_path: ./repo-real\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n  - id: proj-alias\n    repo_path: ./repo-alias\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const real = config.projects.find((p) => p.id === 'proj-real');
  const alias = config.projects.find((p) => p.id === 'proj-alias');
  assert.equal(real.workspace_id, alias.workspace_id, 'a symlink/junction alias must realpath() to the same physical workspace');
});

test('a path_missing project falls back to an UNVERIFIED workspace identity rather than failing config load', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-ws-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-a'));
  // repo-b is deliberately never created.
  const f = writeProjectsConfig(root, `projects:\n  - id: proj-a\n    repo_path: ./repo-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n  - id: proj-b\n    repo_path: ./repo-b\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const b = config.projects.find((p) => p.id === 'proj-b');
  assert.equal(b.path_missing, true);
  assert.equal(b.workspace_verified, false);
  assert.equal(typeof b.workspace_id, 'string');
  assert.ok(b.workspace_id.length > 0, 'an unverified project is still its own exclusive workspace, never a null/empty identity');
});
