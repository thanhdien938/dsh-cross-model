import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bound, boundList, redactSecrets, buildSingleTaskMarkdown, buildSinglePmMarkdown, buildSinglePlanMarkdown,
  buildSingleWalkthroughMarkdown, buildExecutionLogMarkdown, buildCouncilTaskMarkdown, buildChairPmMarkdown,
  buildChairPlanMarkdown, buildChairSynthesisMarkdown, buildMemberReportMarkdown, buildMemberCritiqueMarkdown,
  buildMemberFailureMarkdown, buildCouncilWalkthroughMarkdown, buildProgressLine, nativeSessionReuseLabel,
} from '../src/runtime/repo-history-content.mjs';

test('bound() truncates with an explicit, documented marker rather than silently clipping', () => {
  const text = 'x'.repeat(50);
  const out = bound(text, 10, 'test field');
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.match(out, /\[TRUNCATED — canonical full result remains available in DSH durable state; test field exceeded 10 chars\]/);
});

test('bound() leaves short text untouched', () => {
  assert.equal(bound('short', 100, 'x'), 'short');
});

test('redactSecrets removes secret-shaped tokens but preserves normal prose', () => {
  const text = 'here is a token sk-abcdefgh12345678 and normal text';
  const out = redactSecrets(text);
  assert.doesNotMatch(out, /sk-abcdefgh12345678/);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /normal text/);
});

test('boundList caps item count and marks the omission truthfully', () => {
  const items = Array.from({ length: 60 }, (_, i) => `item ${i}`);
  const out = boundList(items, { maxItems: 5, label: 'risk' });
  assert.equal(out.length, 6);
  assert.match(out[5], /TRUNCATED — 55 more risk item\(s\) omitted/);
});

test('nativeSessionReuseLabel never fabricates PROVEN — only passes through real evidence', () => {
  assert.equal(nativeSessionReuseLabel('PROVEN'), 'PROVEN');
  assert.equal(nativeSessionReuseLabel('NOT PROVEN'), 'NOT PROVEN');
  assert.equal(nativeSessionReuseLabel(undefined), 'UNKNOWN');
  assert.equal(nativeSessionReuseLabel('made up'), 'UNKNOWN');
});

test('buildSingleTaskMarkdown preserves full canonical task_id/pm_run_id and bounded owner text', () => {
  const md = buildSingleTaskMarkdown({
    taskId: 'task-abc123', pmRunId: 'pmrun-abc123', projectId: 'proj-x', submittedVia: 'TELEGRAM', commandId: 'cmd-1',
    createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:05:00Z', ownerTaskText: 'Do the thing', pmProfileId: 'pm-1', status: 'completed',
  });
  assert.match(md, /task-abc123/);
  assert.match(md, /pmrun-abc123/);
  assert.match(md, /pm-1/);
  assert.match(md, /Do the thing/);
  assert.match(md, /completed/);
});

test('buildSinglePmMarkdown never fabricates a native session id', () => {
  const md = buildSinglePmMarkdown({ profileId: 'pm-1', profile: { product: 'claude-code', model: 'sonnet', reasoning: 'high', session_kind: 'STATELESS' } });
  assert.match(md, /NOT EXPOSED/);
  assert.match(md, /UNKNOWN/); // native session reuse
});

test('buildSinglePlanMarkdown states plainly when the result is not semantically a plan', () => {
  const md = buildSinglePlanMarkdown({ isPlan: false, output: 'did the thing', data: { type: 'other' } });
  assert.match(md, /not semantically a "plan"/);
  assert.match(md, /did the thing/);
});

test('buildCouncilTaskMarkdown lists chair and every participant with canonical ids', () => {
  const md = buildCouncilTaskMarkdown({
    taskId: 'task-t1', pmRunId: 'pmrun-t1', projectId: 'dsh-p6-test-b', submittedVia: 'TELEGRAM', commandId: 'cmd-1',
    createdAt: '2026-08-24T10:53:20.868Z', completedAt: '2026-08-24T11:00:20.868Z', ownerTaskText: 'P10-T1-MARKER=ORBIT-417',
    rounds: 2, strategy: 'independent_then_critique_then_synthesis', chairProfileId: 'live1-claude-pm',
    chairProfile: { product: 'claude-code', model: 'sonnet', reasoning: 'high' },
    participants: [
      { profileId: 'live1-codex-gpt-5-6-sol-pm', profile: { product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' } },
      { profileId: 'live1-antigravity-gemini-high', profile: { product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' } },
      { profileId: 'live1-opencode-pm', profile: { product: 'opencode', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high' } },
    ],
    markers: ['P10-T1-MARKER=ORBIT-417'],
    status: 'completed',
  });
  for (const id of ['live1-claude-pm', 'live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm']) {
    assert.match(md, new RegExp(id));
  }
  assert.match(md, /P10-T1-MARKER=ORBIT-417/);
  assert.match(md, /rounds: 2/i);
});

test('buildChairSynthesisMarkdown preserves the marker verbatim', () => {
  const md = buildChairSynthesisMarkdown({ output: 'final answer P10-T1-MARKER=ORBIT-417 done', markers: ['P10-T1-MARKER=ORBIT-417'] });
  assert.match(md, /P10-T1-MARKER=ORBIT-417/);
});

test('buildMemberReportMarkdown and buildMemberCritiqueMarkdown map content to the correct participant only', () => {
  const report = buildMemberReportMarkdown({
    profileId: 'live1-codex-gpt-5-6-sol-pm', profile: { product: 'codex', model: 'gpt-5.6-sol' }, round: 1,
    analysis: 'codex analysis text', recommendation: 'codex recommendation', risks: ['risk1'], uncertainties: ['unc1'],
  });
  assert.match(report, /codex analysis text/);
  assert.match(report, /codex recommendation/);
  assert.doesNotMatch(report, /antigravity/);

  const critique = buildMemberCritiqueMarkdown({
    profileId: 'live1-antigravity-gemini-high', profile: { product: 'antigravity', model: 'gemini-3.7-flash-high' }, round: 2,
    criticisms: ['crit1'], agreements: ['agree1'], revisedRecommendation: 'revised text', remainingDisagreements: [],
  });
  assert.match(critique, /crit1/);
  assert.match(critique, /revised text/);
  assert.doesNotMatch(critique, /codex analysis text/);
});

test('buildMemberFailureMarkdown never fabricates a report/critique body', () => {
  const md = buildMemberFailureMarkdown({ profileId: 'x', profile: null, round: 1, stage: 'participant_report', reason: 'PARSE_FAILED', retryOccurred: true, attempts: [{}, {}] });
  assert.match(md, /FAILED/);
  assert.match(md, /PARSE_FAILED/);
  assert.match(md, /does not fabricate/);
});

test('buildChairPlanMarkdown preserves structured-output evidence and repair status', () => {
  const md = buildChairPlanMarkdown({
    participantInstructions: { p1: 'focus 1' }, critiqueFocus: 'be rigorous', synthesisFocus: 'converge',
    structuredOutput: { requested: true, provider: 'claude-code', schema_kind: 'council_chair_plan', present: true },
    repaired: false, attempts: [{ attempt: 0, ok: true }],
  });
  assert.match(md, /council_chair_plan/);
  assert.match(md, /repaired \(participant-id contract\): NO/);
});

test('buildCouncilWalkthroughMarkdown includes every canonical section from the spec', () => {
  const md = buildCouncilWalkthroughMarkdown({
    taskId: 'task-t1', ownerTaskWhy: 'why', chairProfileId: 'chair-1', chairProfile: null,
    round1: [{ profileId: 'p1', profile: null, path: 'members/p1/Round1_Report.md', position: 'pos1' }],
    round2: [{ profileId: 'p1', profile: null, path: 'members/p1/Round2_Critique.md', position: 'pos2' }],
    finalDecisionPath: 'chair/Synthesis.md', finalDecisionExcerpt: 'final',
    sessionEvidence: [{ label: 'p1', newProcessProven: true, nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' }],
  });
  for (const section of ['# Task', '# Why This Task Existed', '# Chair', '# Council Members', '# Round 1 Positions', '# Round 2 Critiques', '# Final Chair Decision', '# Agreements', '# Disagreements', '# Rejected Alternatives', '# Unresolved Questions', '# Repository Changes', '# Runtime Evidence', '# Session Evidence', '# Continuation Context', '# Read Order For Next Agent']) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
  assert.match(md, /NATIVE_SESSION_REUSE: UNKNOWN/);
});

test('buildProgressLine is one bounded, parseable, UTF-8-safe line with no embedded newline', () => {
  const line = buildProgressLine({
    timestamp: '2026-08-24T11:00:20.868Z', taskType: 'COUNCIL', taskId: 'task-t1', title: 'MiniQueue T1', status: 'completed',
    chairOrPmProfileId: 'live1-claude-pm', historyPath: 'docs/history/council/x', outcome: '4-backend architecture council completed',
  });
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /task-t1/);
  assert.match(line, /docs\/history\/council\/x/);
});
