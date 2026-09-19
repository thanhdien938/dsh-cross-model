import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';

const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
].join('\n');

// P7 Part W: councilId/phase/round/role correlation fields must reach the
// SAME BackendExecutionObserver every single-PM CLI call already reports
// through — this is the only observability integration surface council
// needs; no new capability, no new event stream.
test('council correlation fields (councilId/phase/round/role) reach the backend execution observer', async () => {
  const events = [];
  const observer = {
    start(ctx) { events.push(['start', ctx]); },
    parser(ctx, extra) { events.push(['parser', ctx, extra]); },
    terminal(ctx, extra) { events.push(['terminal', ctx, extra]); },
  };
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    codexBinary: 'codex',
    observer,
    codexRunner: async () => summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"codex report"}') }),
  });
  const profile = { id: 'live1-codex-pm', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  const extraCtx = { councilId: 'pmrun_council_1', phase: 'participant_report', round: 1, role: 'participant' };
  await registry.resolve(profile, { project: { repo_path: 'C:/proj' }, extraCtx }).decide({ turn: 0, request: {}, history: [] });

  assert.ok(events.length >= 2);
  for (const [, ctx] of events) {
    assert.equal(ctx.councilId, 'pmrun_council_1');
    assert.equal(ctx.phase, 'participant_report');
    assert.equal(ctx.round, 1);
    assert.equal(ctx.role, 'participant');
    // council correlation is additive — real identity fields are never overridden.
    assert.equal(ctx.backendProduct, 'codex');
    assert.equal(ctx.profileId, 'live1-codex-pm');
    assert.equal(ctx.cwd, 'C:/proj');
  }
});

test('single-PM calls (no extraCtx) are completely unaffected — no council fields leak in', async () => {
  const events = [];
  const observer = { start(ctx) { events.push(ctx); }, parser() {}, terminal() {} };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex', observer, codexRunner: async () => summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"ok"}') }) });
  const profile = { id: 'live1-codex-pm', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  await registry.resolve(profile, { project: { repo_path: 'C:/proj' } }).decide({ turn: 0, request: {}, history: [] });
  assert.equal('councilId' in events[0], false);
  assert.equal('phase' in events[0], false);
});
