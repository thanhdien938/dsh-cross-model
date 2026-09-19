import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';

const project = { id: 'p', repo_path: process.cwd() };
const apiProfile = { id: 'api-member', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'fixture-model', status: 'ACTIVE' };
const brokenApiProfile = { ...apiProfile, id: 'broken-api-member', provider: 'broken' };
const codexProfile = { id: 'codex-member', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'fixture', status: 'ACTIVE' };

const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');

function registryFor(profiles) {
  return { get(id) { const profile = profiles.find((p) => p.id === id); if (!profile) throw new Error(`unknown ${id}`); return profile; } };
}

test('R3: a production API profile executes the unchanged council report and critique contracts through the generic resolver', async () => {
  const calls = [];
  const backend = new ProductionPmBackendRegistry({
    probe: () => true,
    apiRunner: async ({ providerId, model, prompt }) => {
      calls.push({ providerId, model, prompt });
      if (prompt.includes('council_critique')) return '{"type":"finish","output":"api critique","data":{"type":"council_critique","criticisms":[],"agreements":["shared contract"],"revised_recommendation":"keep shared path","remaining_disagreements":[]}}';
      return '{"type":"finish","output":"api report","data":{"type":"council_report","analysis":"shared analysis","recommendation":"shared path","risks":[],"uncertainties":[]}}';
    },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: (profile, ctx) => backend.resolve(profile, ctx), profileRegistry: registryFor([apiProfile]), project });
  const report = await runner.run({ id: 'r3-report', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: apiProfile.id, prompt: 'Return council_report', participantProfileIds: [apiProfile.id] });
  const critique = await runner.run({ id: 'r3-critique', kind: 'council_step', stepKind: 'participant_critique', round: 2, profileId: apiProfile.id, prompt: 'Return council_critique', participantProfileIds: [apiProfile.id] });

  assert.equal(report.finalResult.handoff.ok, true);
  assert.equal(report.finalResult.handoff.type, 'council_report');
  assert.equal(critique.finalResult.handoff.ok, true);
  assert.equal(critique.finalResult.handoff.type, 'council_critique');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.providerId === 'openrouter' && c.model === 'fixture-model'));
});

test('R3: missing-secret API failure is typed, sends no HTTP, and the next CLI participant still executes on the same shared runner', async () => {
  let httpCalls = 0;
  let codexCalls = 0;
  const providers = {
    broken: validateProviderEntry('broken', { protocol: 'openai-chat', base_url: 'https://example.invalid/v1', api_key_env: 'DSH_API_R3_BROKEN_KEY' }),
  };
  const backend = new ProductionPmBackendRegistry({
    probe: () => true,
    apiProviders: providers,
    apiEnv: {},
    apiFetch: async () => { httpCalls += 1; throw new Error('must not send'); },
    codexBinary: 'codex-fixture',
    codexRunner: async () => {
      codexCalls += 1;
      return summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"codex report","data":{"type":"council_report","analysis":"survived","recommendation":"continue","risks":[],"uncertainties":[]}}') });
    },
  });
  const profiles = [brokenApiProfile, codexProfile];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: (profile, ctx) => backend.resolve(profile, ctx), profileRegistry: registryFor(profiles), project });
  const failed = await runner.run({ id: 'broken-report', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: brokenApiProfile.id, prompt: 'report', participantProfileIds: profiles.map((p) => p.id) });
  const survived = await runner.run({ id: 'codex-report', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: codexProfile.id, prompt: 'report', participantProfileIds: profiles.map((p) => p.id) });

  assert.equal(failed.finalResult.handoff.ok, false);
  assert.equal(failed.finalResult.handoff.reason, 'API_SECRET_MISSING');
  assert.equal(httpCalls, 0);
  assert.equal(survived.finalResult.handoff.ok, true);
  assert.equal(codexCalls, 1);
});

test('R3 structural guard: API uses the same CouncilStepWorkflowRunner; no API/provider-specific council service exists', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/pm/council/council-step-workflow-runner.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /ApiCouncilService|OpenRouterCouncilParticipant|XcodeCouncilParticipant|ApiCouncilFailurePolicy/);
  assert.doesNotMatch(source, /profile\.product\s*===\s*['"]api['"]/);
});
