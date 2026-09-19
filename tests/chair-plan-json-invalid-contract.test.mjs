import test from 'node:test';
import assert from 'node:assert/strict';

// DSH-CHAIR-PLAN-JSON-INVALID (2026-09-09) — regressions for the ONE fix at
// the Chair output-contract layer.
//
// Canonical live evidence being reproduced (acc-live-2f7778fc-7f32-4776-b5d7-
// 81123094ea5c attempts 0 and 1, plus one isolated diagnostic call at
// BASE_HEAD be483f6, all on `live1-api-openai-gpt-5-6-luna-pro-high`):
// transport SUCCESS, `finish_reason:"stop"` (NOT truncation), assistant
// content present as ONE string field, no Markdown fence, no leading or
// trailing prose, first char `{`, last char `}` — and the object short by
// EXACTLY ONE closing brace (brace-scanner depth 1 at end of input, zero
// balanced top-level objects). The chair's own template closes three levels
// (`}}}`); renderRequest()'s universal `finish` shape closes two (`}}`), and
// before this fix the chair's contract was NOT the terminal model-visible
// text (History was). Nothing here changes parseDecision(),
// extractSingleDecision(), normalizePmDecision(), MAX_PARSE_ATTEMPTS, any
// provider capability, or any acceptance call budget.

import { createCliPmDriver, classifyParseSubreason } from '../src/pm/production-pm-backend-registry.mjs';

const PROJECT = { id: 'live1-local', repo_path: 'C:/repo' };
const CHAIR = { id: 'live1-api-openai-gpt-5-6-luna-pro-high', product: 'api' };
const AGY = 'live1-antigravity-gemini-3-8-flash-high';
const CONTROL = 'live1-api-z-ai-glm-5-3-flash-medium';
const PARTICIPANTS = [AGY, CONTROL];

// The observed live failure shape, rebuilt structurally (never a captured
// assistant excerpt): a well-formed chair_plan decision with its final
// closing brace removed.
const WELL_FORMED_CHAIR_PLAN = JSON.stringify({
  type: 'finish',
  output: 'council plan ready',
  data: {
    type: 'council_plan',
    participant_instructions: { [AGY]: 'focus a', [CONTROL]: 'focus b' },
    critique_focus: 'critique focus',
    synthesis_focus: 'synthesis focus',
  },
});
const ONE_BRACE_SHORT = WELL_FORMED_CHAIR_PLAN.slice(0, -1);

function chairDriver(run) {
  return createCliPmDriver({ profile: CHAIR, project: PROJECT, run });
}
function chairRequest(context) {
  return { id: 'r-chair', objective: 'plan the council', context };
}
const COUNCIL_CONTEXT = { council: true, stepKind: 'chair_plan', profileId: CHAIR.id, participantProfileIds: PARTICIPANTS };

// ---- ROOT CAUSE: the observed shape really is PM_DECISION_JSON_INVALID ----

test('root cause 1: a chair_plan object short by exactly one closing brace fails closed as PM_DECISION_PARSE_FAILED / PM_DECISION_JSON_INVALID', async () => {
  const driver = chairDriver(async () => ONE_BRACE_SHORT);
  await assert.rejects(
    () => driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] }),
    (error) => {
      assert.equal(error.code, 'PM_DECISION_PARSE_FAILED');
      assert.equal(error.parseSubreason, 'PM_DECISION_JSON_INVALID');
      return true;
    },
  );
});

test('root cause 2: its structural diagnostics match the canonical live evidence exactly', async () => {
  let captured = null;
  const driver = chairDriver(async () => ONE_BRACE_SHORT);
  try {
    await driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] });
  } catch (error) {
    captured = error.diagnostics;
  }
  assert.ok(captured, 'parse failure carries structural diagnostics');
  // Canonical ledger facts: first `{`, last `}`, no fence, whole text is not
  // valid JSON, no leading content, no trailing prose.
  assert.equal(captured.firstChar, '{');
  assert.equal(captured.lastChar, '}');
  assert.equal(captured.firstCharClass, 'OPEN_BRACE');
  assert.equal(captured.lastCharClass, 'CLOSE_BRACE');
  assert.equal(captured.fullJson, false);
  assert.equal(captured.jsonFence, false);
  assert.equal(captured.prefixClass, 'NONE');
  assert.notEqual(captured.suffixClass, 'TRAILING_CONTENT');
  assert.equal(classifyParseSubreason(captured), 'PM_DECISION_JSON_INVALID');
});

test('root cause 3: the same object WITH its final brace parses, proving the defect is exactly one brace and not the shape', async () => {
  const driver = chairDriver(async () => WELL_FORMED_CHAIR_PLAN);
  const decision = await driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] });
  assert.equal(decision.type, 'finish');
  assert.equal(decision.data.type, 'council_plan');
  assert.deepEqual(Object.keys(decision.data.participant_instructions).sort(), [...PARTICIPANTS].sort());
});

// ---- THE FIX: the chair_plan contract is now the terminal visible text ----

test('fix 1: a chair_plan Council request ends with the chair contract, after Request context and History', async () => {
  let prompt = null;
  const driver = chairDriver(async (rendered) => { prompt = rendered; return WELL_FORMED_CHAIR_PLAN; });
  await driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] });
  const capsuleIndex = prompt.indexOf('FINAL COUNCIL CHAIR CONTRACT');
  assert.ok(capsuleIndex > prompt.indexOf('History:'), 'chair contract comes AFTER Request context and History');
  assert.equal(prompt.slice(capsuleIndex).trim(), prompt.slice(capsuleIndex), 'chair contract is terminal — only whitespace after it');
});

test('fix 2: the terminal contract states the real validateStepData shape, the exact owner-selected ids, and the three-brace nesting', async () => {
  let prompt = null;
  const driver = chairDriver(async (rendered) => { prompt = rendered; return WELL_FORMED_CHAIR_PLAN; });
  await driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] });
  const capsule = prompt.slice(prompt.indexOf('FINAL COUNCIL CHAIR CONTRACT'));
  assert.match(capsule, /"data":\{"type":"council_plan","participant_instructions":\{/);
  assert.match(capsule, /"critique_focus":"<focus text>","synthesis_focus":"<focus text>"\}\}/);
  assert.match(capsule, /ENDS with exactly TWO consecutive closing braces \(\}\}\)/);
  for (const id of PARTICIPANTS) assert.ok(capsule.includes(id), `capsule names ${id} verbatim`);
  // Never invents a field beyond validateStepData()'s chair_plan contract.
  for (const invented of ['council_report', 'council_critique', 'debate_response', 'analysis', 'recommendation']) {
    assert.equal(capsule.includes(invented), false, `capsule must not mention ${invented}`);
  }
});

// The capsule's own brace claim must be TRUE, not merely emphatic: an
// inaccurate closing-brace instruction would induce the very off-by-one it
// exists to prevent. This asserts the rendered example really does close
// every level it opens and really does end with `}}`.
test('fix 3: the chair contract example is itself brace-balanced and parses as strict JSON once placeholders are filled', async () => {
  let prompt = null;
  const driver = chairDriver(async (rendered) => { prompt = rendered; return WELL_FORMED_CHAIR_PLAN; });
  await driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] });
  const capsule = prompt.slice(prompt.indexOf('FINAL COUNCIL CHAIR CONTRACT'));
  const start = capsule.indexOf('{"type":"finish"');
  assert.ok(start >= 0, 'capsule carries the exact-shape example');
  let depth = 0; let end = -1;
  for (let i = start; i < capsule.length; i += 1) {
    if (capsule[i] === '{') depth += 1;
    else if (capsule[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, 'the example closes every brace it opens');
  const example = capsule.slice(start, end + 1);
  assert.ok(example.endsWith('}}'), 'the example ends with the two closing braces the capsule promises');
  assert.equal(example.endsWith('}}}'), false, 'and not a third — participant_instructions closes earlier');
  const filled = example.replace(/"<[^"]*>"/g, '"x"');
  const parsed = JSON.parse(filled);
  assert.equal(parsed.data.type, 'council_plan');
  assert.deepEqual(Object.keys(parsed.data.participant_instructions).sort(), [...PARTICIPANTS].sort());
});

// ---- SCOPE: nothing else in the request surface moves ----

test('scope 1: chair_plan without an owner-selected participant set stays byte-for-byte unchanged (no invented contract)', async () => {
  let prompt = null;
  const driver = chairDriver(async (rendered) => { prompt = rendered; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: chairRequest({ council: true, stepKind: 'chair_plan' }), history: [], capabilities: ['finish'] });
  assert.equal(prompt.includes('FINAL COUNCIL CHAIR CONTRACT'), false);
  assert.ok(prompt.endsWith('History: []'));
});

test('scope 2: the other chair step kinds and every non-Council request are unchanged', async () => {
  const rendered = [];
  const driver = chairDriver(async (prompt) => { rendered.push(prompt); return '{"type":"finish","output":"ok"}'; });
  for (const stepKind of ['chair_synthesis', 'debate_brief', 'debate_synthesis']) {
    await driver.decide({ turn: 0, request: chairRequest({ council: true, stepKind, profileId: CHAIR.id, participantProfileIds: PARTICIPANTS }), history: [], capabilities: ['finish'] });
  }
  await driver.decide({ turn: 0, request: { id: 'r-single', objective: 'plain' }, history: [], capabilities: ['finish'] });
  await driver.decide({ turn: 0, request: chairRequest({ stepKind: 'chair_plan', participantProfileIds: PARTICIPANTS }), history: [], capabilities: ['finish'] });
  for (const prompt of rendered) {
    assert.equal(prompt.includes('FINAL COUNCIL CHAIR CONTRACT'), false);
    assert.ok(prompt.endsWith('History: []'));
  }
});

test('scope 3: participant capsules are untouched by the chair lane', async () => {
  const seen = {};
  const driver = chairDriver(async (prompt) => { seen[Object.keys(seen).length] = prompt; return '{"type":"finish","output":"ok"}'; });
  for (const stepKind of ['participant_report', 'participant_critique', 'debate_response']) {
    await driver.decide({ turn: 0, request: chairRequest({ council: true, stepKind, participantProfileIds: PARTICIPANTS }), history: [], capabilities: ['finish'] });
  }
  for (const prompt of Object.values(seen)) {
    assert.ok(prompt.includes('FINAL COUNCIL PARTICIPANT CONTRACT'));
    assert.equal(prompt.includes('FINAL COUNCIL CHAIR CONTRACT'), false);
  }
});

// ---- FAIL-CLOSED GUARANTEES THE FIX MUST NOT WEAKEN ----

test('parser unchanged 1: malformed, truncated and multi-decision outputs still fail closed', async () => {
  const cases = [
    ['{"type":"finish","output":"a","data":{', 'PM_DECISION_JSON_INVALID'],
    [ONE_BRACE_SHORT, 'PM_DECISION_JSON_INVALID'],
    [`${WELL_FORMED_CHAIR_PLAN}${WELL_FORMED_CHAIR_PLAN}`, 'PM_DECISION_AMBIGUOUS_DECISIONS'],
  ];
  for (const [output, subreason] of cases) {
    const driver = chairDriver(async () => output);
    await assert.rejects(
      () => driver.decide({ turn: 0, request: chairRequest(COUNCIL_CONTEXT), history: [], capabilities: ['finish'] }),
      (error) => {
        assert.equal(error.code, 'PM_DECISION_PARSE_FAILED');
        assert.equal(error.parseSubreason, subreason);
        return true;
      },
    );
  }
});

test('parser unchanged 2: classifyParseSubreason still maps every canonical structural class the same way', () => {
  assert.equal(classifyParseSubreason({ prefixClass: 'EMPTY' }), 'PM_DECISION_EMPTY_TEXT');
  assert.equal(classifyParseSubreason({ prefixClass: 'LEADING_CONTENT' }), 'PM_DECISION_LEADING_CONTENT');
  assert.equal(classifyParseSubreason({ prefixClass: 'FENCE' }), 'PM_DECISION_FENCE_INVALID');
  assert.equal(classifyParseSubreason({ prefixClass: 'NONE', suffixClass: 'TRAILING_CONTENT' }), 'PM_DECISION_TRAILING_CONTENT');
  assert.equal(classifyParseSubreason({ prefixClass: 'NONE', suffixClass: 'UNKNOWN', fullJson: false }), 'PM_DECISION_JSON_INVALID');
  assert.equal(classifyParseSubreason({ prefixClass: 'NONE', suffixClass: 'NONE', fullJson: true }), 'PM_DECISION_UNEXPECTED_SHAPE');
});
