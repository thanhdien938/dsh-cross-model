/**
 * P20.2 §9.2 / §10 / §11 / §23 — the `api` report transport is the one
 * backend whose exact accepted visible bytes + finish_reason can be proven
 * offline (HTTP fixture, no live model call).
 * Tests D (finish_reason preserved), F (exact visible content), E (hidden
 * reasoning / tool JSON excluded — only choice.message.content is used),
 * T (length finish is NOT complete success), N (verbatim into materialisation).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runApiReportRequest, createApiReportBackend } from '../src/pm/api-backend/api-report-transport.mjs';
import { TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { withTempRoot, makeStore, fakeChatFetch, chatBody, FAKE_PROVIDERS, FAKE_ENV } from './fixtures/p20-report-helpers.mjs';

const CALL = (over = {}) => ({
  providerId: 'testprov', model: 'gpt-x', prompt: 'write the report',
  profileId: 'live1-api', executionId: 'exec-api-1',
  providers: FAKE_PROVIDERS, env: FAKE_ENV,
  ...over,
});

test('F: accepted_visible_text is choice.message.content VERBATIM (no trim/normalise)', async () => {
  const content = '\r\n  # Report with CRLF + leading spaces\r\n\r\n​zero-width​ and 🚀\r\n{"a":1}\n{"b":2}\r\n   ';
  const res = await runApiReportRequest(CALL({ fetchImpl: fakeChatFetch({ body: chatBody({ content, finishReason: 'stop' }) }) }));
  assert.equal(res.terminal_state, TERMINAL_STATE.SUCCESS);
  assert.equal(res.accepted_visible_text, content, 'byte-for-byte identical to provider content');
  assert.equal(res.accepted_visible_bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(res.visible_output_source, 'API_CHAT_CONTENT');
});

test('D: provider finish_reason is preserved on the report result', async () => {
  for (const [fr, expected] of [['stop', TERMINAL_STATE.SUCCESS], ['end_turn', TERMINAL_STATE.SUCCESS]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runApiReportRequest(CALL({ fetchImpl: fakeChatFetch({ body: chatBody({ content: 'body', finishReason: fr }) }) }));
    assert.equal(res.provider_finish_reason, fr);
    assert.equal(res.terminal_state, expected);
  }
});

test('T: a length / max_tokens finish_reason is TRUNCATED_OR_INCOMPLETE, never a complete report success', async () => {
  for (const fr of ['length', 'max_tokens']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runApiReportRequest(CALL({ fetchImpl: fakeChatFetch({ body: chatBody({ content: 'partial...', finishReason: fr }) }) }));
    assert.equal(res.terminal_state, TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE);
    assert.equal(res.provider_finish_reason, fr);
  }
});

test('E: only choice.message.content is used — sibling reasoning / tool_calls fields never reach the report bytes', async () => {
  const body = {
    id: 'cmpl-x',
    model: 'gpt-x',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'THE VISIBLE REPORT BODY',
        // provider-specific extras that MUST be ignored:
        reasoning: 'hidden chain of thought that must never appear',
        reasoning_content: 'more hidden thinking',
        tool_calls: [{ id: 't1', function: { name: 'run', arguments: '{"cmd":"secret"}' } }],
      },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
  const res = await runApiReportRequest(CALL({ fetchImpl: fakeChatFetch({ body }) }));
  assert.equal(res.accepted_visible_text, 'THE VISIBLE REPORT BODY');
  assert.doesNotMatch(res.accepted_visible_text, /hidden|chain of thought|secret|tool_calls/i);
});

test('a provider HTTP error / network failure yields a non-success terminal state, never a fake report', async () => {
  const errRes = await runApiReportRequest(CALL({ fetchImpl: fakeChatFetch({ status: 500, body: { error: 'boom' } }) }));
  assert.notEqual(errRes.terminal_state, TERMINAL_STATE.SUCCESS);
  assert.equal(errRes.accepted_visible_text, null);
});

test('N: the api report result feeds VERBATIM_MATERIALIZATION byte-exact through the SINGLE flow', async () => {
  await withTempRoot(async (dir) => {
    const content = '# API report\r\nline\n  spaced  \n🚀';
    const backend = createApiReportBackend({ providerId: 'testprov', model: 'gpt-x', providers: FAKE_PROVIDERS, env: FAKE_ENV, fetchImpl: fakeChatFetch({ body: chatBody({ content, finishReason: 'stop' }) }) });
    const out = await runSingleReport({
      store: makeStore(dir), taskId: 'task-APISINGLE', taskSlug: 'api single', createdAt: '2026-09-10T09:00:00Z',
      invocationId: 'inv-api-1', executionId: 'exec-api-1', profileId: 'live1-api', backend: 'api', actorAlias: 'api',
      instructions: 'go', reportBackend: backend, startedAt: '2026-09-10T09:00:00Z',
    });
    assert.equal(readFileSync(out.delivery.reportPath, 'utf8'), content);
    const meta = JSON.parse(readFileSync(out.attempt.artifactJsonPath, 'utf8'));
    assert.equal(meta.provider_finish_reason, 'stop');
    assert.equal(meta.report_bytes, Buffer.byteLength(content, 'utf8'));
    assert.match(out.delivery.reportPath.replace(/\\/g, '/'), /\/single\/api\/inv-api-1\/attempt-00\/20260910_090000__api__single__report\.md$/);
  });
});
