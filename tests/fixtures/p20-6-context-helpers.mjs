/**
 * Shared offline helpers for the P20.6 SINGLE Context Chaining suite.
 * Not a *.test.mjs file — never discovered as a test.
 */
import { runSingleReport } from '../../src/pm/single-report-operation.mjs';
import { fakeReportBackend, makeStore, withTempRoot } from './p20-report-helpers.mjs';

export { fakeReportBackend, makeStore, withTempRoot };

const CREATED = '2026-09-10T10:00:00Z';

/**
 * Run a COMPLETED SINGLE artifact_v1 task and return its concrete sealed
 * `final_ref` + the TaskWorkspace + the fresh manifest.
 */
export async function completeSingle(store, over = {}) {
  const taskId = over.taskId ?? 'task-PRIOR001';
  const out = await runSingleReport({
    store,
    taskId,
    taskSlug: over.taskSlug ?? 'prior task',
    createdAt: over.createdAt ?? CREATED,
    invocationId: over.invocationId ?? `inv-${taskId}`,
    executionId: over.executionId ?? `exec-${taskId}`,
    profileId: over.profileId ?? 'live1-fake',
    backend: over.backend ?? 'fake',
    actorAlias: over.actorAlias ?? 'fake',
    instructions: over.instructions ?? 'do the prior task',
    reportBackend: over.reportBackend ?? fakeReportBackend({ text: over.text ?? `# ${taskId} report\n\nprior body\n` }),
    startedAt: over.startedAt ?? CREATED,
    complete: true,
  });
  return { taskId, finalRef: out.completion.finalRef, task: out.task, manifest: out.completion.manifest, out };
}

/** A counting report backend so a test can assert the provider was never called. */
export function countingBackend(inner) {
  const b = inner ?? fakeReportBackend({ text: '# target report\n\ntarget body\n' });
  let calls = 0;
  const prompts = [];
  return {
    get calls() { return calls; },
    get prompts() { return prompts; },
    get lastPrompt() { return prompts[prompts.length - 1] ?? null; },
    supportsDebateTypedControl: b.supportsDebateTypedControl ?? false,
    async runReport(a) { calls += 1; prompts.push(a?.prompt ?? null); return b.runReport(a); },
  };
}

/** Selector shorthands. */
export const REF = (reference) => ({ kind: 'ARTIFACT_REF', reference });
export const TASK_FINAL = (task_id) => ({ kind: 'TASK_FINAL', task_id });
export const LATEST_FINAL = () => ({ kind: 'LATEST_FINAL' });

export const TARGET_CREATED = '2026-09-11T09:00:00Z';
