#!/usr/bin/env node
// P12-R5B Part I/J/K/L — bounded operator recovery tool.
//
// Resolves ONE PM run stuck ACTION_STARTED with no durable outcome
// (`ACTION_RECONCILE_REQUIRED` — src/pm/durable-pm-runtime.mjs) after an
// unplanned runtime restart. This is recovery ADMINISTRATION, not a normal
// owner task-lifecycle operation (P12-R5B megaprompt Part L explicitly
// sanctions a bounded CLI for exactly this reason) — it must be run OFFLINE,
// with the DSH runtime process fully stopped, directly against the target
// environment's SQLite file (the same file `production.yaml`'s `sqlite.path`
// names). Never run this against a database a live runtime process has
// open.
//
// Usage:
//   node scripts/pm-reconcile-action.mjs <sqlite-path> <pm_run_id> <ABANDON|CONFIRM_NOT_APPLIED|CONFIRM_APPLIED> [--apply] [--note "..."]
//
// Without --apply this is a DRY RUN: it prints exactly what it would do and
// writes nothing. Pass --apply to actually perform the durable write.
//
// Refuses outright (never guesses, never bypasses the guard it exists to
// satisfy) for anything that is not genuinely eligible: an already-terminal
// run, or a run parked on a real AWAIT_OWNER interaction (a DIFFERENT
// recovery path — see the printed guidance).
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import {
  findReconcilableTurn, reconcilePendingAction, ReconciliationRefusedError, RECONCILE_RESOLUTIONS,
} from '../src/runtime/pm-action-reconciliation.mjs';

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const noteIndex = args.indexOf('--note');
  const note = noteIndex !== -1 ? args[noteIndex + 1] ?? '' : '';
  const [sqlitePath, pmRunId, resolution] = positional;

  if (!sqlitePath || !pmRunId || !resolution || !Object.values(RECONCILE_RESOLUTIONS).includes(resolution)) {
    console.error('usage: node scripts/pm-reconcile-action.mjs <sqlite-path> <pm_run_id> <ABANDON|CONFIRM_NOT_APPLIED|CONFIRM_APPLIED> [--apply] [--note "..."]');
    return 2;
  }

  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: sqlitePath });
    const pmRepository = new PmRepository({ store });

    let run;
    try {
      run = pmRepository.load(pmRunId);
    } catch (error) {
      console.error(`REFUSED: could not load PM run ${pmRunId}: ${error?.code ?? error?.message ?? 'unknown error'}`);
      return 1;
    }

    let turn;
    try {
      turn = findReconcilableTurn(run);
    } catch (error) {
      if (!(error instanceof ReconciliationRefusedError)) throw error;
      console.error(`REFUSED (${error.code}): ${error.message}`);
      if (error.code === 'PM_RUN_AWAITING_OWNER_NOT_RECONCILE_TARGET') {
        console.error(`Real owner interaction pending: ${error.interactionId}`);
        console.error('Answer it via Telegram/Desktop DECIDE_INTERACTION/REPLY_TO_INTERACTION, or REQUEST_CANCEL this task instead.');
      }
      return 1;
    }

    console.log('--- PM action reconciliation ---');
    console.log(`pm_run_id     : ${pmRunId}`);
    console.log(`objective     : ${String(run.request.objective ?? '').split(/\r?\n/)[0].slice(0, 200)}`);
    console.log(`turn_index    : ${turn.turnIndex}`);
    console.log(`action_type   : ${turn.actionType}`);
    console.log(`action_id     : ${turn.actionId}`);
    console.log(`current state : run.status=${run.status}, turn.phase=${turn.phase}`);
    console.log('reason        : action was started but never reached a durable outcome (no in-memory workflow/peer-relay result survives a restart)');
    console.log(`resolution    : ${resolution}${note ? ` — ${note}` : ''}`);
    console.log(`mode          : ${apply ? 'APPLY (writing now)' : 'DRY RUN (pass --apply to write)'}`);

    if (!apply) {
      console.log('Dry run complete. No durable state was changed.');
      return 0;
    }
    const result = reconcilePendingAction({ pmRepository, pmRunId, resolution, note });
    console.log(`APPLIED: pm_run ${pmRunId} is now durably terminal (status=failed, error.code=${result.outcome.error.code}).`);
    console.log('The next runtime start will reclaim this task\'s stale coordination claim as an already-terminal "adopted" run and release it — no replay, no crash.');
    return 0;
  } finally {
    await store.close();
  }
}

process.exitCode = await main();
