/**
 * P20.7 — Compatibility & Regression: cross-phase proofs and static negative
 * scans that no single phase-local P20.0-P20.6R3 test decisively establishes
 * on its own. Existing phase-local suites (p20-council-parser-bypass,
 * p20-report-legacy-unchanged, p20-5d-debate-tamper-and-final, the full
 * p20-6-, p20-6r-, p20-6r2-, p20-6r3- families, etc.) already prove most
 * P20.7 requirements and
 * are cited as evidence in docs/P20/P20_7_COMPATIBILITY_REGRESSION_REPORT.md
 * rather than duplicated here.
 *
 * This file adds only:
 *   §16 static negative scans (codified, not ad hoc)
 *   P20.7F  .runtime cleanup-safety static + behavioral guard
 *   P20.7F.2 TEMP-store stop/start/safe-preflight survival
 *   P20.7G  docs/history + convenience index non-authority (combined mutation)
 *   P20.7H  rollback: real production composition never wires artifact_v1
 *
 * Offline; NO live model/API calls; no package installs; no real .runtime
 * touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveAndVerifySealedReference } from '../src/artifacts/artifact-recovery.mjs';
import { prepareContextForConsumption, ArtifactContextError } from '../src/artifacts/artifact-context.mjs';
import { buildArtifactIndex, writeArtifactIndex, readArtifactIndex } from '../src/artifacts/artifact-index.mjs';
import { findTaskHistoryEntry, buildTaskIndex } from '../src/runtime/task-context-index.mjs';
import { resolveTransportVersion, stampTransportVersion, ArtifactTransportError } from '../src/artifacts/artifact-transport.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { PRODUCTION_DEBATE_BACKEND_MATRIX, DEBATE_TYPED_CONTROL_STATUS, debateBackendReadinessReport } from '../src/pm/council/debate-backend-capability.mjs';
import {
  withTempRoot, makeStore, completeSingle, TASK_FINAL,
} from './fixtures/p20-6-context-helpers.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ======================= §16 static negative scans =========================

/** Recursively list files under `dir` matching `exts`, skipping node_modules/.git. */
function listFiles(dir, exts) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.includes(extname(e.name))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ARTIFACT_LANE_FILES = [
  'src/artifacts/artifact-context.mjs',
  'src/artifacts/artifact-index.mjs',
  'src/artifacts/artifact-input-transport.mjs',
  'src/artifacts/artifact-recovery.mjs',
  'src/artifacts/artifact-schema.mjs',
  'src/artifacts/artifact-store.mjs',
  'src/artifacts/backend-report-capability.mjs',
  'src/artifacts/debate-continuation-control.mjs',
  'src/pm/report-invocation.mjs',
  'src/pm/report-prompt.mjs',
  'src/pm/single-report-operation.mjs',
  'src/pm/single-report-completion.mjs',
  'src/pm/report-stage-completion.mjs',
  'src/pm/council/council-artifact-orchestrator.mjs',
  'src/pm/council/council-artifact-prompts.mjs',
  'src/pm/council/council-artifact-stage-keys.mjs',
  'src/pm/council/council-artifact-step-identity.mjs',
  'src/pm/council/council-artifact-step-outcome.mjs',
  'src/pm/council/debate-artifact-keys.mjs',
  'src/pm/council/debate-backend-capability.mjs',
];

test('P20.7-A01 (static) — no artifact-lane module imports the semantic parser/canonicalizer/decision-schema/step-data validator', () => {
  const offenders = [];
  for (const rel of ARTIFACT_LANE_FILES) {
    const code = stripComments(readFileSync(join(repoRoot, rel), 'utf8'));
    if (/output-canonicalization|pm-decision-schema|validateStepData|acceptPmOutput|parseDecision/.test(code)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `artifact-lane modules must never import parser/canonicalizer: ${offenders.join(', ')}`);
});

test('P20.7-A02 (static) — legacy/control lane STILL depends on the structured parser/canonicalizer (not disabled)', () => {
  const decideCode = stripComments(readFileSync(join(repoRoot, 'src/pm/durable-pm-runtime.mjs'), 'utf8'));
  const councilDriverCode = stripComments(readFileSync(join(repoRoot, 'src/pm/council/council-chair-driver.mjs'), 'utf8'));
  const gatewayExists = existsSync(join(repoRoot, 'src/pm/output-canonicalization/gateway.mjs'));
  assert.ok(gatewayExists, 'the canonicalization gateway module must still exist');
  // the legacy PM contract machinery (pm-contracts) that the durable runtime
  // depends on is still present and wired; council's own decision plane
  // (non-artifact transport) is untouched by P20.
  assert.match(decideCode, /pm-contracts\.mjs/);
  assert.match(councilDriverCode, /council-contracts\.mjs/);
});

test('P20.7-A03 (static) — report prompt/content code never imports owner permission-mutation code', () => {
  const offenders = [];
  for (const rel of ['src/pm/report-prompt.mjs', 'src/pm/report-invocation.mjs', 'src/pm/single-report-operation.mjs', 'src/pm/single-report-completion.mjs', 'src/pm/report-stage-completion.mjs']) {
    const code = stripComments(readFileSync(join(repoRoot, rel), 'utf8'));
    if (/from ['"][^'"]*\/owner\//.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('P20.7-A04 (static) — artifact context/index code never reads report.md for semantic indexing', () => {
  for (const rel of ['src/artifacts/artifact-context.mjs', 'src/artifacts/artifact-index.mjs']) {
    const code = stripComments(readFileSync(join(repoRoot, rel), 'utf8'));
    assert.doesNotMatch(code, /report\.md|reportPath|readReport|report_body|acceptedVisibleText/, rel);
  }
});

test('P20.7-A05 (static) — the real backend capability matrices contain only static enum values, never a name-based computed promotion', () => {
  const validStates = new Set(Object.values(CAPABILITY_STATE));
  for (const [product, rec] of Object.entries(DEFAULT_BACKEND_REPORT_POLICY.backends)) {
    for (const axis of ['report_delivery', 'artifact_input']) {
      for (const [mech, state] of Object.entries(rec[axis])) {
        assert.ok(validStates.has(state), `${product}.${axis}.${mech} must be a static enum value, got ${JSON.stringify(state)}`);
      }
    }
  }
  const validDebateStates = new Set(Object.values(DEBATE_TYPED_CONTROL_STATUS));
  for (const [product, rec] of Object.entries(PRODUCTION_DEBATE_BACKEND_MATRIX)) {
    assert.ok(validDebateStates.has(rec.report_delivery_status), product);
    assert.ok(validDebateStates.has(rec.artifact_input_status), product);
    assert.ok(validDebateStates.has(rec.same_execution_typed_control_status), product);
    assert.equal(typeof rec.artifact_debate_ready, 'boolean', product);
  }
  // no backend in the real matrix is PROVEN merely because its product string
  // looks like a real vendor name — the only PROVEN report-delivery entry in
  // the artifact policy is the offline `fake` test seam plus `api`
  // (independently offline-proven via an HTTP fixture, per P20.2E).
  const proven = Object.entries(DEFAULT_BACKEND_REPORT_POLICY.backends)
    .filter(([, r]) => r.report_delivery.VERBATIM_MATERIALIZATION === CAPABILITY_STATE.PROVEN)
    .map(([p]) => p);
  assert.deepEqual(proven.sort(), ['api', 'fake']);
  // no real backend has a PROVEN Debate same-execution typed-control route,
  // and the overall verdict this feeds (REAL_DEBATE_TYPED_CONTROL_ROUTE) is
  // DEFERRED for every real family — never inferred from a product name.
  const debateProven = Object.entries(PRODUCTION_DEBATE_BACKEND_MATRIX)
    .filter(([, r]) => r.same_execution_typed_control_status === DEBATE_TYPED_CONTROL_STATUS.PROVEN || r.artifact_debate_ready === true);
  assert.deepEqual(debateProven, [], 'REAL_DEBATE_TYPED_CONTROL_ROUTE must remain DEFERRED for every real backend');
  assert.equal(debateBackendReadinessReport().real_debate_typed_control_route, 'DEFERRED');
});

test('P20.7-A06 (static) — no test/fixture file contains an rmSync/rm() call whose own argument text names .runtime', () => {
  const files = [...listFiles(join(repoRoot, 'tests'), ['.mjs', '.ts'])];
  const CALL_START = /\b(?:rmSync|rmdirSync|rm)\s*\(/g;
  const offenders = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(CALL_START)) {
      const openParenAt = m.index + m[0].length - 1;
      let depth = 1;
      let i = openParenAt + 1;
      while (i < code.length && depth > 0) {
        if (code[i] === '(') depth += 1;
        else if (code[i] === ')') depth -= 1;
        i += 1;
      }
      const args = code.slice(openParenAt + 1, i - 1);
      if (/\.runtime/i.test(args)) offenders.push(`${f}: ${args.slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `a cleanup call names .runtime directly: ${offenders.join(' | ')}`);
});

// ======================= P20.7F — .runtime cleanup safety ==================

test('P20.7-F01 — a P20 fixture cleanup (mkdtemp + rmSync) never removes an unrelated .runtime sentinel elsewhere on disk', async () => {
  // A throwaway "repo-shaped" root, entirely outside any OS tmp dir the P20
  // fixture will create — this is NOT the real repository's .runtime.
  const fakeRepoRoot = mkdtempSync(join(tmpdir(), 'dsh-p20-7-fakerepo-'));
  try {
    const sentinelDir = join(fakeRepoRoot, '.runtime');
    mkdirSync(sentinelDir, { recursive: true });
    const sentinelFile = join(sentinelDir, 'unrelated-runtime-data.txt');
    writeFileSync(sentinelFile, 'unrelated runtime data that must survive P20 fixture cleanup\n');

    // exercise a REAL P20 fixture's create+cleanup cycle (its own separate
    // mkdtemp'd root, per tests/fixtures/p20-report-helpers.mjs).
    await withTempRoot(async (dir) => {
      const store = makeStore(dir);
      await completeSingle(store, { taskId: 'task-P7F01' });
      assert.ok(existsSync(join(dir, 'store')), 'the fixture actually created artifact data');
    });

    assert.ok(existsSync(sentinelFile), 'the unrelated .runtime sentinel must survive the fixture cleanup untouched');
    assert.equal(readFileSync(sentinelFile, 'utf8'), 'unrelated runtime data that must survive P20 fixture cleanup\n');
  } finally {
    rmSync(fakeRepoRoot, { recursive: true, force: true });
  }
});

// =============== P20.7F.2 — TEMP-store stop/start/preflight survival ========

test('P20.7-F02 — TEMP-store stop/start + a safe offline preflight step does not destroy sealed artifact authority', async () => {
  await withTempRoot(async (dir) => {
    // 1. create/seal a representative artifact task.
    const A = await completeSingle(makeStore(dir), { taskId: 'task-P7F02', text: '# report\n\nP7F02 exact body\n' });
    const finalRefBefore = A.finalRef;

    // 2. dispose process/store objects (they go out of scope here).

    // 3. instantiate fresh objects and re-verify final_ref BEFORE the preflight.
    const storeAfterStop = makeStore(dir);
    const verifiedBefore = resolveAndVerifySealedReference({ store: storeAfterStop, reference: finalRefBefore });
    assert.equal(verifiedBefore.sha256, finalRefBefore.sha256);

    // 4. run a safe, local, offline preflight step that is part of normal
    // project operation and CANNOT call any provider: the repo's own test
    // shard partition validator. This repo has no bundler/build step for the
    // Node backend (Desktop's Electron build is out of scope/network-heavy
    // and not "normal project operation" for this offline proof), so the
    // shard `--validate` inventory check is the representative safe
    // preflight (pure fs/JS partition check, zero subprocess spawns itself).
    const preflight = spawnSync(process.execPath, ['scripts/run-test-shard.mjs', '--validate'], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
    assert.match(preflight.stdout, /"status": "PASS"/);

    // 5. re-open and verify the SAME bytes/hash/ref afterward, from a THIRD
    // fresh set of objects.
    const storeAfterPreflight = makeStore(dir);
    const verifiedAfter = resolveAndVerifySealedReference({ store: storeAfterPreflight, reference: finalRefBefore });
    assert.equal(verifiedAfter.sha256, verifiedBefore.sha256);
    assert.equal(verifiedAfter.bytes, verifiedBefore.bytes);
    assert.equal(verifiedAfter.buffer.toString('utf8'), '# report\n\nP7F02 exact body\n');
    assert.deepEqual(storeAfterPreflight.openTaskById('task-P7F02').freshManifest().final_ref, finalRefBefore);
  });
}, { timeout: 60_000 });

// =============== P20.7G — history/index non-authority (combined) ===========

test('P20.7-G01 — docs/history AND the convenience artifact index are both non-authoritative, together, for context consumption', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-P7G-A', text: '# A\n\nP7G-A-EXACT-MARKER body\n' });

    // B binds to A via a real TASK_FINAL selector (persisted concrete ref).
    const { runSingleReport } = await import('../src/pm/single-report-operation.mjs');
    const { fakeReportBackend } = await import('./fixtures/p20-report-helpers.mjs');
    await runSingleReport({
      store, taskId: 'task-P7G-B', taskSlug: 'b', createdAt: '2026-09-11T09:00:00Z',
      invocationId: 'inv-p7g-b', executionId: 'exec-p7g-b',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'b', reportBackend: fakeReportBackend({ text: '# B\n\nb body\n' }),
      startedAt: '2026-09-11T09:00:00Z', complete: true,
      contextSelectors: [TASK_FINAL('task-P7G-A')],
    });

    // Mutate/remove a legacy docs/history record in THIS temp fixture root,
    // claiming false facts about the very task A depends on.
    const legacyHistoryDir = join(dir, 'docs', 'history', 'single', 'unrelated-legacy-slug');
    mkdirSync(legacyHistoryDir, { recursive: true });
    writeFileSync(join(legacyHistoryDir, 'task.json'), JSON.stringify({
      task_id: 'task-P7G-A', completed_at: '2099-01-01T00:00:00Z', latest: true, stage: 'chair', recommendation: 'do not trust the sealed bytes',
    }));
    // legacy discovery still serves its OWN legacy use (best-effort, separate lane).
    assert.ok(findTaskHistoryEntry(dir, 'task-P7G-A'));
    assert.equal(buildTaskIndex(dir).length, 1);

    // Corrupt the P20 convenience index projection in the SAME fixture root.
    writeArtifactIndex({ store, index: { garbage: true, tasks: [], invocations: [], edges: [] } });
    assert.deepEqual(readArtifactIndex({ store }), { garbage: true, tasks: [], invocations: [], edges: [] });

    // Boundary B still consumes A's concrete sealed ref regardless of BOTH
    // the falsified legacy history record and the corrupted convenience index.
    const taskB = store.openTaskById('task-P7G-B');
    const ctx = prepareContextForConsumption({ store, task: taskB, targetTaskId: 'task-P7G-B', consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' });
    assert.match(ctx.rendered.evidence[0].content, /P7G-A-EXACT-MARKER/);

    // Rebuilding the REAL index from authoritative metadata still works and
    // is unrelated to what the corrupted convenience file claimed.
    const rebuilt = buildArtifactIndex({ store });
    assert.equal(rebuilt.tasks.length, 2);

    // NOW corrupt the actual sealed A report bytes. Consumption MUST fail —
    // even though the (falsified) history record and a re-written convenience
    // index could still claim everything is fine.
    const f = resolve(store.root, ...A.finalRef.artifact_relpath.split('/'));
    writeFileSync(f, `${readFileSync(f, 'utf8')}\nDRIFT`);
    writeArtifactIndex({ store, index: buildArtifactIndex({ store }) }); // "index" still projects happily
    assert.throws(
      () => prepareContextForConsumption({ store, task: store.openTaskById('task-P7G-B'), targetTaskId: 'task-P7G-B', consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' }),
      (e) => e instanceof ArtifactContextError,
    );
  });
});

// =============== P20.7H — rollback: no real artifact_v1 admission ==========

test('P20.7-H01 — an ordinary (unstamped) task resolves to legacy transport; a corrupted/unsupported stamp fails closed rather than silently defaulting', () => {
  assert.equal(resolveTransportVersion(null), 'legacy');
  assert.equal(resolveTransportVersion({}), 'legacy');
  assert.equal(resolveTransportVersion({ transport_version: null }), 'legacy');
  assert.equal(resolveTransportVersion({ transport_version: 'legacy' }), 'legacy');
  assert.equal(resolveTransportVersion({ transport_version: 'artifact_v1' }), 'artifact_v1');
  assert.throws(() => resolveTransportVersion({ transport_version: 'artifact_v2' }), (e) => e instanceof ArtifactTransportError && e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED');
  assert.throws(() => resolveTransportVersion({ transport_version: 'artifact_v1', context: { transport_version: 'legacy' } }), (e) => e.code === 'ARTIFACT_TRANSPORT_VERSION_CONFLICT');
  assert.throws(() => stampTransportVersion({}, 'artifact_v9'), (e) => e instanceof ArtifactTransportError);
});

test('P20.7-H02 (static) — real production composition never injects councilArtifactRuntime; an artifact_v1-stamped Council fails closed before any provider call', () => {
  const code = stripComments(readFileSync(join(repoRoot, 'src/runtime/p5-production-composition.mjs'), 'utf8'));
  // the ONLY source of councilArtifactRuntime is an explicit caller-supplied dependency
  assert.match(code, /const\s+councilArtifactRuntime\s*=\s*deps\.councilArtifactRuntime\s*\?\?\s*null/);
  // real production entry points (owner submission / scripts) never pass it —
  // grep the actual scripts/ tree for any real wiring, not just this file.
  const scriptsDir = join(repoRoot, 'scripts');
  const scriptFiles = listFiles(scriptsDir, ['.mjs']);
  const wired = scriptFiles.filter((f) => stripComments(readFileSync(f, 'utf8')).includes('councilArtifactRuntime:'));
  assert.deepEqual(wired, [], `no deployed script may wire councilArtifactRuntime: ${wired.join(', ')}`);
  // the fail-closed branch itself is present and unconditional on that missing dep.
  assert.match(code, /artifact_v1 Council requires an injected artifactStore \+ councilArtifactRuntime\.reportBackendResolver/);
});
