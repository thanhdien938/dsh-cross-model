/**
 * Shared offline helpers for the P20.2 report test suite. Not a *.test.mjs
 * file, so it is never discovered as a test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createArtifactStore } from '../../src/artifacts/artifact-store.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../../src/pm/report-backend-result.mjs';

export const STORE_CHILD = join(dirname(fileURLToPath(import.meta.url)), 'p20-store-child.mjs');

export function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p20-2-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try { result = fn(dir); } catch (e) { cleanup(); throw e; }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

export function makeStore(dir, over = {}) {
  return createArtifactStore({
    storeId: over.storeId ?? 's1',
    projectId: over.projectId ?? 'live1-local',
    root: over.root ?? join(dir, 'store'),
  });
}

export function runChild(cfg) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STORE_CHILD, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* leave null */ }
      resolve({ exitCode, parsed, out, err });
    });
  });
}

/**
 * A deterministic in-process fake report backend. By default it echoes the
 * request's `backend` / `profileId` / `executionId` so it passes the P20.2R
 * R1 result-binding check; pass `overrideBinding` to deliberately return a
 * mismatched result for a fail-closed test.
 */
export function fakeReportBackend({ text = 'ok', terminalState = TERMINAL_STATE.SUCCESS, finishReason = 'stop', timedOut = false, cancelled = false, model = 'fake-1', onPrompt, overrideBinding = null, debateTypedControl = null, supportsDebateTypedControl = false, safeDiagnostics = null, durationMs = 12 } = {}) {
  return {
    lastPrompt: null,
    supportsDebateTypedControl,
    async runReport({ prompt, request }) {
      this.lastPrompt = prompt;
      if (onPrompt) onPrompt(prompt);
      return buildReportBackendResult({
        backend: overrideBinding?.backend ?? request?.backend ?? 'fake',
        profileId: overrideBinding?.profileId ?? request?.profileId ?? 'live1-fake',
        model,
        executionId: overrideBinding?.executionId ?? request?.executionId ?? 'exec-fake',
        terminalState,
        providerFinishReason: finishReason,
        timedOut,
        cancelled,
        durationMs,
        acceptedVisibleText: text === null ? null : String(text),
        visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE,
        debateTypedControl: typeof debateTypedControl === 'boolean' ? debateTypedControl : null,
        // P23.1 — optional forensic safeDiagnostics passthrough, for tests
        // simulating a TIMEOUT/FAILED result that carries bounded forensic
        // facts (report-execution-forensics.mjs's shape). `null` (default)
        // is byte-for-byte the old behavior for every existing caller.
        safeDiagnostics,
      });
    },
  };
}

/** A fake `fetchImpl` returning an OpenAI-style chat completion. */
export function fakeChatFetch({ status = 200, body } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return payload; },
  });
}

export function chatBody({ content, finishReason = 'stop', model = 'gpt-x', id = 'cmpl-1', usage } = {}) {
  return {
    id,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

export const FAKE_PROVIDERS = Object.freeze({
  testprov: Object.freeze({ baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'DSH_P20_TEST_API_KEY', headers: {} }),
});
export const FAKE_ENV = Object.freeze({ DSH_P20_TEST_API_KEY: 'sk-testkey-000000000000' });

// ---- P20.3 helpers ------------------------------------------------------
import { runSingleReport } from '../../src/pm/single-report-operation.mjs';
import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../../src/artifacts/artifact-paths.mjs';

const P3_CREATED = '2026-09-10T10:00:00Z';

/**
 * Seed a DELIVERED (not sealed) SINGLE `artifact_v1` invocation and return
 * everything a P20.3 test needs, including the app-owned `expected` identity.
 */
export async function seedDelivered(dir, over = {}) {
  const store = makeStore(dir, over.store);
  const taskId = over.taskId ?? 'task-P3SEED01';
  const invocationId = over.invocationId ?? 'inv-p3-1';
  const executionId = over.executionId ?? 'exec-p3-1';
  const profileId = over.profileId ?? 'live1-fake';
  const backend = over.backend ?? 'fake';
  const actorAlias = over.actorAlias ?? 'fake';
  const text = over.text ?? '# SINGLE report\n\nfindings: multiple\n{"a":1}\n{"b":2}\nend\n';
  const out = await runSingleReport({
    store, taskId, taskSlug: over.taskSlug ?? 'p20.3 seed', createdAt: over.createdAt ?? P3_CREATED,
    invocationId, executionId, profileId, backend, actorAlias,
    instructions: 'go', reportBackend: over.reportBackend ?? fakeReportBackend({ text }),
    startedAt: over.startedAt ?? P3_CREATED,
    deliveryMechanism: over.deliveryMechanism,
    directWriter: over.directWriter,
  });
  return {
    store, task: out.task, invocation: out.invocation, attempt: out.attempt, delivery: out.delivery, unsealedCandidate: out.unsealedCandidate,
    expected: {
      storeId: store.storeId, projectId: store.projectId, taskId,
      invocationId, role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, round: null,
      profileId, actorAlias, executionId, backend,
    },
  };
}

/** Reopen the SAME store/task/invocation from disk with fresh objects (restart). */
export function reopenFromDisk(dir, { taskId, storeOver } = {}) {
  const store = makeStore(dir, storeOver);
  const task = store.openTaskById(taskId ?? 'task-P3SEED01');
  return { store, task };
}
