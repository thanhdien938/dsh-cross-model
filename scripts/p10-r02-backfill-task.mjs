#!/usr/bin/env node
/**
 * P10-R0.2 Part X/AL — one-time (or re-runnable/idempotent) deterministic
 * repository-context backfill for an ALREADY-COMPLETED task, driven purely
 * from durable DSH state (`pm_requests`/`pm_runs`/`pm_turns`/`tasks` in a
 * runtime env's SQLite file, plus that env's `pm-profiles.yaml`).
 *
 * This is the SAME `materializeTaskHistory()` the production runtime calls
 * automatically post-task (src/runtime/production-pm-worker.mjs) — this
 * script exists only because the T1 task itself completed on an env that
 * predates the automatic wiring (P10-R0.1.2 build, before this wave). No
 * LLM/model call. Opens the source SQLite file READ-ONLY — this script can
 * never write to `.runtime/**`.
 *
 * Usage:
 *   node scripts/p10-r02-backfill-task.mjs \
 *     --env-root=.runtime/live1 \
 *     --task-id=task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz \
 *     --project-root="/path/to/project-repo"
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';

import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { materializeTaskHistory, readEventsJsonlSafe } from '../src/runtime/repo-history-materializer.mjs';
import { taskFolderName } from '../src/runtime/repo-history-id.mjs';
import { taskLogDir } from '../src/runtime/task-diagnostic-log.mjs';

// P10-R0.2.3: a defensive pre-flight guard, added after a real live T2
// backfill attempt computed a DIFFERENT folder name than the one the
// original run already created (a `createdAt` source-of-truth bug, fixed
// below) and nearly wrote a duplicate task folder before this check
// existed. Scans for any EXISTING `.materialized.json` for this exact
// `taskId` and refuses to proceed if the folder this run is ABOUT to
// compute would differ from it — Part X: "Do not create duplicate task
// folders" is enforced here, not just hoped for.
function findExistingFolderFor(projectRoot, taskId) {
  for (const modeDir of ['single', 'council']) {
    const base = join(projectRoot, 'docs', 'history', modeDir);
    if (!existsSync(base)) continue;
    for (const folder of readdirSync(base)) {
      const markerPath = join(base, folder, '.materialized.json');
      if (!existsSync(markerPath)) continue;
      try {
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (marker.task_id === taskId) return `${modeDir}/${folder}`;
      } catch { /* ignore an unreadable marker -- not this task's */ }
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readOnlyStore(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return {
    get(sql, params = []) { return db.prepare(sql).get(params); },
    all(sql, params = []) { return db.prepare(sql).all(params); },
    run() { throw new Error('read-only backfill store refuses writes'); },
    transactionSync() { throw new Error('read-only backfill store refuses writes'); },
    close() { db.close(); },
  };
}

function buildProfileResolver(profilesYamlPath) {
  if (!existsSync(profilesYamlPath)) return () => null;
  const doc = parseYaml(readFileSync(profilesYamlPath, 'utf8'));
  const byId = new Map((doc?.pm_profiles ?? []).map((p) => [p.id, p]));
  return (id) => byId.get(id) ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['env-root'] || !args['task-id'] || !args['project-root']) {
    console.error('usage: node scripts/p10-r02-backfill-task.mjs --env-root=<dir> --task-id=<task-...> --project-root=<absolute path>');
    process.exit(2);
  }
  const envRoot = resolve(args['env-root']);
  const taskId = args['task-id'];
  const projectRoot = resolve(args['project-root']);
  const sqlitePath = join(envRoot, 'state.sqlite');
  const profilesYamlPath = join(envRoot, 'pm-profiles.yaml');
  const eventsPath = join(taskLogDir(join(envRoot, 'logs', 'tasks'), taskId), 'events.jsonl');

  console.log(`[backfill] env-root=${envRoot}`);
  console.log(`[backfill] task-id=${taskId}`);
  console.log(`[backfill] project-root=${projectRoot}`);

  const store = readOnlyStore(sqlitePath);
  try {
    const taskRow = store.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!taskRow) throw new Error(`no durable task row for ${taskId} in ${sqlitePath}`);
    const envelope = JSON.parse(taskRow.envelope);
    const ownerCommandId = envelope.context?.ownerCommandId;
    if (!ownerCommandId) throw new Error(`task ${taskId} envelope has no context.ownerCommandId — cannot derive pm_run_id`);
    const pmRunId = deterministicOwnerId('pmrun', ownerCommandId);

    const pmRepository = new PmRepository({ store });
    const run = pmRepository.load(pmRunId);
    if (run.status !== 'completed') {
      console.error(`[backfill] REFUSED: pm_run ${pmRunId} status is '${run.status}', not 'completed' — Part T/AK-39 forbids auto-materializing a non-completed task.`);
      process.exit(1);
    }

    const councilCtx = envelope.context?.council ?? null;
    const taskMode = councilCtx ? 'COUNCIL' : 'SINGLE';
    const history = run.turns.map((t) => ({ turn: t.turnIndex, decision: t.decision, outcome: t.outcome }));
    const resolveProfile = buildProfileResolver(profilesYamlPath);
    const events = readEventsJsonlSafe(eventsPath);

    console.log(`[backfill] taskMode=${taskMode} pm_run_id=${pmRunId} turns=${history.length} events=${events.length}`);

    const resolvedCreatedAt = run.request.createdAt ?? envelope.createdAt ?? taskRow.created_at;
    const titleText = String(envelope.body ?? run.request.objective ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? taskId;
    const expectedFolder = `${taskMode === 'COUNCIL' ? 'council' : 'single'}/${taskFolderName({ taskId, createdAt: resolvedCreatedAt, titleText })}`;
    const existingFolder = findExistingFolderFor(projectRoot, taskId);
    if (existingFolder && existingFolder !== expectedFolder) {
      console.error(`[backfill] REFUSED: an existing materialized folder for ${taskId} was found at docs/history/${existingFolder}, but this run's resolved createdAt would compute a DIFFERENT folder (docs/history/${expectedFolder}) — refusing to write a duplicate. This means the createdAt evidence source disagrees with the original run; investigate before re-running.`);
      process.exit(1);
    }

    // P10-R0.2.3 bugfix: `createdAt` MUST be the PM_RUN's own request
    // creation time (`run.request.createdAt` — the SAME value production-
    // pm-worker.mjs's real terminal path passes as `run.request.createdAt`
    // when it calls materializeTaskHistory() automatically), NEVER the
    // separate AgentBus TASK envelope's `createdAt` (`envelope.createdAt`
    // above, a DIFFERENT durable timestamp — task acceptance time, not pm
    // run creation time). `taskFolderName()` embeds this timestamp
    // verbatim, so using the wrong one silently computes a DIFFERENT
    // folder name than the one the original live run already created —
    // live-caught on a real T2 backfill attempt (off by ~1 second),
    // which produced a genuine DUPLICATE task folder before this fix.
    const result = materializeTaskHistory({
      projectRoot, taskId, pmRunId, projectId: taskRow.project_id, taskMode,
      submittedVia: envelope.context?.channel ?? 'UNKNOWN', commandId: ownerCommandId,
      createdAt: resolvedCreatedAt, completedAt: run.completedAt, status: run.status,
      ownerTaskText: envelope.body ?? run.request.objective, pmProfileId: taskRow.pm_profile_id ?? null,
      council: councilCtx, history, finalOutput: run.output, finalData: run.data, resolveProfile, events,
    });

    console.log(`[backfill] status=${result.status} idempotent=${result.idempotent} historyPath=${result.historyPath}`);
    console.log(`[backfill] full path: ${join(projectRoot, ...result.historyPath.split('/'))}`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('[backfill] FAILED:', error?.stack ?? error);
  process.exit(1);
});
