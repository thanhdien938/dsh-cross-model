import pg from 'pg';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { parse } from 'yaml';
import { TimelineEntry, Project, MultiTaskStatus, OwnerTaskDisplayState, InboxItem } from '../types';
import { getRepoRoot } from '../repoRoot';
import { importEsmModule } from '../dynamicImport';
import { BackendExecutionLogService } from './backendExecutionLogService';
import { ProjectionResult, okResult, errorResult, degradedResult } from './projectionResult';

const { Pool } = pg;

export class ReadProjection {
  private pgPool: pg.Pool | null = null;
  private sqliteDb: Database.Database | null = null;
  private projects: Project[] = [];
  // P15-REM-R3-D (P15-A-005): entries from the last project-list build that
  // could not be loaded (malformed repo_path, etc.) — additive, owner-
  // visible diagnostic metadata, never load-bearing for anything else.
  private projectLoadWarnings: Array<{ index: number; id: string | null; reason: string }> = [];

  // M02: same resolved config path main.ts passes to RuntimeSupervisor —
  // never recomputed independently here.
  constructor(
    private repoRoot: string,
    private configPathOverride: string = process.env.DSH_CONFIG_PATH ? path.resolve(process.env.DSH_CONFIG_PATH) : path.join(repoRoot, 'local-config.production.yaml'),
    // Part C: optional — when supplied, getBackendRuns() best-effort
    // enriches durable rows with still-in-memory ephemeral execution
    // details (cwd/model/exitCode/parserOutcome). Omitting it (every
    // existing caller/test) preserves prior behavior exactly.
    private execLogService: BackendExecutionLogService | null = null,
  ) {}

  async initialize(): Promise<void> {
    const configPath = this.configPathOverride;
    if (!fs.existsSync(configPath)) {
      throw new Error(`DSH config not found: ${configPath}`);
    }

    const config = parse(fs.readFileSync(configPath, 'utf8'));
    const configRoot = path.dirname(configPath);
    const dsnEnv = config.postgres?.dsn_env;
    const connectionString = typeof dsnEnv === 'string' ? process.env[dsnEnv] : undefined;
    if (!connectionString) throw new Error('PostgreSQL DSN is unavailable');

    const projectsPath = path.resolve(configRoot, config.projects_file);
    const projectDocument = parse(fs.readFileSync(projectsPath, 'utf8'));
    // P15-REM-R3-D (P15-A-005): one malformed project entry no longer
    // prevents Desktop from starting at all — every OTHER valid entry is
    // still loaded; a skipped entry is logged (never silently discarded
    // without a trace).
    const built = await buildProjectList(projectDocument, configRoot);
    this.projects = built.projects;
    this.projectLoadWarnings = built.skipped;
    for (const entry of built.skipped) console.error(`Project entry ${entry.id ?? `#${entry.index}`} could not be loaded and was skipped:`, entry.reason);

    // Create read-only PostgreSQL pool
    this.pgPool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // P14-R2.2 (docs/p14/audit/04_R22_...): node-postgres re-emits a
    // socket-level failure on an idle checked-in client as an 'error' event
    // on the Pool itself (see pg-pool's Client.idleListener). An EventEmitter
    // with no 'error' listener THROWS synchronously on that event — in the
    // Electron main process that surfaces as an uncaught exception and the
    // native "A JavaScript error occurred in the main process" crash dialog,
    // even though the underlying condition (e.g. the PostgreSQL server being
    // restarted/administratively terminated while Desktop is simply sitting
    // open) is a normal, recoverable database event, not a Desktop defect.
    // The runtime process's own two Pool owners already carry this exact
    // listener (src/coordination/postgres/postgres-coordination-store.mjs,
    // src/owner/postgres-owner-repository.mjs) — this closes the same gap
    // here. Logging (never swallowing) keeps an unexpected connection loss
    // diagnosable; the Pool self-heals its idle clients on the next query
    // (proven live: docs/p14/audit/04_R22_*.md Part E), so no reconnect
    // logic is needed here.
    this.pgPool.on('error', (error: Error & { code?: string }) => {
      console.error('PostgreSQL pool idle connection error (non-fatal, pool will reconnect on next query):', error.code ?? error.message);
    });

    // Open SQLite read-only
    const sqlitePath = path.resolve(configRoot, config.sqlite?.path);
    if (!fs.existsSync(sqlitePath)) {
      throw new Error('SQLite database not found');
    }

    this.sqliteDb = new Database(sqlitePath, {
      readonly: true,
      fileMustExist: true,
    });

    // Enable query_only pragma
    this.sqliteDb.pragma('query_only = ON');
  }

  async close(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }

    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
    }
  }

  // P15-REM-R3-G (Projects list, docs/p15-rem/04_*.md): the IPC handler
  // used to catch a not-initialized/throwing read down to `[]` —
  // indistinguishable from "no projects are configured." This still throws
  // when genuinely not initialized (the ORIGINAL signature/behavior — no
  // caller currently exists that expects a soft-fail here), but
  // `main.ts`'s `projects:list` handler now converts that into a typed
  // ProjectionResult instead of `[]`, so an empty project chooser can be
  // distinguished from a genuine read failure.
  async getProjects(): Promise<Project[]> {
    if (!this.pgPool || !this.sqliteDb) throw new Error('Projection not initialized');
    return this.projects.map(project => ({ ...project }));
  }

  // P15-REM-R3-D (P15-A-005): owner-visible warnings from the last
  // successful project-list build — entries that were skipped, and why.
  // Empty for the overwhelmingly common case (every entry loaded cleanly).
  getProjectLoadWarnings(): Array<{ index: number; id: string | null; reason: string }> {
    return this.projectLoadWarnings.map((w) => ({ ...w }));
  }

  // P7-R0.4 Part C/O: an explicit, owner-driven reload seam for the project
  // list ONLY — re-reads the SAME resolved production config path and the
  // SAME projects_file it names, exactly like initialize() does, but never
  // touches pgPool/sqliteDb (no PostgreSQL pool recreation, no SQLite
  // reopen — Part C requirement 6/7). No watcher, no polling: this is only
  // ever called from an explicit lifecycle event (a successful Add Folder,
  // or a runtime session reaching RUNNING — see main.ts), matching the R4.2
  // owner-driven-only refresh policy (Part N).
  //
  // Failure safety (Part O): on ANY failure (missing/unreadable config,
  // missing/malformed projects file, duplicate project ids), the PREVIOUS
  // `this.projects` is left completely untouched — the list is replaced
  // atomically only after the new one is fully built and validated, never
  // partially. This never affects runtime canonical truth (which is what
  // this file the projects_file for the SAME truth points to) — only this
  // process's read-only GUI projection of it.
  async reloadProjects(): Promise<{ ok: true; count: number; warnings?: Array<{ index: number; id: string | null; reason: string }> } | { ok: false; code: string; message: string }> {
    if (!this.pgPool || !this.sqliteDb) return { ok: false, code: 'PROJECT_RELOAD_NOT_INITIALIZED', message: 'ReadProjection is not initialized' };
    try {
      const configPath = this.configPathOverride;
      if (!fs.existsSync(configPath)) return { ok: false, code: 'PROJECT_RELOAD_CONFIG_MISSING', message: `DSH config not found: ${configPath}` };
      const config = parse(fs.readFileSync(configPath, 'utf8'));
      const configRoot = path.dirname(configPath);
      if (typeof config?.projects_file !== 'string') return { ok: false, code: 'PROJECT_RELOAD_CONFIG_INVALID', message: 'production config is missing projects_file' };
      const projectsPath = path.resolve(configRoot, config.projects_file);
      if (!fs.existsSync(projectsPath)) return { ok: false, code: 'PROJECT_RELOAD_FILE_MISSING', message: `projects file not found: ${projectsPath}` };
      const projectDocument = parse(fs.readFileSync(projectsPath, 'utf8'));
      // P15-REM-R3-D (P15-A-005): buildProjectList() itself is now resilient
      // per-entry (see its own docstring) — this method's OWN id/duplicate
      // validation below still applies WHOLE_FILE_FAIL_CLOSED (unchanged):
      // reload is an explicit owner-triggered action, and refusing to apply
      // a next-list with a broken id/duplicate is a deliberately stricter,
      // separate policy from the per-entry construction resilience above —
      // the previous list is left completely untouched on either kind of
      // failure.
      const built = await buildProjectList(projectDocument, configRoot);
      const next = built.projects;
      const seen = new Set<string>();
      for (const project of next) {
        if (typeof project.id !== 'string' || !project.id) return { ok: false, code: 'PROJECT_RELOAD_INVALID_ENTRY', message: 'a project entry is missing a valid id' };
        if (seen.has(project.id)) return { ok: false, code: 'PROJECT_RELOAD_DUPLICATE_ID', message: `duplicate project id: ${project.id}` };
        seen.add(project.id);
      }
      this.projects = next; // atomic replace — only reached once `next` is fully built and validated
      this.projectLoadWarnings = built.skipped;
      for (const entry of built.skipped) console.error(`Project entry ${entry.id ?? `#${entry.index}`} could not be loaded and was skipped:`, entry.reason);
      return built.skipped.length > 0 ? { ok: true, count: next.length, warnings: built.skipped } : { ok: true, count: next.length };
    } catch (error: any) {
      return { ok: false, code: 'PROJECT_RELOAD_FAILED', message: error?.message ?? 'unknown error' };
    }
  }

  // P15-REM-R3-G (P15-D-012, docs/p15-rem/04_*.md): a read failure here used
  // to collapse to `[]` — indistinguishable from "no activity yet," and
  // (since this merges PostgreSQL owner_command rows with SQLite bus_events
  // rows) a PostgreSQL-only failure previously discarded the SQLite rows
  // too even though they loaded fine. Now returns a typed ProjectionResult;
  // Timeline.tsx renders an explicit "could not load" state distinct from a
  // genuinely quiet project.
  async getTimeline(projectId: string | null, options: {
    limit?: number;
    category?: string;
    since?: string;
  } = {}): Promise<ProjectionResult<TimelineEntry[]>> {
    if (!this.pgPool || !this.sqliteDb) {
      return errorResult([], 'PROJECTION_TIMELINE_UNAVAILABLE', new Error('Projection not initialized'));
    }

    const limit = options.limit || 100;
    // M04: category filtering happens once, in JS, against the exact same
    // `category` value each entry is rendered with — never as a second,
    // independent SQL-level guess. The previous implementation only ever
    // added an *inclusion* filter for "its own" categories (client_kind for
    // Postgres, an event-name LIKE-prefix for SQLite) and otherwise ran
    // completely unfiltered, so selecting e.g. RESULT still returned every
    // USER_GUI/USER_TELEGRAM row (Postgres had no exclusion for non-user
    // categories) and, symmetrically, selecting USER_GUI returned every
    // PM/AGENT/RESULT/SYSTEM row too (SQLite had no exclusion for user
    // categories). The SQLite LIKE-prefix filter was also inconsistent with
    // timelineCategory()'s own substring-based classification (e.g. an
    // event named `pm.terminal.completed` classifies as RESULT below but
    // would never have matched `LIKE 'result%'`). Fetching a wider raw
    // window per store and filtering once against the real computed
    // category fixes both classes of bug with one source of truth.
    const requestedCategory = options.category && options.category !== 'ALL' ? options.category : null;
    const rawLimit = requestedCategory ? Math.max(limit * 5, limit) : limit;
    const entries: TimelineEntry[] = [];
    // P15-REM-R3-G: the PostgreSQL half (owner commands) and the SQLite
    // half (bus events) are independent sources — one failing must never
    // discard rows the other already loaded successfully.
    let pgFailed = false;
    let sqliteFailed = false;
    let sqliteRowsSkipped = 0;

    {
      // Postgres owner_command rows are always exactly USER_GUI or
      // USER_TELEGRAM — skip the query entirely for any other requested
      // category rather than fetching rows that could never match.
      if (!requestedCategory || isUserFacingCategory(requestedCategory)) try {
        let pgQuery = `
          SELECT
            command_id,
            project_id,
            client_kind,
            operation,
            payload,
            canonical_result,
            created_at,
            status
          FROM dsh_coordination.owner_command
          WHERE 1=1
        `;
        const pgParams: any[] = [];
        let paramIndex = 1;

        if (projectId) {
          pgQuery += ` AND project_id = $${paramIndex++}`;
          pgParams.push(projectId);
        }

        if (options.since) {
          pgQuery += ` AND created_at > $${paramIndex++}`;
          pgParams.push(options.since);
        }

        // A bare 'USER' meta-filter matches both client_kind values, so no
        // additional SQL filter is needed for it — only the two specific
        // single-source categories narrow further.
        if (requestedCategory === 'USER_TELEGRAM' || requestedCategory === 'USER_GUI') {
          const clientKind = requestedCategory === 'USER_TELEGRAM' ? 'TELEGRAM' : 'LOCAL';
          pgQuery += ` AND client_kind = $${paramIndex++}`;
          pgParams.push(clientKind);
        }

        pgQuery += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
        pgParams.push(rawLimit);

        const pgResult = await this.pgPool.query(pgQuery, pgParams);

        for (const row of pgResult.rows) {
          const payload = row.payload ?? {};
          const canonical = row.canonical_result ?? {};
          entries.push({
            timestamp: row.created_at,
            category: row.client_kind === 'TELEGRAM' ? 'USER_TELEGRAM' : 'USER_GUI',
            content: payload.body ?? payload.text ?? row.operation,
            projectId: row.project_id ?? undefined,
            taskId: canonical.task_id ?? undefined,
            commandId: row.command_id,
            metadata: { operation: row.operation, status: row.status },
          });
        }
      } catch (error) {
        pgFailed = true;
        console.error('Failed to fetch timeline (PostgreSQL owner_command rows):', error);
      }

      // bus_events rows can only ever classify as PM/AGENT/APPROVAL/
      // RESULT/SYSTEM (see timelineCategory()) — skip the query entirely
      // when a USER-facing category was requested.
      if (!requestedCategory || !isUserFacingCategory(requestedCategory)) try {
        let sqliteQuery = `
          SELECT
            b.event,
            b.task_id,
            b.agent,
            b.at,
            b.payload,
            t.project_id
          FROM bus_events b
          LEFT JOIN tasks t ON t.id = b.task_id
          WHERE 1=1
        `;
        const sqliteParams: any[] = [];

        if (projectId) {
          sqliteQuery += ` AND t.project_id = ?`;
          sqliteParams.push(projectId);
        }

        if (options.since) {
          sqliteQuery += ` AND b.at > ?`;
          sqliteParams.push(options.since);
        }

        sqliteQuery += ` ORDER BY b.at DESC LIMIT ?`;
        sqliteParams.push(rawLimit);

        const sqliteStmt = this.sqliteDb.prepare(sqliteQuery);
        interface SqliteTimelineRow {
          at: string;
          event: string;
          agent: string | null;
          task_id: string | null;
          payload: string | null;
          project_id: string | null;
        }

        const sqliteRows = sqliteStmt.all(...sqliteParams) as SqliteTimelineRow[];

        for (const row of sqliteRows) {
          // P15-REM-R3-G (row-level isolation): one malformed event payload
          // must never discard every other already-parsed row.
          try {
            const payload = row.payload ? JSON.parse(row.payload) : {};
            const category = timelineCategory(row.event);
            if (requestedCategory && category !== requestedCategory) continue;
            entries.push({
              timestamp: row.at,
              category,
              content: payload.output ?? payload.message ?? row.event,
              projectId: row.project_id ?? undefined,
              taskId: row.task_id ?? undefined,
              metadata: { event: row.event, agent: row.agent ?? undefined },
            });
          } catch {
            sqliteRowsSkipped += 1;
          }
        }
      } catch (error) {
        sqliteFailed = true;
        console.error('Failed to fetch timeline (SQLite bus_events rows):', error);
      }
    }

    // Sort by timestamp descending and limit
    entries.sort((a, b) => {
      const diff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (diff !== 0) return diff;
      // Tie-break by content for stability
      return a.content.localeCompare(b.content);
    });
    const limited = entries.slice(0, limit);

    if (pgFailed && sqliteFailed) return errorResult(limited, 'PROJECTION_TIMELINE_UNAVAILABLE', new Error('both PostgreSQL and SQLite timeline sources failed'));
    if (pgFailed) return degradedResult(limited, 'PROJECTION_TIMELINE_DEGRADED', new Error('PostgreSQL owner-command rows are unavailable — SQLite rows shown'));
    if (sqliteFailed) return degradedResult(limited, 'PROJECTION_TIMELINE_DEGRADED', new Error('SQLite bus-event rows are unavailable — PostgreSQL rows shown'));
    if (sqliteRowsSkipped > 0) return degradedResult(limited, 'PROJECTION_TIMELINE_DEGRADED', new Error(`${sqliteRowsSkipped} event row(s) could not be parsed`));
    return okResult(limited);
  }

  async getTasks(projectId: string | null): Promise<any[]> {
    if (!this.sqliteDb) {
      throw new Error('Projection not initialized');
    }

    try {
      let query = `SELECT id, status, envelope, project_id, created_at FROM tasks WHERE 1=1`;
      const params: any[] = [];

      if (projectId) {
        query += ` AND project_id = ?`;
        params.push(projectId);
      }

      query += ` ORDER BY created_at DESC LIMIT 100`;
      return (this.sqliteDb.prepare(query).all(...params) as any[]).map(row => {
        const envelope = JSON.parse(row.envelope);
        return {
          task_id: row.id,
          project_id: row.project_id,
          task_description: envelope.body ?? '',
          task_state: row.status,
          created_at: row.created_at,
        };
      });
    } catch (error: any) {
      console.error('Failed to fetch tasks:', error);
      return [];
    }
  }

  // P15-REM-R3-G (P15-D-015, docs/p15-rem/04_*.md): before this fix, ANY
  // failure here (a PG hiccup mid-loop, a malformed row) propagated
  // uncaught to `tasks:runtimeStatus`'s own catch, which returned `null` —
  // and MultiTaskControl.tsx's `if(!status)return null;` unmounted the
  // ENTIRE task-status pane, hiding every currently-running/queued/
  // awaiting-owner task from the owner. Now: the whole method never throws
  // (wrapped below), and one row's own lineage lookup failing skips only
  // that row (never discards the rows that DID resolve).
  async getMultiTaskStatus(runtime: any, terminalLimit = 30): Promise<ProjectionResult<MultiTaskStatus>> {
    const empty: MultiTaskStatus = { globalLimit: 0, activeCount: 0, queuedCount: 0, awaitOwnerCount: 0, observedAt: new Date().toISOString(), tasks: [] };
    if (!this.sqliteDb || !this.pgPool) return errorResult(empty, 'PROJECTION_TASK_STATUS_UNAVAILABLE', new Error('Projection not initialized'));
    try {
      const boundedTerminalLimit = Math.min(Math.max(terminalLimit, 0), 50);
      const runs = this.sqliteDb.prepare(`SELECT r.id,r.driver,r.status,r.pm_profile_id,r.started_at,r.completed_at,q.envelope FROM pm_runs r JOIN pm_requests q ON q.id=r.request_id WHERE r.status='running' OR r.id IN (SELECT id FROM pm_runs WHERE status IN ('completed','failed','cancelled') ORDER BY completed_at DESC,id DESC LIMIT ?) ORDER BY COALESCE(r.completed_at,r.started_at) DESC`).all(boundedTerminalLimit) as any[];
      const activeIds = new Set((runtime?.active ?? []).map((v: any) => String(v.work_item_id)));
      const reasons = new Map<string,string>((runtime?.rejected ?? []).map((v: any) => [String(v.work_item_id), String(v.reason)] as [string,string]));
      const tasks: any[] = [];
      let skipped = 0;
      for (const run of runs) {
        try {
          const lineage = await this.pgPool.query(`SELECT oc.project_id,oc.canonical_result->>'task_id' task_id,wi.work_item_id,wi.created_at queued_since,wi.claim_eligible,wi.parked_interaction_id,oi.status interaction_status FROM dsh_coordination.owner_command oc LEFT JOIN dsh_coordination.work_items wi ON wi.pm_run_id=$1 AND wi.work_kind='PM_ACTION' LEFT JOIN dsh_coordination.owner_interaction oi ON oi.interaction_id=wi.parked_interaction_id WHERE oc.operation='SUBMIT_TASK' AND oc.status='COMPLETED' AND oc.canonical_result->>'pm_run_id'=$1 LIMIT 1`,[run.id]);
          const link=lineage.rows[0]; if(!link?.task_id) continue;
          let envelope:any={}; try{envelope=JSON.parse(run.envelope??'{}');}catch{}
          const active=Boolean(link.work_item_id&&activeIds.has(String(link.work_item_id)));
          const awaiting=run.status==='running'&&link.claim_eligible===false&&Boolean(link.parked_interaction_id)&&link.interaction_status==='OPEN';
          const reason=link.work_item_id?reasons.get(String(link.work_item_id))??null:null;
          const displayState=projectOwnerTaskState({pmStatus:run.status,active,awaitingOwner:awaiting,waitingReason:reason});
          const project=this.projects.find(p=>p.id===link.project_id);
          const {mode,runtimeClass,durability}=projectTaskKind(envelope);
          let sqliteReconciliation:any=null;try{sqliteReconciliation=this.sqliteDb.prepare(`SELECT classification,repair_reason,repair_result,after_states,evidence_timestamps,created_at FROM reconciliation_audit WHERE task_id=? ORDER BY created_at DESC LIMIT 1`).get(link.task_id) as any;}catch{/* legacy read-only fixture: no reconciliation history yet */}
          let pgReconciliation:any=null;try{pgReconciliation=(await this.pgPool.query(`SELECT classification,repair_reason,repair_result,after_states,evidence_timestamps,created_at FROM dsh_coordination.reconciliation_audit WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`,[link.task_id])).rows[0]??null;}catch{/* pre-migration/read-role projection degrades to SQLite history */}
          const reconciliationRow = !sqliteReconciliation ? pgReconciliation : !pgReconciliation ? sqliteReconciliation : Date.parse(sqliteReconciliation.created_at)>=Date.parse(pgReconciliation.created_at) ? sqliteReconciliation : pgReconciliation;
          let reconciliation=null;
          if(reconciliationRow){let evidence:any=reconciliationRow.evidence_timestamps??{};if(typeof evidence==='string'){try{evidence=JSON.parse(evidence);}catch{evidence={};}}let after:any=reconciliationRow.after_states??{};if(typeof after==='string'){try{after=JSON.parse(after);}catch{after={};}}const observed=Date.parse(evidence.verifiedAt??evidence.observedAt??reconciliationRow.created_at);const repaired=reconciliationRow.repair_result==='APPLIED';reconciliation={indicator:repaired?'RECONCILED':'RECOVERY REQUIRED',classification:reconciliationRow.classification,affectedLayer:'DURABLE_BOOKKEEPING',reason:reconciliationRow.repair_reason,ageMs:Number.isFinite(observed)?Math.max(0,Date.now()-observed):null,resourceImpact:after.__projection?.resourceImpact??'NONE',safeAllowedActions:Array.isArray(after.__projection?.safeAllowedActions)?after.__projection.safeAllowedActions:[]};}
          tasks.push({taskId:link.task_id,projectId:link.project_id??null,projectName:project?.name??link.project_id??null,pmRunId:run.id,profileId:run.pm_profile_id??null,backend:String(run.driver??'').split(':')[1]||String(run.driver??'')||null,mode,runtimeClass,durability,displayState,waitingReason:displayState.startsWith('WAITING')?reason:null,startedAt:active?run.started_at:null,queuedSince:!active&&!awaiting&&run.status==='running'?(link.queued_since??run.started_at):null,elapsedSince:active?run.started_at:(!awaiting&&run.status==='running'?(link.queued_since??run.started_at):run.completed_at??run.started_at),cancellable:canonicalTaskCancellable(run.status),reconciliation});
        } catch (rowError) {
          skipped += 1;
          console.error(`Failed to project multi-task-status row for pm_run ${run.id}:`, rowError);
        }
      }
      const {activeCount,queuedCount,awaitOwnerCount}=summarizeOwnerTasks(tasks);
      const status: MultiTaskStatus = {globalLimit:Number.isInteger(runtime?.global_limit)?runtime.global_limit:0,activeCount,queuedCount,awaitOwnerCount,observedAt:new Date(runtime?.observed_at??Date.now()).toISOString(),tasks};
      return skipped > 0 ? degradedResult(status, 'PROJECTION_TASK_STATUS_DEGRADED', new Error(`${skipped} task row(s) could not be projected`)) : okResult(status, () => false);
    } catch (error) {
      console.error('Failed to project multi-task status:', error);
      return errorResult(empty, 'PROJECTION_TASK_STATUS_UNAVAILABLE', error);
    }
  }

  // W3-C Backend Runs inspector. Only safe, already-sanitized fields per
  // run: product/driver, project/task lineage (resolved via the same
  // owner_command.canonical_result linkage OwnerTerminalResultNotifier
  // already uses), model when known, timestamps/duration, status, and a
  // sanitized final output/error. Uses the real production
  // sanitizeOperatorOutput() (src/runtime/operator-control-service.mjs)
  // rather than a second redaction implementation. No raw environment, no
  // full argv, no secrets.
  // P15-REM-R3-G (P14-A4-001, docs/p15-rem/04_*.md): `run.error`'s
  // JSON.parse() used to sit OUTSIDE any per-row try/catch — one run with a
  // malformed `error` column threw out of the `for` loop entirely, discarding
  // every ALREADY-COLLECTED healthy row (the outer catch returned `[]`,
  // rendered as "No backend runs yet."). Every row is now independently
  // isolated: a row that fails to project is skipped and counted, never
  // silently dropped without a trace, and never allowed to erase the rows
  // that DID parse correctly.
  async getBackendRuns(projectId: string | null, options: { limit?: number; status?: string } = {}): Promise<ProjectionResult<any[]>> {
    if (!this.sqliteDb || !this.pgPool) return errorResult([], 'PROJECTION_BACKEND_RUNS_UNAVAILABLE', new Error('Projection not initialized'));
    try {
      const limit = Math.min(options.limit ?? 50, 200);
      let query = `SELECT id, driver, status, output, error, data, pm_profile_id, request_id, started_at, completed_at FROM pm_runs`;
      const params: any[] = [];
      if (options.status) {
        query += ` WHERE status = ?`;
        params.push(options.status);
      }
      query += ` ORDER BY COALESCE(completed_at, started_at) DESC LIMIT ?`;
      params.push(limit);
      const runs = this.sqliteDb.prepare(query).all(...params) as any[];

      const { sanitizeOperatorOutput } = await importEsmModule(path.join(getRepoRoot(), 'src', 'runtime', 'operator-control-service.mjs'));

      const results = [];
      let skipped = 0;
      for (const run of runs) {
        try {
          const lineage = await this.pgPool.query(
            `SELECT project_id, canonical_result->>'task_id' AS task_id FROM dsh_coordination.owner_command WHERE operation = 'SUBMIT_TASK' AND status = 'COMPLETED' AND canonical_result->>'pm_run_id' = $1 LIMIT 1`,
            [run.id],
          );
          const row = lineage.rows[0];
          if (projectId && row?.project_id !== projectId) continue;
          // Part C: best-effort only — `driver` is formatted
          // "production:<product>:<profileId>" (see
          // production-pm-backend-registry.mjs's createCliPmDriver name);
          // `request_id` is the same id BackendExecutionObserver stamps as
          // `runId` on every event for this execution, so a still-in-memory
          // match backfills debugging-only fields the durable pm_runs row
          // itself never stores (cwd/model/exitCode/parserOutcome). Absent
          // when the ephemeral buffer no longer holds this run (older run,
          // or after a runtime restart) — never a schema addition.
          const product = String(run.driver ?? '').split(':')[1] ?? null;
          const enrichment = this.execLogService && product ? this.execLogService.findByRunId(product, run.request_id ?? null) : null;
          // P12-R2: `data.dsh_outcome` (pm-repository.mjs's recordTaskOutcome()
          // — reserved key on the ALREADY-SELECTED `data` column, no schema
          // change) is the durable six-dimension outcome. Absent for every
          // run that predates P12 or never had it recorded — `null`, never
          // fabricated. Parsed defensively: a corrupt/missing `data` column
          // must never break this whole projection call.
          let dshOutcome: unknown = null;
          try {
            const parsedData = run.data ? JSON.parse(run.data) : null;
            if (parsedData && typeof parsedData === 'object' && parsedData.dsh_outcome) dshOutcome = sanitizeOperatorOutput(parsedData.dsh_outcome);
          } catch { /* a corrupt data column must never break this projection */ }
          // P15-REM-R3-H: `error` (this run's own REM-R2 durable terminal
          // failure cause where present) is parsed defensively too — a
          // malformed `pm_runs.error` column must degrade THIS ROW ONLY,
          // never the whole projection (P14-A4-001).
          let sanitizedError: unknown = null;
          if (run.status === 'failed') {
            try { sanitizedError = sanitizeOperatorOutput(run.error ? JSON.parse(run.error) : null); }
            catch { sanitizedError = { code: 'PROJECTION_ROW_ERROR_UNREADABLE', message: 'this run\'s recorded error could not be parsed' }; }
          }
          results.push({
            runId: run.id,
            product: run.driver,
            pmProfileId: run.pm_profile_id,
            projectId: row?.project_id ?? null,
            taskId: row?.task_id ?? null,
            status: run.status,
            startedAt: run.started_at,
            completedAt: run.completed_at,
            durationMs: run.started_at && run.completed_at ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime() : null,
            output: run.status === 'completed' ? sanitizeOperatorOutput(run.output ?? null) : null,
            error: sanitizedError,
            cwd: enrichment?.cwd ?? null,
            model: enrichment?.model ?? null,
            exitCode: enrichment?.exitCode ?? null,
            parserOutcome: enrichment?.parserOutcome ?? null,
            dshOutcome,
          });
        } catch (rowError) {
          skipped += 1;
          console.error(`Failed to project backend run row ${run?.id}:`, rowError);
        }
      }
      return skipped > 0 ? degradedResult(results, 'PROJECTION_BACKEND_RUNS_DEGRADED', new Error(`${skipped} run row(s) could not be projected`)) : okResult(results);
    } catch (error) {
      console.error('Failed to fetch backend runs:', error);
      return errorResult([], 'PROJECTION_BACKEND_RUNS_UNAVAILABLE', error);
    }
  }

  // P7 Part M/M1: the Council panel is a read-ONLY projection over the SAME
  // durable pm_runs/pm_turns rows getBackendRuns() already reads (a council
  // is still just one PmRun — see src/pm/council/council-contracts.mjs). It
  // reuses the REAL production PmRepository.load()/projectCouncil() via
  // importEsmModule (the established cross-boundary reuse seam this file
  // already uses for sanitizeOperatorOutput above) rather than re-deriving
  // pm_turns state-machine logic a second time here. `store` is a thin
  // read-only adapter over the already-open better-sqlite3 handle —
  // transactionSync() is never reachable from load(), only asserted present
  // by PmRepository's constructor.
  private async pmRepository(): Promise<any | null> {
    if (!this.sqliteDb) return null;
    const { PmRepository } = await importEsmModule(path.join(getRepoRoot(), 'src', 'persistence', 'repositories', 'pm-repository.mjs'));
    const db = this.sqliteDb;
    const store = {
      get: (sql: string, params: any[] = []) => db.prepare(sql).get(...params),
      all: (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
      run: (sql: string, params: any[] = []) => db.prepare(sql).run(...params),
      transactionSync: () => { throw new Error('ReadProjection is read-only'); },
    };
    return new PmRepository({ store });
  }

  async getCouncil(pmRunId: string): Promise<ProjectionResult<any | null>> {
    if (!this.sqliteDb) return errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE', new Error('Projection not initialized'));
    try {
      const repository = await this.pmRepository();
      if (!repository) return errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE', new Error('Council repository unavailable'));
      const { isCouncilRun, projectCouncil } = await importEsmModule(path.join(getRepoRoot(), 'src', 'pm', 'council', 'council-projection.mjs'));
      const run = repository.load(pmRunId);
      if (!isCouncilRun(run)) return okResult(null, (value) => value === null);
      return okResult(projectCouncil(run), (value) => value === null);
    } catch (error) {
      console.error('Failed to project council state:', error);
      return errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE', error);
    }
  }

  // Best-effort list of recent council runs for the given project (or all
  // projects when null), newest first — the Council panel's list surface
  // (Part M). The `LIKE` prefilter is a cheap, safe heuristic (the literal
  // key only ever appears in a durable council pm_request's JSON envelope);
  // every candidate is still verified via the real isCouncilRun() check
  // below before being projected or returned.
  async getCouncilRuns(projectId: string | null, options: { limit?: number } = {}): Promise<ProjectionResult<any[]>> {
    if (!this.sqliteDb || !this.pgPool) return errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE', new Error('Projection not initialized'));
    try {
      const limit = Math.min(options.limit ?? 20, 100);
      const repository = await this.pmRepository();
      if (!repository) return errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE', new Error('Council repository unavailable'));
      const { isCouncilRun, projectCouncil } = await importEsmModule(path.join(getRepoRoot(), 'src', 'pm', 'council', 'council-projection.mjs'));
      const rows = this.sqliteDb
        .prepare(`SELECT r.id AS pm_run_id FROM pm_runs r JOIN pm_requests q ON q.id = r.request_id WHERE q.envelope LIKE '%"council"%' ORDER BY COALESCE(r.completed_at, r.started_at) DESC LIMIT ?`)
        .all(limit * 3) as { pm_run_id: string }[]; // over-fetch: some LIKE matches may be non-council or off-project
      const results: any[] = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        let run: any;
        try { run = repository.load(row.pm_run_id); } catch { continue; }
        if (!isCouncilRun(run)) continue;
        const lineage = await this.pgPool.query(
          `SELECT project_id, canonical_result->>'task_id' AS task_id FROM dsh_coordination.owner_command WHERE operation = 'SUBMIT_TASK' AND status = 'COMPLETED' AND canonical_result->>'pm_run_id' = $1 LIMIT 1`,
          [run.id],
        );
        const lineageRow = lineage.rows[0];
        if (projectId && lineageRow?.project_id !== projectId) continue;
        results.push({ ...projectCouncil(run), projectId: lineageRow?.project_id ?? null, taskId: lineageRow?.task_id ?? null });
      }
      return okResult(results);
    } catch (error) {
      console.error('Failed to fetch council runs:', error);
      return errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE', error);
    }
  }

  // Part B/C: BackendExecutionObserver only ever knows `runId` (the PM
  // request id) — the durable task id is not resolvable at the PM
  // decide() layer itself (it only exists via the Postgres owner_command
  // ↔ pm_runs join used above). This is the same two-hop lookup
  // getBackendRuns() already does per row, exposed standalone so the
  // live execLogs:statuses IPC handler can backfill a still-running (not
  // yet in pm_runs as completed) or already-terminal run's taskId/
  // projectId for display, without duplicating the join logic.
  async resolveTaskLineageByRequestId(requestId: string | null): Promise<{ taskId: string | null; projectId: string | null } | null> {
    if (!requestId || !this.sqliteDb || !this.pgPool) return null;
    try {
      const run = this.sqliteDb.prepare(`SELECT id FROM pm_runs WHERE request_id = ? LIMIT 1`).get(requestId) as { id: string } | undefined;
      if (!run) return null;
      const lineage = await this.pgPool.query(
        `SELECT project_id, canonical_result->>'task_id' AS task_id FROM dsh_coordination.owner_command WHERE operation = 'SUBMIT_TASK' AND canonical_result->>'pm_run_id' = $1 LIMIT 1`,
        [run.id],
      );
      const row = lineage.rows[0];
      if (!row) return null;
      return { taskId: row.task_id ?? null, projectId: row.project_id ?? null };
    } catch (error) {
      console.error('Failed to resolve task lineage by request id:', error);
      return null;
    }
  }

  // Read-only, terminal-only PM run facts for W2-O auth-evidence scanning.
  // Never claims to be provider auth truth; only surfaces exactly the
  // canonical status/error the runtime already recorded.
  async getRecentTerminalPmRuns(limit = 50): Promise<{ pmProfileId: string | null; product: string; status: string; error: unknown }[]> {
    if (!this.sqliteDb) return [];
    try {
      const rows = this.sqliteDb
        .prepare(`SELECT pm_profile_id, driver, status, error FROM pm_runs WHERE status IN ('completed','failed') ORDER BY completed_at DESC LIMIT ?`)
        .all(limit) as { pm_profile_id: string | null; driver: string; status: string; error: string | null }[];
      return rows.map((row) => ({
        pmProfileId: row.pm_profile_id,
        product: row.driver,
        status: row.status,
        error: row.error ? JSON.parse(row.error) : null,
      }));
    } catch (error) {
      console.error('Failed to fetch terminal PM runs:', error);
      return [];
    }
  }

  // P15-REM-R3-F (P15-D-014, docs/p15-rem/04_*.md): the highest-priority
  // projection fix. This used to catch ANY read failure (including a real
  // PostgreSQL outage) down to a bare `[]` — structurally identical to "no
  // approval is pending." A real pending approval could therefore vanish
  // from the owner's view the instant PostgreSQL became unreachable, with
  // no error shown anywhere. The critical invariant this fixes: PENDING
  // APPROVAL UNKNOWN must never render as NO PENDING APPROVAL. On failure
  // this now returns `status:'ERROR'` with an explicit, sanitized cause —
  // ApprovalPanel (desktop/src/components/ApprovalPanel.tsx) renders that
  // as an explicit "could not load" state, never as an empty inbox, and
  // never infers or applies any decision on the owner's behalf.
  async getInbox(projectId: string | null): Promise<ProjectionResult<InboxItem[]>> {
    if (!this.pgPool) {
      return errorResult([], 'PROJECTION_APPROVALS_UNAVAILABLE', new Error('Projection not initialized'));
    }

    try {
      let query = `
        SELECT
          interaction_id,
          project_id,
          task_id,
          origin,
          kind,
          title,
          prompt_text,
          allowed_responses,
          revision,
          requires_response,
          status,
          created_at
        FROM dsh_coordination.owner_interaction
        WHERE requires_response = true AND status = 'OPEN'
      `;
      const params: any[] = [];

      if (projectId) {
        query += ` AND project_id = $1`;
        params.push(projectId);
      }

      query += ` ORDER BY created_at ASC`;

      const result = await this.pgPool.query(query, params);
      // pg returns bigint columns as strings by default. Owner mutations
      // require a JavaScript safe integer for expected_revision, so the
      // approval projection must cross that boundary explicitly instead
      // of relying on its TypeScript annotation at runtime.
      const rows = result.rows.map((row) => ({
        ...row,
        revision: Number(row.revision),
        allowed_responses: row.allowed_responses ?? [],
      }));
      return okResult(rows);
    } catch (error: any) {
      console.error('Failed to fetch inbox:', error);
      return errorResult([], 'PROJECTION_APPROVALS_UNAVAILABLE', error);
    }
  }
}

export function projectOwnerTaskState(input:{pmStatus:string;active:boolean;awaitingOwner:boolean;waitingReason:string|null}):OwnerTaskDisplayState {
  if(input.pmStatus==='completed')return 'COMPLETED'; if(input.pmStatus==='failed')return 'FAILED'; if(input.pmStatus==='cancelled')return 'CANCELLED';
  if(input.awaitingOwner)return 'AWAITING OWNER'; if(input.active)return 'RUNNING';
  const map:Record<string,OwnerTaskDisplayState>={RESOURCE_PRESSURE:'WAITING — RESOURCE PRESSURE',GLOBAL_CAPACITY:'WAITING — GLOBAL CAPACITY',WORKSPACE_CAPACITY:'WAITING — WORKSPACE BUSY',WORKSPACE_BUSY:'WAITING — WORKSPACE BUSY',BACKEND_CAPACITY:'WAITING — BACKEND CAPACITY'};
  return map[input.waitingReason??'']??'WAITING — OTHER';
}
export function summarizeOwnerTasks(tasks:Array<{displayState:string}>){return {activeCount:tasks.filter(t=>t.displayState==='RUNNING').length,queuedCount:tasks.filter(t=>t.displayState.startsWith('WAITING')).length,awaitOwnerCount:tasks.filter(t=>t.displayState==='AWAITING OWNER').length};}
export function canonicalTaskCancellable(pmStatus:string){return !['completed','failed','cancelled'].includes(pmStatus);}

// P13-R7.1 (docs/p13/15A_*.md): the canonical task-kind projection, fixed
// out of a real R7 live defect -- LONG tasks displayed NORMAL, and a
// Council outer task displayed SINGLE. `envelope` here is the FULL,
// parsed `pm_requests.envelope` JSON (createPmRequest()'s own
// `{id,objective,context,createdAt}` shape, src/pm/pm-contracts.mjs --
// the exact same durable object the runtime layer reads as
// `run.request.context.*`, e.g. production-pm-worker.mjs's
// `run.request.context?.council`/`task.context?.runtimeClass`). The
// pre-fix code read `envelope.council` and `envelope.runtime_class` --
// TOP-LEVEL, un-nested, and (for runtimeClass) wrong-cased -- which never
// existed on this object and were therefore always `undefined`,
// silently collapsing every task to `SINGLE`/`NORMAL`/the `durability`
// fallback regardless of its real, already-durable value. The fix reads
// the SAME nested `.context` object the runtime itself uses as the
// canonical source, inferring nothing from backend/profile strings.
export function projectTaskKind(envelope:any):{mode:'SINGLE'|'COUNCIL';runtimeClass:string|null;durability:string}{
  const context=envelope&&typeof envelope==='object'?envelope.context:null;
  return {
    mode:context&&context.council?'COUNCIL':'SINGLE',
    runtimeClass:typeof context?.runtimeClass==='string'?context.runtimeClass:null,
    durability:typeof context?.durability==='string'?context.durability:'DIRECT',
  };
}

// Extracted for direct unit testing (desktop/tests/readProjection.test.ts)
// without needing a full Postgres/SQLite ReadProjection.initialize().
// A project whose configured directory is not currently present degrades
// to PATH_MISSING rather than being dropped from the list or silently
// repointed — every other project stays READY. This mirrors the same
// path_missing determination the runtime's production config loader makes
// (src/runtime/p5-production-config.mjs); the Desktop computes its own
// copy here because it reads projects.yaml directly, independent of
// whether the runtime is currently running.
// P12-R5A Part P/A: async so `pushRemotePolicy` can be derived via the
// SAME `normalizeAutonomyEnvelope()` the runtime actually enforces
// (production-pm-worker.mjs's isPushAuthorized()) — reused live via
// importEsmModule (the established cross-boundary seam this file already
// uses for sanitizeOperatorOutput()/PmRepository/council-projection
// below), never re-implemented in TypeScript where it could drift.
// P12-R5A: the pure, dependency-free half of the PUSH_REMOTE projection —
// directly unit-testable without touching dynamic ESM import at all
// (importEsmModule's `new Function('specifier','return import(specifier)')`
// indirection, needed so tsc's CommonJS output for the packaged app never
// rewrites it to `require()`, has no working dynamic-import callback under
// this project's test runner — the same pre-existing, already-tolerated
// limitation backendExecutionLogService.ts's "Failed to load supported
// backend product list" fallback comes from). Takes ALREADY-normalized
// `effects` (whatever normalizeAutonomyEnvelope().effects produced) so it
// never re-implements that normalization itself.
export function mapPushRemoteEffectToPolicy(effects: Record<string, string> | null | undefined): Project['pushRemotePolicy'] {
  const mode = effects?.PUSH_REMOTE ?? 'FORBID';
  return mode === 'FORBID' || mode === 'APPROVAL' || mode === 'ALLOW' ? mode : 'UNKNOWN';
}

// P15-REM-R3-D (P15-A-005, docs/p15-rem/04_*.md): policy chosen —
// PARTIAL_VALID_WITH_EXPLICIT_ERRORS. Before this fix, `.map()` over the raw
// project entries meant ONE malformed entry (e.g. a non-string `repo_path`,
// which throws inside `path.resolve()`) threw out of the whole array
// construction, discarding every OTHER, perfectly valid project — Desktop's
// entire project list (and, via initialize(), potentially Desktop's own
// startup) collapsed to nothing over one bad row. Each entry is now built
// independently; one failing is skipped (and reported via `skipped`,
// consumed by initialize()/reloadProjects() for logging/owner-visible
// warnings) rather than erasing the entries that DID build successfully.
// WHOLE_FILE_FAIL_CLOSED is deliberately NOT used here — nothing about this
// config format requires atomic all-or-nothing acceptance, and the owner
// losing visibility into every healthy project over one typo is a worse
// outcome than showing N-1 real projects plus an explicit warning.
export interface BuildProjectListResult {
  projects: Project[];
  skipped: Array<{ index: number; id: string | null; reason: string }>;
}

export async function buildProjectList(projectDocument: { projects?: any[] }, configRoot: string): Promise<BuildProjectListResult> {
  // The dynamic import itself (not just normalization) can fail — e.g.
  // under a test runner whose VM sandbox has no dynamic-import callback
  // (see mapPushRemoteEffectToPolicy()'s docstring above). Every project
  // then projects as 'UNKNOWN' rather than the whole project list failing
  // to load — this field is informational (Part P), never load-bearing
  // for anything else buildProjectList already returns.
  let normalizeAutonomyEnvelope: ((input: any) => { effects: Record<string, string> }) | null = null;
  try {
    ({ normalizeAutonomyEnvelope } = await importEsmModule<{ normalizeAutonomyEnvelope: (input: any) => { effects: Record<string, string> } }>(
      path.join(getRepoRoot(), 'src', 'owner', 'autonomy-envelope.mjs'),
    ));
  } catch {
    normalizeAutonomyEnvelope = null;
  }
  const rawEntries = projectDocument.projects ?? [];
  const projects: Project[] = [];
  const skipped: Array<{ index: number; id: string | null; reason: string }> = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const project = rawEntries[index];
    try {
      const absolutePath = path.resolve(configRoot, project.repo_path);
      let pushRemotePolicy: Project['pushRemotePolicy'] = 'UNKNOWN';
      try {
        if (normalizeAutonomyEnvelope) pushRemotePolicy = mapPushRemoteEffectToPolicy(normalizeAutonomyEnvelope(project.autonomy).effects);
      } catch {
        // A malformed/missing autonomy block projects as UNKNOWN, never a
        // guessed specific level (never ALLOW/APPROVAL by default) — the
        // real runtime enforcement point (isPushAuthorized) separately and
        // independently defaults an absent PUSH_REMOTE entry to FORBID, so
        // this can only ever under-promise, never over-promise, relative to
        // what actually gets enforced.
      }
      projects.push({
        id: project.id,
        name: project.display_name ?? project.id,
        path: absolutePath,
        state: isUsableDirectory(absolutePath) ? 'READY' : 'PATH_MISSING',
        pushRemotePolicy,
      });
    } catch (error: any) {
      skipped.push({ index, id: typeof project?.id === 'string' ? project.id : null, reason: error?.message ?? 'unknown error' });
    }
  }
  return { projects, skipped };
}

function isUsableDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Exported for direct unit testing (desktop/tests/timelineFilter.test.ts)
// without needing a real Postgres/SQLite ReadProjection. The Timeline UI's
// "USER" filter button is a meta-category standing in for both USER_GUI
// and USER_TELEGRAM at once — it is not itself a value any entry's
// `category` field ever takes.
export function isUserFacingCategory(value: string): boolean {
  return value === 'USER' || value === 'USER_TELEGRAM' || value === 'USER_GUI';
}

export function timelineCategory(event: string): TimelineEntry['category'] {
  const normalized = event.toLowerCase();
  if (normalized.includes('result') || normalized.includes('completed')) return 'RESULT';
  if (normalized.includes('pm')) return 'PM';
  if (normalized.includes('approval')) return 'APPROVAL';
  if (normalized.includes('agent') || normalized.includes('run')) return 'AGENT';
  return 'SYSTEM';
}
