import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAliasesHelp } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';

// P19-D6 (D6-C): Telegram Debate discoverability. `/aliases` is this
// project's only owner-facing "help/examples" surface (P8-R0 Part J); these
// tests prove it now demonstrates every required Debate shape, and that the
// pre-existing `--debate <participants>` (P7, Council member selection) vs
// `--debate-extend` (P19, the actual Debate extension) distinction is
// spelled out in prose, not just implied by flag names.

const projects = [{ id: 'dsh-p6-test-b', display_name: 'DSH P6 Test B' }];
const pmProfiles = [
  { id: 'live1-claude-pm', product: 'claude-code', model: 'sonnet', reasoning: 'high' },
  { id: 'live1-codex-pm', product: 'codex', model: 'gpt-5', reasoning: 'medium' },
  { id: 'live1-grok-pm', product: 'grok', model: 'grok-4.5', reasoning: null },
];
function registry() { return new TelegramAliasRegistry({ projects: { 1: 'dsh-p6-test-b' }, pmProfiles: { 1: 'live1-claude-pm', 2: 'live1-codex-pm', 3: 'live1-grok-pm' } }); }

test('/aliases shows an analysis-only Council example', () => {
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: registry() });
  assert.match(text, /Analysis-only Council:\n@dsh-p6-test-b --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm/);
});

test('/aliases shows a Council + Debate example using --debate-extend', () => {
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: registry() });
  assert.match(text, /Council \+ Debate:\n@dsh-p6-test-b --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm --debate-extend --debate-rounds 2/);
});

test('/aliases shows a Council + Debate + implementation participant example', () => {
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: registry() });
  assert.match(text, /Council \+ Debate \+ implementation participant:\n@dsh-p6-test-b --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm --debate-extend --implementation live1-codex-pm/);
});

test('/aliases shows a durable-local + commit example and a distinct explicit no-push (durable remote, no --push) example', () => {
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: registry() });
  assert.match(text, /Durable local \+ commit[^:]*:\n@dsh-p6-test-b --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm --debate-extend --durability local --commit/);
  assert.match(text, /Explicit no-push[^:]*:\n@dsh-p6-test-b --pm live1-claude-pm --debate live1-codex-pm,live1-grok-pm --debate-extend --durability remote --commit/);
});

test('/aliases explains --debate (P7, Council member selection) vs --debate-extend (P19, the Debate extension) in prose', () => {
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: registry() });
  assert.match(text, /"--debate <participants>" selects Council members/);
  assert.match(text, /"--debate-extend" turns on the separate P19 Debate extension/);
  assert.match(text, /"--implementation <profile_id>" names the ONE participant/);
});

test('/aliases omits the Debate examples block cleanly when fewer than two PM profiles are registered (no broken partial example)', () => {
  const oneProfileRegistry = new TelegramAliasRegistry({ projects: { 1: 'dsh-p6-test-b' }, pmProfiles: { 1: 'live1-claude-pm' } });
  const text = renderAliasesHelp({ projects, profiles: [pmProfiles[0]], aliasRegistry: oneProfileRegistry });
  assert.equal(text.includes('Debate examples'), false);
});

test('/aliases Debate examples never appear when no aliases are configured at all', () => {
  const empty = new TelegramAliasRegistry();
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: empty });
  assert.match(text, /No aliases are configured yet/);
  assert.equal(text.includes('Debate examples'), false);
});
