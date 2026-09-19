import test from 'node:test';
import assert from 'node:assert/strict';
import { childPrompt } from '../scripts/lib/conn-smoke.mjs';

test('childPrompt is deterministic, read-only, and names product + tool', () => {
  const p = childPrompt('Grok Build', 'subagent_grok');
  assert.match(p, /Grok Build/);
  assert.match(p, /subagent_grok/);
  assert.match(p, /Do not modify any files\./);
  assert.equal(p, childPrompt('Grok Build', 'subagent_grok'));
});

test('childPrompt never assigns a permanent role to a backend', () => {
  for (const product of ['Codex', 'Claude Code', 'Grok Build']) {
    const p = childPrompt(product, `subagent_${product.toLowerCase().replaceAll(' ', '_')}`);
    assert.doesNotMatch(p, /coder|reviewer|judge|PM|orchestrator/i);
    assert.doesNotMatch(p, /as (?:the|our) (?:coder|reviewer|judge)/i);
  }
});