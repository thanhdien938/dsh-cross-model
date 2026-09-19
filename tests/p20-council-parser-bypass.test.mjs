/**
 * P20.4 §8/§31 — the artifact Council report path NEVER touches the semantic
 * parser / canonicalizer / validateStepData / semantic-repair prompts, and
 * legacy Council still does. Static (imports) + dynamic (a semantically
 * chaotic report still seals). No live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runArtifactCouncil } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { verifySealedArtifactReference } from '../src/artifacts/artifact-recovery.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

const ARTIFACT_MODULES = [
  '../src/pm/council/council-artifact-orchestrator.mjs',
  '../src/pm/council/council-artifact-prompts.mjs',
  '../src/pm/council/council-artifact-stage-keys.mjs',
  '../src/pm/council/council-artifact-step-outcome.mjs',
  '../src/pm/report-stage-completion.mjs',
  '../src/artifacts/artifact-input-transport.mjs',
];

// Forbidden import SPECIFIERS (module paths) — the artifact path must not
// pull in any semantic-parsing / canonicalizer / step-data / semantic-repair
// module. Checked against `import ... from '<specifier>'` only, so a doc
// comment mentioning `parseDecision` is fine.
const FORBIDDEN_IMPORT_SPECIFIERS = [
  /production-pm-backend-registry/,
  /output-canonicalization/,
  /pm-decision-schema/, /pm-contracts/,
  /council-step-workflow-runner/,
  /council-prompts/,               // buildChairPlanRepairPrompt / buildParticipantSemanticRepairPrompt live here
  /workspace-evidence-contract/,
  /parser-0-diagnostics/, /parse-decision/,
];

function importSpecifiers(src) {
  const out = [];
  const re = /(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  // also dynamic import()
  const re2 = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(src)) !== null) out.push(m[1]);
  return out;
}

test('§31 (static): no artifact Council module imports the semantic parser / canonicalizer / step-data validator / semantic-repair prompts', () => {
  for (const rel of ARTIFACT_MODULES) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const specs = importSpecifiers(src);
    for (const spec of specs) {
      for (const re of FORBIDDEN_IMPORT_SPECIFIERS) {
        assert.doesNotMatch(spec, re, `${rel} imports forbidden module ${JSON.stringify(spec)}`);
      }
    }
  }
});

test('§8 (static): legacy Council step runner STILL uses parseDecision / canonicalizer / validateStepData / semantic repair', () => {
  const src = readFileSync(new URL('../src/pm/council/council-step-workflow-runner.mjs', import.meta.url), 'utf8');
  assert.match(src, /validateStepData/);
  assert.match(src, /canonicalizationDiagnostic|output-canonicalization/);
  assert.match(src, /buildChairPlanRepairPrompt|buildParticipantSemanticRepairPrompt|buildParseRepairPrompt/);
});

test('P20.4R §4/§18: the straight-line runArtifactCouncil composition seam is REMOVED; the durable artifact_v1 runtime is opt-in + fail-closed', () => {
  const src = readFileSync(new URL('../src/runtime/p5-production-composition.mjs', import.meta.url), 'utf8');
  // The P20.4 stopgap seam is gone — one authoritative Council topology.
  assert.doesNotMatch(src, /const councilArtifactOrchestrator\s*=/);
  assert.doesNotMatch(src, /councilArtifactOrchestrator,close/);
  assert.doesNotMatch(src, /import\s*\{runArtifactCouncil\}/);
  // The artifact_v1 durable path is built from the durable task transport,
  // requires injected deps, and fails closed (never silently legacy).
  assert.match(src, /effectiveTransport==='artifact_v1'/);
  assert.match(src, /COUNCIL_ARTIFACT_DEPS_MISSING/);
  assert.match(src, /const councilArtifactRuntime=deps\.councilArtifactRuntime\?\?null/);
  // P20.8 §6 appends further additive, opt-in return-object surface after
  // `close` — the real invariant is that `councilArtifactRuntime` is still
  // returned adjacent to `close`, not that `close` is the literal last field.
  assert.match(src, /councilArtifactRuntime,close,?/);
  // the artifact council step branch inside the runner never touches the
  // legacy semantic machinery for report content
  const runner = readFileSync(new URL('../src/pm/council/council-step-workflow-runner.mjs', import.meta.url), 'utf8');
  assert.match(runner, /transport_version === 'artifact_v1'/);
  assert.match(runner, /#runArtifactStepDurable/);
});

test('§31 (dynamic): a report with multiple JSON blocks, malformed JSON, no JSON, and contradictory recommendations still seals', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const chaos = [
      'No JSON here, just prose. Then some JSON:',
      '{"decision":"A"} {"decision":"B"}',
      '```json\n{ "a": 1 ,, }\n```',
      'recommendation: SHIP NOW.',
      'recommendation: DO NOT SHIP.',
      'verdict: unclear. agreement: 0%.',
    ].join('\n\n');
    const out = await runArtifactCouncil({
      store, council: spec, ownerTask: 'x', constraints: [],
      taskId: 'task-CHAOS01', taskSlug: 'chaos', createdAt: COUNCIL_CREATED_AT,
      aliasRegistry: aliasRegistryFor(spec),
      resolveReportBackend: councilBackends({ plan: { default: { text: chaos } } }),
      consumerInputTransport: 'VERBATIM_CONTENT',
    });
    assert.equal(out.ok, true);
    // every report is sealed verbatim, chaos intact
    for (const s of out.steps.filter((x) => x.step_kind === 'participant_report')) {
      const v = verifySealedArtifactReference({ store, reference: s.sealed_ref });
      assert.equal(v.buffer.toString('utf8'), chaos);
    }
    // no semantic verdict leaked into app metadata / outcomes
    const blob = JSON.stringify(store.openTaskById('task-CHAOS01').freshManifest()) + JSON.stringify(out.steps);
    assert.doesNotMatch(blob, /"decision"\s*:|"verdict"\s*:|"recommendation"\s*:|"agreement"\s*:/);
  });
});
