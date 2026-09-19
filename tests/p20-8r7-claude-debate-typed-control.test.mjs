/**
 * P20.8R7 §4 — Claude same-execution Debate typed-control channel.
 *
 * Authority: docs/P20/P20_8R7_DEBATE_PHASE1_FUNCTIONAL_READINESS_MASTER_PROMPT.md
 *
 * Proves `createClaudeReportBackend()` (src/pm/report-backends/
 * cli-report-backends.mjs) implements the smallest real same-execution
 * Debate typed-control channel: report.md remains the sole report
 * authority (written by the model itself, DIRECT_WRITE); `continue_debate`
 * comes from a SEPARATE, strict, versioned machine-control envelope in the
 * SAME execution's final assistant response — never inferred from report
 * bytes. Missing/malformed/duplicated envelopes fail closed BEFORE
 * delivery. Non-synthesis Claude DIRECT_WRITE stages (Council chair-plan/
 * participant-report, Debate brief/response, SINGLE) are completely
 * unaffected. OpenCode/Antigravity never gain this capability.
 *
 * Offline only. No real CLI process is ever spawned — a fake `spawnImpl`
 * simulates the real `claude` CLI's stdin/stdout contract exactly as
 * claude-code-session-bridge.mjs's `runClaudeProcess()` uses it (prompt
 * via `stdin.end(prompt)`, JSON envelope `{"result": "..."}` via stdout),
 * and independently parses the assigned report path out of the REAL
 * trusted-prompt text (report-prompt.mjs's own line format) rather than
 * being told it out of band — the same way a genuine Claude CLI would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createClaudeReportBackend, createOpenCodeReportBackend, createAntigravityReportBackend } from '../src/pm/report-backends/cli-report-backends.mjs';
import { resolveDebateTypedControlStatus, assertDebateTypedControlAdmitted } from '../src/pm/council/debate-backend-capability.mjs';
import { runDebateArtifactStage, runCouncilArtifactStage } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { buildReportBackendResult, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-12T00:00:00Z';
const ASSIGNED_PATH_LINE_RE = /assigned_report_path \(write ONLY this exact file\): (.+)/;

function policyProving(product) {
  return {
    enforcement_version: 'test-p20-8r7-1',
    backends: {
      [product]: {
        report_delivery: { DIRECT_WRITE: CAPABILITY_STATE.PROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNSUPPORTED },
        artifact_input: { VERBATIM_CONTENT: CAPABILITY_STATE.PROVEN, NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNSUPPORTED },
      },
    },
  };
}

/**
 * A fake `claude` CLI process: parses the assigned path out of the REAL
 * trusted prompt (sent via `stdin.end(prompt)`, exactly like
 * claude-code-session-bridge.mjs's real bridge), optionally writes
 * `reportText` there (simulating the model's own Write tool use), then
 * resolves with the exact `--output-format json` envelope shape
 * (`{"result": <finalAssistantText>}`) `runClaudeProcess()` parses.
 */
function fakeClaudeSpawn({ reportText = null, finalAssistantText = '', exitCode = 0 } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.pid = 4242;
    proc.stdout = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter();
    proc.stderr.setEncoding = () => {};
    proc.stdin = new EventEmitter();
    proc.stdin.write = () => true;
    let capturedPrompt = '';
    proc.stdin.end = (chunk) => { capturedPrompt = typeof chunk === 'string' ? chunk : ''; };
    queueMicrotask(() => {
      if (reportText !== null) {
        const m = ASSIGNED_PATH_LINE_RE.exec(capturedPrompt);
        const assignedPath = m ? m[1].trim() : null;
        assert.ok(assignedPath, 'fake spawn could not find assigned_report_path in the real trusted prompt — report-prompt.mjs format may have changed');
        mkdirSync(dirname(assignedPath), { recursive: true });
        writeFileSync(assignedPath, reportText);
      }
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: finalAssistantText })));
      proc.emit('close', exitCode, null);
    });
    return proc;
  };
}

async function sealDebateBrief(store, task) {
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
    spawnImpl: fakeClaudeSpawn({ reportText: '# Debate Brief\n\nSet up the round.\n', finalAssistantText: 'ok' }),
  });
  const outcome = await runDebateArtifactStage({
    store, task, taskId: task.taskId, createdAt: CREATED, round: 1, maxRounds: 2,
    artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
    reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
    instructions: 'brief it',
  });
  assert.equal(outcome.ok, true, `brief must seal to set up this test, got ${JSON.stringify(outcome)}`);
  return outcome;
}

// ---- §7/§8 — writes report.md AND separately returns valid typed control, from the SAME execution, never inferred from report text ----

test('§7/§8 — Claude DIRECT_WRITE Debate synthesis writes report.md itself AND separately returns valid typed control from the same execution; the report carries no control marker', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-synth-ok', taskSlug: 'r7-synth-ok', createdAt: CREATED, mode: 'council' });
    const brief = await sealDebateBrief(store, task);

    const synthesisReportText = '# Debate Synthesis\n\nA purely narrative synthesis with no machine-readable marker anywhere in it.\n';
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: synthesisReportText, finalAssistantText: 'DSH_DEBATE_CONTROL_V1:{"continue_debate":true}' }),
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-synth-ok', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
    assert.ok(outcome.sealed_ref, 'a real sealed reference must exist');
    assert.ok(outcome.typed_control, 'a typed_control record must be attached');
    assert.equal(outcome.typed_control.continue_debate, true);
    // Same-execution identity binding.
    assert.equal(outcome.typed_control.task_id, 'task-r7-synth-ok');
    assert.equal(outcome.typed_control.round, 1);
    assert.equal(outcome.typed_control.stage, ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS);
    // The report authority is the FILE — independently read it back and
    // confirm it is EXACTLY the narrative text, with NO control marker
    // anywhere — proving the control was never inferred from report bytes.
    const onDisk = readFileSync(join(store.root, outcome.sealed_ref.artifact_relpath), 'utf8');
    assert.equal(onDisk, synthesisReportText);
    assert.doesNotMatch(onDisk, /DSH_DEBATE_CONTROL_V1/, 'the control envelope must never appear inside report.md');
  });
});

// ---- §9 — missing / malformed / duplicated envelopes fail closed, BEFORE delivery ----

test('§9 — a missing typed-control envelope fails closed before delivery (report never sealed)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-missing', taskSlug: 'r7-missing', createdAt: CREATED, mode: 'council' });
    const brief = await sealDebateBrief(store, task);
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Synthesis\n\nno control envelope here\n', finalAssistantText: 'just some ordinary closing remark, no envelope' }),
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-missing', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false, 'must fail closed, never optimistically succeed');
    assert.equal(outcome.sealed_ref, null);
  });
});

test('§9 — a duplicated typed-control envelope fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-dup', taskSlug: 'r7-dup', createdAt: CREATED, mode: 'council' });
    const brief = await sealDebateBrief(store, task);
    const envelope = 'DSH_DEBATE_CONTROL_V1:{"continue_debate":false}';
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Synthesis\n\nbody\n', finalAssistantText: `${envelope}\n${envelope}` }),
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-dup', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.sealed_ref, null);
  });
});

test('§9 — a malformed (non-JSON) typed-control payload fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-malformed', taskSlug: 'r7-malformed', createdAt: CREATED, mode: 'council' });
    const brief = await sealDebateBrief(store, task);
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Synthesis\n\nbody\n', finalAssistantText: 'DSH_DEBATE_CONTROL_V1:{not valid json at all' }),
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-malformed', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.sealed_ref, null);
  });
});

test('§9 — a non-boolean continue_debate value fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-nonbool', taskSlug: 'r7-nonbool', createdAt: CREATED, mode: 'council' });
    const brief = await sealDebateBrief(store, task);
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Synthesis\n\nbody\n', finalAssistantText: 'DSH_DEBATE_CONTROL_V1:{"continue_debate":"true"}' }),
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-nonbool', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false, 'a string "true" is not a boolean and must fail closed');
    assert.equal(outcome.sealed_ref, null);
  });
});

// ---- §10 — ordinary Claude Council/SINGLE DIRECT_WRITE stages are unaffected ----

test('§10 — ordinary Claude Council chair-plan DIRECT_WRITE succeeds normally with no control envelope required', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-council', taskSlug: 'r7-council', createdAt: CREATED, mode: 'council' });
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Chair Plan\n\nplan body\n', finalAssistantText: 'no envelope, ordinary closing text' }),
    });
    const outcome = await runCouncilArtifactStage({
      store, task, taskId: 'task-r7-council', createdAt: CREATED,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: backend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'plan it',
    });
    assert.equal(outcome.ok, true, `Council chair-plan must be entirely unaffected by the Debate-only control gate, got ${JSON.stringify(outcome)}`);
  });
});

test('§10 — ordinary Claude SINGLE DIRECT_WRITE succeeds normally with no control envelope required', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Single Report\n\nbody\n', finalAssistantText: 'no envelope, ordinary closing text' }),
    });
    const out = await runSingleReport({
      store, taskId: 'task-r7-single', taskSlug: 'r7-single', createdAt: CREATED,
      invocationId: 'inv-r7-single', executionId: 'exec-r7-single',
      profileId: 'live1-claude-sonnet-low', backend: 'claude-code', actorAlias: 'claude-sonnet-low',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter,
      deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: policyProving('claude-code'), complete: true,
    });
    assert.ok(out.completion?.finalRef, 'SINGLE DIRECT_WRITE must be entirely unaffected by the Debate-only control gate');
  });
});

// ---- §11 — Debate typed-control admission is per-instance, DIRECT_WRITE-route-scoped ----
//
// P22.4 §F extended this exact same-execution strict-envelope mechanism
// from Claude-only to OpenCode/Antigravity (and, in cli-report-backends.mjs,
// Codex/Grok) — see docs/P22/P22_4_COMPLETE_SIX_BACKEND_P20_P21_MIGRATION_AND_FINAL_AUDIT.md.
// This test now proves the CURRENT, wider truth: any backend constructed
// with `deliveryMechanism: 'DIRECT_WRITE'` is admitted; VERBATIM_MATERIALIZATION
// never is, regardless of product.

test('§11 — OpenCode/Antigravity DIRECT_WRITE report backends are now Debate-typed-control-capable (P22.4); VERBATIM_MATERIALIZATION never is', () => {
  const opencodeDirectWrite = createOpenCodeReportBackend({ binary: 'fake-opencode', cwd: '/repo', model: 'x', deliveryMechanism: 'DIRECT_WRITE' });
  const antigravityDirectWrite = createAntigravityReportBackend({ binary: 'fake-agy', cwd: '/repo', model: 'x', deliveryMechanism: 'DIRECT_WRITE' });
  assert.equal(resolveDebateTypedControlStatus(opencodeDirectWrite), 'PROVEN');
  assert.equal(resolveDebateTypedControlStatus(antigravityDirectWrite), 'PROVEN');
  assert.doesNotThrow(() => assertDebateTypedControlAdmitted(opencodeDirectWrite, { profileId: 'x', role: 'chair' }));
  assert.doesNotThrow(() => assertDebateTypedControlAdmitted(antigravityDirectWrite, { profileId: 'x', role: 'chair' }));

  const opencodeMaterialization = createOpenCodeReportBackend({ binary: 'fake-opencode', cwd: '/repo', model: 'x' });
  const antigravityMaterialization = createAntigravityReportBackend({ binary: 'fake-agy', cwd: '/repo', model: 'x' });
  assert.equal(resolveDebateTypedControlStatus(opencodeMaterialization), 'UNPROVEN');
  assert.equal(resolveDebateTypedControlStatus(antigravityMaterialization), 'UNPROVEN');
  assert.throws(() => assertDebateTypedControlAdmitted(opencodeMaterialization, { profileId: 'x', role: 'member' }), (e) => e.code === 'DEBATE_TYPED_CONTROL_UNSUPPORTED');
  assert.throws(() => assertDebateTypedControlAdmitted(antigravityMaterialization, { profileId: 'x', role: 'member' }), (e) => e.code === 'DEBATE_TYPED_CONTROL_UNSUPPORTED');

  const claudeDirectWrite = createClaudeReportBackend({ deliveryMechanism: 'DIRECT_WRITE' });
  const claudeMaterialization = createClaudeReportBackend({ deliveryMechanism: 'VERBATIM_MATERIALIZATION' });
  assert.equal(resolveDebateTypedControlStatus(claudeDirectWrite), 'PROVEN');
  assert.equal(resolveDebateTypedControlStatus(claudeMaterialization), 'UNPROVEN', 'typed control is DIRECT_WRITE-route-scoped only, never blanket-PROVEN for the whole product');
});

test('§11 — Debate member-response and chair-brief never call assertDebateTypedControlAdmitted, even for a backend with no typed-control support', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r7-member', taskSlug: 'r7-member', createdAt: CREATED, mode: 'council' });
    const briefBackend = createClaudeReportBackend({
      binary: 'fake-claude', cwd: '/repo', model: 'sonnet', deliveryMechanism: 'DIRECT_WRITE',
      spawnImpl: fakeClaudeSpawn({ reportText: '# Brief\n\nbody\n', finalAssistantText: 'ok' }),
    });
    const brief = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-member', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-claude-sonnet-low', actorAlias: 'chair', backend: 'claude-code',
      reportBackend: briefBackend, capabilityPolicy: policyProving('claude-code'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'brief it',
    });
    assert.equal(brief.ok, true);

    const memberBackend = createOpenCodeReportBackend({ binary: 'fake-opencode', cwd: '/repo', model: 'x', deliveryMechanism: 'DIRECT_WRITE' });
    // P22.4 §F: OpenCode DIRECT_WRITE now DOES carry this flag (see the §11
    // test above) — explicitly override it here so this test still proves
    // its real invariant: a member/brief stage never even CALLS
    // assertDebateTypedControlAdmitted, independent of whether the backend
    // instance actually supports it.
    memberBackend.supportsDebateTypedControl = false;
    // A real spawnImpl isn't even needed here beyond proving admission is
    // never checked — but runDebateArtifactStage() will still try to spawn,
    // so give it a minimal fake that writes the assigned file.
    memberBackend.runReport = async ({ request }) => {
      mkdirSync(dirname(request.attempt.reportPath), { recursive: true });
      writeFileSync(request.attempt.reportPath, 'member response body\n');
      return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true } });
    };
    const response = await runDebateArtifactStage({
      store, task, taskId: 'task-r7-member', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'live1-opencode-opencode-go-deepseek-v4-flash', actorAlias: 'opencode-member', backend: 'opencode',
      reportBackend: memberBackend, capabilityPolicy: policyProving('opencode'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'respond', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(response.ok, true, `a Debate member response must succeed without any typed-control capability, got ${JSON.stringify(response)}`);
  });
});
