import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadP5ProductionConfig, publicP5Config } from '../src/runtime/p5-production-config.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';

function fixture(t, { missingB = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p6-w2-r1-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo-a'));
  if (!missingB) mkdirSync(join(root, 'repo-b'));
  writeFileSync(
    join(root, 'projects.yaml'),
    `projects:\n  - id: proj-a\n    repo_path: ./repo-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n  - id: proj-b\n    repo_path: ./repo-b\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`,
  );
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(
    join(root, 'config.yaml'),
    `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions:\n    - type: finish\n      output: ok\n`,
  );
  return { root, path: join(root, 'config.yaml'), env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } };
}

test('a project whose directory does not exist loads as path_missing, other projects stay usable', async (t) => {
  const f = fixture(t, { missingB: true });
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const a = config.projects.find((p) => p.id === 'proj-a');
  const b = config.projects.find((p) => p.id === 'proj-b');
  assert.equal(a.path_missing, false);
  assert.equal(b.path_missing, true);
  // No repoint, no substitution: the configured (absolute) path is preserved verbatim.
  assert.match(b.repo_path, /repo-b$/);
});

test('when the path exists, path_missing is false and nothing is degraded', async (t) => {
  const f = fixture(t, { missingB: false });
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.projects.every((p) => p.path_missing === false), true);
});

test('publicP5Config surfaces path_missing and never claims repo_path_present for a missing path', async (t) => {
  const f = fixture(t, { missingB: true });
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const pub = publicP5Config(config);
  const b = pub.projects.find((p) => p.id === 'proj-b');
  assert.equal(b.path_missing, true);
  assert.equal(b.repo_path_present, false);
});

test('a genuinely invalid repo_path value (missing field) still fails config load — CONFIG INVALID stays distinct from PATH MISSING', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p6-w2-r1-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: proj-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {}}\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(
    join(root, 'config.yaml'),
    `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm: {}\n`,
  );
  await assert.rejects(
    loadP5ProductionConfig(join(root, 'config.yaml'), { env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } }),
    /project repo path is required/,
  );
});

test('duplicate project id still fails config load (regression, unaffected by path_missing change)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p6-w2-r1-dup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - &p {id: p, repo_path: ./repo, default_pm_profile_id: pm, autonomy: {revision: 1, effects: {}}}\n  - *p\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(
    join(root, 'config.yaml'),
    `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm: {}\n`,
  );
  await assert.rejects(
    loadP5ProductionConfig(join(root, 'config.yaml'), { env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } }),
    /duplicate project ID/,
  );
});

test('OwnerControlService refuses SUBMIT_TASK for a path_missing project before task materialization, other projects unaffected', async () => {
  const repository = {
    beginCommand: async (command) => ({ status: 'ACCEPTED', command_id: command.command_id }),
    completeCommand: async (commandId, canonical) => ({ command_id: commandId, status: 'COMPLETED', canonical_result: canonical }),
  };
  let submitCalls = 0;
  const taskController = { submit: async () => { submitCalls += 1; return { status: 'MATERIALIZED', task_id: 't-1', pm_run_id: 'r-1' }; } };
  const projects = [
    { id: 'proj-a', path_missing: false, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } }, default_pm_profile_id: 'pm' },
    { id: 'proj-b', path_missing: true, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } }, default_pm_profile_id: 'pm' },
  ];
  const pmProfiles = [{ id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' }];
  const service = new OwnerControlService({ repository, taskController, projects, pmProfiles });

  await assert.rejects(
    service.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj-b', payload: { body: 'x' } }),
    (e) => e.code === 'PROJECT_PATH_MISSING',
  );
  assert.equal(submitCalls, 0);

  const ok = await service.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj-a', payload: { body: 'x' } });
  assert.equal(ok.canonical_result.status, 'MATERIALIZED');
  assert.equal(submitCalls, 1);
});
