import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { buildChairPlanJsonSchema } from '../src/pm/council/council-chair-plan-schema.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };
const PARTICIPANTS = ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'];

function chairPlanSpec(overrides = {}) {
  return { id: 'council:chair_plan:0', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'live1-claude-pm', prompt: 'PLAN', participantProfileIds: PARTICIPANTS, ...overrides };
}

const VALID_PLAN = { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: Object.fromEntries(PARTICIPANTS.map((id) => [id, `focus ${id}`])), critique_focus: 'a', synthesis_focus: 'b' } };

test('S1/T: chair_plan + claude-code requests native structured output with the exact dynamic schema, and DSH validation still runs end-to-end', async () => {
  let capturedJsonSchema;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async ({ jsonSchema }) => { capturedJsonSchema = jsonSchema; return { result: JSON.stringify(VALID_PLAN), structuredOutput: VALID_PLAN }; },
  });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: (profile, ctx) => registry.resolve(profile, ctx),
    profileRegistry: { get: () => ({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS', model: 'sonnet', reasoning: 'high' }) },
    project: PROJECT,
  });
  const outcome = await runner.run(chairPlanSpec());
  assert.deepEqual(capturedJsonSchema, buildChairPlanJsonSchema(PARTICIPANTS), 'exact dynamic schema reached the CLI runner');
  assert.equal(outcome.finalResult.handoff.ok, true, 'canonical DSH parseDecision/normalizePmDecision/validateStepData all still ran and accepted it');
  assert.equal(outcome.finalResult.handoff.structured_output.requested, true);
  assert.equal(outcome.finalResult.handoff.structured_output.present, true);
});

test('T1 regression: the OLD free-form-JSON-malformed condition, reproduced with structured output enabled, is bypassed -- the structured object is consumed instead', async () => {
  // Simulates the historical failure shape (task-D5PT4CbNpjeUamnegQDN6kvM34w3NMdo):
  // Claude's free-form `result` string is malformed JSON (a stray trailing
  // brace), but the NATIVE structured_output field is present and valid --
  // proving DSH now consumes the schema-validated object rather than the
  // unreliable free-form string.
  const malformedResult = `${JSON.stringify(VALID_PLAN)}}`; // stray trailing brace, exactly like the historical failure class
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async () => ({ result: malformedResult, structuredOutput: VALID_PLAN }),
  });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: (profile, ctx) => registry.resolve(profile, ctx),
    profileRegistry: { get: () => ({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
  });
  const outcome = await runner.run(chairPlanSpec());
  assert.equal(outcome.finalResult.handoff.ok, true, 'structured_output was consumed -- the malformed free-form result never reached parseDecision()');
  assert.deepEqual(outcome.finalResult.handoff.participant_instructions, VALID_PLAN.data.participant_instructions);
});

test('S2: participant_report + claude-code is unaffected -- no structured output requested (chair_plan only, Part L)', async () => {
  let sawJsonSchema = 'UNSET';
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async ({ jsonSchema }) => { sawJsonSchema = jsonSchema; return { result: JSON.stringify({ type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } }) }; },
  });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: (profile, ctx) => registry.resolve(profile, ctx),
    profileRegistry: { get: () => ({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
  });
  const spec = { id: 'council:participant_report:1', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'live1-claude-pm', prompt: 'REPORT', participantProfileIds: PARTICIPANTS };
  const outcome = await runner.run(spec);
  assert.equal(sawJsonSchema, undefined, 'jsonSchema was never requested for participant_report, even with a claude-code profile');
  assert.equal(outcome.finalResult.handoff.ok, true);
});

test('S3: chair_synthesis + claude-code is unaffected -- no structured output requested', async () => {
  let sawJsonSchema = 'UNSET';
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async ({ jsonSchema }) => { sawJsonSchema = jsonSchema; return { result: JSON.stringify({ type: 'finish', output: 'the synthesis', data: { type: 'council_synthesis' } }) }; },
  });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: (profile, ctx) => registry.resolve(profile, ctx),
    profileRegistry: { get: () => ({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
  });
  const spec = { id: 'council:chair_synthesis:2', kind: 'council_step', stepKind: 'chair_synthesis', round: 2, profileId: 'live1-claude-pm', prompt: 'SYNTH', participantProfileIds: PARTICIPANTS };
  const outcome = await runner.run(spec);
  assert.equal(sawJsonSchema, undefined);
  assert.equal(outcome.finalResult.handoff.ok, true);
});

test('S4: an ordinary single-PM Claude decide() call (no council step at all) is completely unaffected', async () => {
  let sawArgs;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (opts) => { sawArgs = opts; return { result: JSON.stringify({ type: 'finish', output: 'ok' }) }; },
  });
  const profile = { id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const decision = await registry.resolve(profile, { project: PROJECT }).decide({ turn: 0, request: { id: 'r1', objective: 'do the thing' }, history: [] });
  assert.equal(sawArgs.jsonSchema, undefined, 'jsonSchema is undefined for an ordinary single-PM call -- no --json-schema flag is ever added (runClaudeProcess only adds it on a truthy value)');
  assert.deepEqual(decision, { type: 'finish', output: 'ok' });
});

test('S5: Codex is unaffected by the structuredOutputSchema plumbing (createCliPmDriver passes it through generically; codex ignores it)', async () => {
  const codexJson = (text) => [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n');
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex', codexRunner: async () => summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"codex ok"}') }) });
  const profile = { id: 'live1-codex-pm', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  const decision = await registry.resolve(profile, { project: PROJECT }).decide({ turn: 0, request: { id: 'r1', objective: 'x' }, history: [] });
  assert.deepEqual(decision, { type: 'finish', output: 'codex ok' });
});
