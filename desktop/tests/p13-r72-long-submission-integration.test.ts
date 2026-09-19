import { afterEach, describe, expect, it } from 'vitest';
// Use the root runtime's native binding: Desktop's packaged binding targets
// Electron's ABI and is intentionally not loadable in the host Node test VM.
// @ts-ignore
import Database from '../../node_modules/better-sqlite3/lib/index.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReadProjection } from '../electron/main/services/readProjection';
// The production runtime is ESM JavaScript; Vitest executes these exact modules.
// @ts-ignore
import { SqlitePersistenceStore } from '../../src/persistence/sqlite/sqlite-persistence-store.mjs';
// @ts-ignore
import { AgentBusRepository } from '../../src/persistence/repositories/agentbus-repository.mjs';
// @ts-ignore
import { PmRepository } from '../../src/persistence/repositories/pm-repository.mjs';
// @ts-ignore
import { OwnerTaskController } from '../../src/owner/owner-task-controller.mjs';
// @ts-ignore
import { OwnerControlService } from '../../src/owner/owner-control-service.mjs';
// @ts-ignore
import { createPmRequest } from '../../src/pm/pm-contracts.mjs';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

function journal() {
  const completed = new Map<string, any>();
  return {
    async beginCommand(command: any) { return completed.get(command.command_id) ?? { status: 'ACCEPTED', created_at: command.created_at }; },
    async completeCommand(id: string, result: any) { const value = { status: 'COMPLETED', canonical_result: result }; completed.set(id, value); return value; },
  };
}

describe('P13-R7.2 LONG submission -> persistence -> Desktop projection', () => {
  it('preserves LONG/SINGLE/DURABLE_LOCAL while NORMAL and COUNCIL remain independent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-r72-long-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = await new SqlitePersistenceStore().open({ path: dbPath });
    await store.migrate();
    disposers.push(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
    const bus = new AgentBusRepository({ store });
    const pm = new PmRepository({ store });
    const lineages = new Map<string, { taskId: string; projectId: string; workItemId: string }>();
    const controller = new OwnerTaskController({
      repository: bus,
      startPm: async ({ task, project, pmProfileId, pmRunId }: any) => {
        const request = createPmRequest({ id: `request-${pmRunId}`, objective: task.body, context: task.context });
        pm.create(request, { id: pmRunId, driver: `production:codex:${pmProfileId}`, startedAt: new Date().toISOString(), pmProfileId, pmProfileFingerprint: null });
        lineages.set(pmRunId, { taskId: task.id, projectId: project.id, workItemId: `work-${pmRunId}` });
        return { pmRunId };
      },
    });
    const profiles = [{ id: 'pm-1', status: 'ACTIVE' }, { id: 'pm-2', status: 'ACTIVE' }];
    const project = { id: 'project-a', name: 'Project A', repo_path: root, default_pm_profile_id: 'pm-1', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    const service = new OwnerControlService({ repository: journal(), taskController: controller, projects: [project], pmProfiles: profiles });
    const submit = (commandId: string, payload: any) => service.mutate({ command_id: commandId, actor_id: '100000001', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: project.id, payload });

    await submit('long', { body: 'resolved task file', pm_profile_id: 'pm-1', task_source: { type: 'GIT_FILE', requestedRef: 'main', resolvedCommitSha: 'a'.repeat(40), path: 'tasks/dsh/LONG.md', contentSha256: 'b'.repeat(64), contentBytes: 18 }, durability: 'DURABLE_LOCAL' });
    await submit('normal', { body: 'normal task', pm_profile_id: 'pm-1' });
    await submit('council', { body: 'council task', pm_profile_id: 'pm-1', council: { chair_profile_id: 'pm-1', participant_profile_ids: ['pm-2'], rounds: 1 } });

    const projection = new ReadProjection(root) as any;
    projection.sqliteDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    projection.projects = [{ id: project.id, name: project.name }];
    projection.pgPool = { query: async (_sql: string, [pmRunId]: [string]) => {
      const link = lineages.get(pmRunId)!;
      return { rows: [{ project_id: link.projectId, task_id: link.taskId, work_item_id: link.workItemId, queued_since: new Date().toISOString(), claim_eligible: true, parked_interaction_id: null, interaction_status: null }] };
    } };
    disposers.push(() => projection.sqliteDb.close());
    const active = [...lineages.values()].map((v) => ({ work_item_id: v.workItemId }));
    // P15-REM-R3-G (P15-D-015): getMultiTaskStatus() now returns a typed
    // ProjectionResult — unwrap `.data`.
    const result = await projection.getMultiTaskStatus({ global_limit: 2, active, rejected: [], observed_at: new Date().toISOString() });
    expect(result.status).toBe('OK');
    const kinds = Object.fromEntries(result.data.tasks.map((task: any) => [task.taskId, { mode: task.mode, runtimeClass: task.runtimeClass, durability: task.durability }]));
    expect(Object.values(kinds)).toContainEqual({ mode: 'SINGLE', runtimeClass: 'LONG', durability: 'DURABLE_LOCAL' });
    expect(Object.values(kinds)).toContainEqual({ mode: 'SINGLE', runtimeClass: 'NORMAL', durability: 'DIRECT' });
    expect(Object.values(kinds)).toContainEqual({ mode: 'COUNCIL', runtimeClass: 'NORMAL', durability: 'DIRECT' });
  });
});
