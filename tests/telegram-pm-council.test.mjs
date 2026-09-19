import test from 'node:test';
import assert from 'node:assert/strict';

import { routeTelegramUpdate, parseOwnerFlags, renderOwnerAck, renderTerminalResult, renderFlagsInvalid, renderOwnerError } from '../src/owner/telegram-owner-client.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
const projects = [{ id: 'live1-local' }, { id: 'other-proj' }];

// ---- parseOwnerFlags ---------------------------------------------------

test('parseOwnerFlags: no flags returns the text verbatim', () => {
  const r = parseOwnerFlags('inspect the architecture');
  // P10-R0.2.4 Part B: `taskFile` is an additive field (null when no
  // --task-file directive was present) — every other field/value is
  // byte-for-byte unchanged from before this wave.
  // P12-R5: `durability`/`commit`/`push`/`review` are additive fields too
  // (null/false when their flags were never used) — see
  // parseOwnerFlags()'s own docstring.
  // P19-D4: `debateExtend`/`debateRounds` are additive fields too
  // (false/null when `--debate-extend`/`--debate-rounds` were never
  // used) — deliberately named apart from the pre-existing
  // `debateProfileIds` above (the unrelated `--debate <participants>`
  // flag), see telegram-owner-client.mjs's own BOOLEAN_FLAGS comment.
  // P18-W4: `long` is an additive field too (false when `--long` was
  // never used) — folds onto payload.runtime_class, see
  // telegram-owner-client.mjs's own BOOLEAN_FLAGS comment.
  // P18-W4 ACK-causal-correlation remediation: `clientCorrelationId` is an
  // additive field too (null when `--client-correlation` was never used)
  // — folds onto payload.client_correlation_id, never task_source/body.
  // Council/Debate WORKSPACE_READ remediation: `workspaceRead` is an
  // additive field too (false when `--workspace-read` was never used) —
  // folds onto payload.council.workspace_requirement, never task_source/body.
  // Owner-review remediation Gap B: `workspaceEvidencePaths` is an
  // additive field too (null when `--workspace-evidence` was never used) —
  // folds onto payload.council.workspace_evidence_paths, never task_source/body.
  // P24.1G4: `reportPath`/`reportNonEmpty` are additive fields too (null
  // when `--report-path`/`--report-non-empty` were never used) — fold onto
  // payload.workspace_output, never task_source/body/prose.
  assert.deepEqual(r, {
    pmProfileId: null, debateProfileIds: null, taskFile: null, durability: null, commit: false, push: false, review: false, remote: null,
    parentTaskId: null, remediatesTaskId: null, reviewsTaskId: null, requiresContextTaskId: null,
    debateExtend: false, debateRounds: null, long: false, clientCorrelationId: null, workspaceRead: false, workspaceEvidencePaths: null,
    reportPath: null, reportNonEmpty: null,
    text: 'inspect the architecture',
  });
});

test('parseOwnerFlags: --pm is extracted and stripped', () => {
  const r = parseOwnerFlags('--pm live1-codex-pm report repository name only. Do not modify files.');
  assert.equal(r.pmProfileId, 'live1-codex-pm');
  assert.equal(r.debateProfileIds, null);
  assert.equal(r.text, 'report repository name only. Do not modify files.');
});

test('parseOwnerFlags: --pm + --debate together, in order', () => {
  const r = parseOwnerFlags('--pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm Compare two safe approaches for improving README clarity.');
  assert.equal(r.pmProfileId, 'live1-claude-pm');
  assert.deepEqual(r.debateProfileIds, ['live1-codex-pm', 'live1-grok-pm']);
  assert.equal(r.text, 'Compare two safe approaches for improving README clarity.');
});

test('parseOwnerFlags: --debate auto is rejected explicitly', () => {
  assert.throws(() => parseOwnerFlags('--pm live1-claude-pm --debate auto do the thing'), /auto is not supported/);
});

test('parseOwnerFlags: malformed flags are rejected (missing value, unknown flag, empty debate list, duplicate)', () => {
  assert.throws(() => parseOwnerFlags('--pm'), /requires a value/);
  assert.throws(() => parseOwnerFlags('--bogus x task'), /unknown flag/);
  assert.throws(() => parseOwnerFlags('--debate , task'), /non-empty participant list/);
  assert.throws(() => parseOwnerFlags('--pm a --pm b task'), /more than once/);
});

// ---- routeTelegramUpdate: backward compatibility ------------------------

test('backward compatibility: bare @project task (no flags) is unchanged', () => {
  const routed = routeTelegramUpdate(update('@live1-local inspect the architecture'), { projects });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'live1-local');
  assert.deepEqual(routed.payload, { body: 'inspect the architecture' });
});

test('backward compatibility: bare task with >1 project still refuses (PROJECT_REQUIRED)', () => {
  const routed = routeTelegramUpdate(update('do the thing'), { projects });
  assert.equal(routed.read, 'PROJECT_REQUIRED');
});

test('backward compatibility: bare task with exactly 1 project is unambiguous', () => {
  const routed = routeTelegramUpdate(update('do the thing'), { projects: [projects[0]] });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'live1-local');
});

// ---- routeTelegramUpdate: --pm ------------------------------------------

test('explicit --pm: SUBMIT_TASK carries pm_profile_id and the flag is stripped from body', () => {
  const routed = routeTelegramUpdate(update('@live1-local --pm live1-grok-pm report repository name only. Do not modify files.'), { projects });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.payload.pm_profile_id, 'live1-grok-pm');
  assert.equal(routed.payload.body, 'report repository name only. Do not modify files.');
  assert.equal('council' in routed.payload, false);
});

test('--pm omitted: payload has no pm_profile_id (falls back to project/default PM downstream, unchanged)', () => {
  const routed = routeTelegramUpdate(update('@live1-local inspect the architecture'), { projects });
  assert.equal('pm_profile_id' in routed.payload, false);
});

// ---- routeTelegramUpdate: --debate (council) -----------------------------

test('council syntax: --pm + --debate builds a council payload', () => {
  const routed = routeTelegramUpdate(update('@live1-local --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm Compare two safe approaches for improving README clarity. Do not modify files.'), { projects });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.payload.pm_profile_id, 'live1-claude-pm');
  assert.deepEqual(routed.payload.council, { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'] });
  assert.equal(routed.payload.body, 'Compare two safe approaches for improving README clarity. Do not modify files.');
});

test('council syntax: --debate without --pm is rejected with a human-readable reason (chair required)', () => {
  const routed = routeTelegramUpdate(update('@live1-local --debate live1-codex-pm,live1-grok-pm do the thing'), { projects });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /--debate requires --pm/);
});

test('council syntax: --debate auto is refused, not silently auto-selected', () => {
  const routed = routeTelegramUpdate(update('@live1-local --pm live1-claude-pm --debate auto do the thing'), { projects });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /auto/);
});

test('empty task after flags is still refused (PROJECT_TASK_TEXT_REQUIRED)', () => {
  const routed = routeTelegramUpdate(update('@live1-local --pm live1-claude-pm'), { projects });
  assert.equal(routed.read, 'PROJECT_TASK_TEXT_REQUIRED');
});

// ---- OwnerControlService: validation & unknown-profile refusal ----------

function service({ profiles = ['live1-claude-pm', 'live1-codex-pm', 'live1-grok-pm', 'live1-opencode-pm'], submitted = [] } = {}) {
  const repository = { async beginCommand(command) { return { status: 'ACCEPTED', created_at: '2026-08-21T00:00:00.000Z', command_id: command.command_id }; }, async completeCommand(id, canonical) { return { canonical_result: canonical }; } };
  // P19-D6: mirrors owner-task-controller.mjs#submit()'s real acceptance-ack
  // DTO shape (participant_profile_ids/rounds plus, now, debate/
  // implementation_participant_id when present) — this stub intentionally
  // tracks that shape so a real regression there is caught here too.
  const taskController = { async submit({ command, project, profile, council }) { submitted.push({ command, project, profile, council }); return { status: 'MATERIALIZED', task_id: 'task-1', pm_run_id: 'pmrun-1', pm_profile_id: profile.id, ...(council ? { council: { participant_profile_ids: council.participant_profile_ids, rounds: council.rounds, ...(council.debate?.enabled ? { debate: { enabled: true, max_rounds: council.debate.max_rounds } } : {}), ...(council.implementation_participant_id ? { implementation_participant_id: council.implementation_participant_id } : {}) } } : {}) }; } };
  return new OwnerControlService({ repository, taskController, projects: [{ id: 'live1-local', autonomy: { effects: {} } }], pmProfiles: profiles.map((id) => ({ id })) });
}

test('unknown --pm profile is refused, not silently accepted', async () => {
  const svc = service();
  await assert.rejects(svc.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'ghost-pm' } }), (e) => e instanceof OwnerControlError && e.code === 'PM_PROFILE_UNAVAILABLE');
});

test('valid --pm is honored end to end and the Telegram ack shows the PM', async () => {
  const svc = service();
  const result = await svc.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-codex-pm' } });
  assert.equal(result.canonical_result.pm_profile_id, 'live1-codex-pm');
  const ack = renderOwnerAck('SUBMIT_TASK', result, 'live1-local');
  assert.match(ack, /PM: live1-codex-pm/);
});

test('council: unknown participant is refused', async () => {
  const svc = service();
  await assert.rejects(svc.mutate({ command_id: 'c3', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'ghost'] } } }), (e) => e instanceof OwnerControlError && e.code === 'COUNCIL_UNKNOWN_PARTICIPANT');
});

test('council: duplicate participants refused', async () => {
  const svc = service();
  await assert.rejects(svc.mutate({ command_id: 'c4', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-codex-pm'] } } }), (e) => e.code === 'COUNCIL_DUPLICATE_PARTICIPANT');
});

test('council: zero participants refused', async () => {
  const svc = service();
  await assert.rejects(svc.mutate({ command_id: 'c5', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: [] } } }), (e) => e.code === 'COUNCIL_ZERO_PARTICIPANTS');
});

test('council: accepted council submits chair as the task profile and passes the normalized spec through', async () => {
  const submitted = [];
  const svc = service({ submitted });
  const result = await svc.mutate({ command_id: 'c6', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2 } } });
  assert.equal(submitted[0].profile.id, 'live1-claude-pm');
  assert.deepEqual(submitted[0].council.participant_profile_ids, ['live1-codex-pm', 'live1-grok-pm']);
  const ack = renderOwnerAck('SUBMIT_TASK', result, 'live1-local');
  assert.match(ack, /DSH council accepted/);
  assert.match(ack, /Chair:\nlive1-claude-pm/);
  assert.match(ack, /Participants:\nlive1-codex-pm\nlive1-grok-pm/);
  assert.match(ack, /Rounds:\n2/);
});

// ---- terminal-result rendering (Part P) ---------------------------------

test('renderTerminalResult: council completed shows chair/council/rounds and the final synthesis', () => {
  const text = renderTerminalResult({ runtime_facts: { status: 'completed', project_id: 'live1-local', output: 'FINAL SYNTHESIS TEXT', data: { type: 'council', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2, degraded: false } } });
  assert.match(text, /DSH council completed/);
  assert.match(text, /Chair: live1-claude-pm/);
  assert.match(text, /Council: live1-codex-pm, live1-grok-pm/);
  assert.match(text, /FINAL SYNTHESIS TEXT/);
});

test('renderTerminalResult: degraded council discloses failed/completed participants', () => {
  const text = renderTerminalResult({ runtime_facts: { status: 'completed', output: 'Council degraded: only one participant completed.\n\n...', data: { type: 'council', chair_profile_id: 'live1-claude-pm', rounds: 1, degraded: true, failed_participants: ['live1-grok-pm'], completed_participants: ['live1-codex-pm'] } } });
  assert.match(text, /degraded participation/);
  assert.match(text, /Failed:\nlive1-grok-pm/);
  assert.match(text, /Completed:\nlive1-codex-pm/);
});

// P19-D6 (D6-D): a debate-concluded run's finish data is `type:
// 'council_debate'`, not `'council'` — before this fix it fell through to
// the generic single-PM format, losing chair/participants/rounds entirely.
test('renderTerminalResult: debate-concluded council (type=council_debate) still shows the rich council format, plus rounds-run/unresolved-questions', () => {
  const text = renderTerminalResult({ runtime_facts: { status: 'completed', project_id: 'live1-local', output: 'FINAL DEBATE REPORT TEXT', data: { type: 'council_debate', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2, degraded: false, debate: { enabled: true, max_rounds: 2, rounds_run: 2, final_continue_debate: true, engine_forced_stop: true, unresolved_questions: ['q1'] } } } });
  assert.match(text, /DSH council\/debate completed/);
  assert.match(text, /Chair: live1-claude-pm/);
  assert.match(text, /Council: live1-codex-pm, live1-grok-pm/);
  assert.match(text, /Debate rounds run: 2/);
  assert.match(text, /engine forced stop/);
  assert.match(text, /Unresolved questions: 1/);
  assert.match(text, /FINAL DEBATE REPORT TEXT/);
});

test('renderTerminalResult: degraded debate-concluded council still discloses failed/completed participants', () => {
  const text = renderTerminalResult({ runtime_facts: { status: 'completed', output: 'x', data: { type: 'council_debate', chair_profile_id: 'live1-claude-pm', rounds: 1, degraded: true, failed_participants: ['live1-grok-pm'], completed_participants: ['live1-codex-pm'], debate: { enabled: true, max_rounds: 1, rounds_run: 1, engine_forced_stop: false, unresolved_questions: [] } } } });
  assert.match(text, /Council\/Debate completed with degraded participation/);
  assert.match(text, /Failed:\nlive1-grok-pm/);
  assert.match(text, /Completed:\nlive1-codex-pm/);
  assert.match(text, /Debate rounds run: 1/);
});

// P19-D6 (D6-A/B): the acceptance ack must distinguish Council from
// Council+Debate from Council+Debate+implementation right at acceptance.
test('renderOwnerAck: SUBMIT_TASK council ack shows Debate and implementation participant when the normalized spec carries them', async () => {
  const svc = service();
  const result = await svc.mutate({ command_id: 'c7', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 1, implementation_participant_id: 'live1-codex-pm', debate: { enabled: true, max_rounds: 1 } } } });
  const ack = renderOwnerAck('SUBMIT_TASK', result, 'live1-local');
  assert.match(ack, /Debate:\nenabled, max 1 round\(s\)/);
  assert.match(ack, /Implementation participant:\nlive1-codex-pm/);
});

test('renderOwnerAck: SUBMIT_TASK council ack omits Debate/implementation lines when neither was requested (byte-for-byte pre-D6 shape otherwise)', async () => {
  const svc = service();
  const result = await svc.mutate({ command_id: 'c8', actor_id: '1', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2 } } });
  const ack = renderOwnerAck('SUBMIT_TASK', result, 'live1-local');
  assert.equal(/Debate:/.test(ack), false);
  assert.equal(/Implementation participant:/.test(ack), false);
});

// ---- human-readable error rendering (Part C2) ----------------------------

test('renderFlagsInvalid and renderOwnerError never leak internal JSON', () => {
  assert.equal(renderFlagsInvalid('--pm requires a value'), '❌ Command rejected: --pm requires a value');
  const err = new OwnerControlError('unknown participant profile: ghost', 'COUNCIL_UNKNOWN_PARTICIPANT', { profileId: 'ghost' });
  const rendered = renderOwnerError(err);
  assert.equal(rendered, '❌ unknown participant profile: ghost');
  assert.equal(rendered.includes('{'), false);
});
