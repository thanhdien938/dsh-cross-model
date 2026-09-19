import {hostname} from 'node:os';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {parse} from 'yaml';
import {loadReconciledTelegramAliases} from '../owner/telegram-alias-reconciler.mjs';
import {deterministicOwnerId, OwnerControlError} from '../owner/owner-contracts.mjs';
import {PostgresCoordinationStore} from '../coordination/postgres/postgres-coordination-store.mjs';
import {COORDINATION_SCHEMA_VERSION} from '../coordination/postgres/coordination-migrations.mjs';
import {SqlitePersistenceStore} from '../persistence/sqlite/sqlite-persistence-store.mjs';
import {SCHEMA_VERSION} from '../persistence/sqlite/migrations.mjs';
import {AgentBusRepository} from '../persistence/repositories/agentbus-repository.mjs';
import {PmRepository} from '../persistence/repositories/pm-repository.mjs';
import {PmProfileRegistry} from '../pm/pm-profile-registry.mjs';
import {PmProfileStatusStore} from '../pm/pm-profile-status-store.mjs';
import {DurablePmRuntime} from '../pm/durable-pm-runtime.mjs';
import {ProductionPmBackendRegistry,ProductionPmBackendError} from '../pm/production-pm-backend-registry.mjs';
import {PostgresOwnerRepository} from '../owner/postgres-owner-repository.mjs';
import {OwnerTaskController} from '../owner/owner-task-controller.mjs';
import {createWorkspaceAdmissionLock} from './workspace-admission-lock.mjs';
import {loadP5Projects} from './p5-production-config.mjs';
import {OwnerControlService} from '../owner/owner-control-service.mjs';
import {TelegramOwnerAdapter,OwnerInteractionNotifier,OwnerTerminalResultNotifier,renderLongTaskNotification} from '../owner/telegram-owner-client.mjs';
import {OwnerRuntime} from '../owner/owner-runtime.mjs';
import {AwaitOwnerCloser} from '../owner/await-owner-closer.mjs';
import {ProductionCoordinatorRuntime} from './production-coordinator-runtime.mjs';
import {ProductionWorkerRuntime} from './production-worker-runtime.mjs';
import {MultiProcessTaskWorker,createWorkerIncarnationId,completedResultForWork} from '../coordination/multi-process-worker.mjs';
import {FencedDispatchCoordinator} from '../coordination/fenced-dispatch-coordinator.mjs';
import {ProductionPmWorkHandler,ProductionPmWorker,CompositeProductionWorker,pmWorkIdentity,resolvePmWorkspaceIdentity,reconcileQueuedCancellation,resolvePmBackendIdentity} from './production-pm-worker.mjs';
import {CouncilChairDriver} from '../pm/council/council-chair-driver.mjs';
import {CouncilStepWorkflowRunner} from '../pm/council/council-step-workflow-runner.mjs';
import {councilMaxTurns} from '../pm/council/council-contracts.mjs';
import {resolveProfileCapabilities} from '../pm/council/workspace-capability.mjs';
import {buildWorkspaceEvidencePacket,renderWorkspaceEvidencePacketText,packetHashesByPath} from '../pm/council/workspace-evidence-packet.mjs';
import {createTaskDiagnosticLogFactory,forwardBackendEventToTaskLog} from './task-diagnostic-log.mjs';
import {createArtifactStore,resolveArtifactStoreRoot} from '../artifacts/artifact-store.mjs';
import {createReportInvoker} from '../pm/report-invocation.mjs';
import {completeSingleReportArtifact} from '../pm/single-report-completion.mjs';
import {resolveTransportVersion} from '../artifacts/artifact-transport.mjs';
import {buildActorAliasRegistry} from '../artifacts/artifact-paths.mjs';
import {CapabilityEvidenceRegistry} from '../artifacts/capability-evidence-registry.mjs';
import {createCliReportBackendResolver,PRODUCTION_ROUTE_BY_PRODUCT} from './p20-report-route-resolution.mjs';
import {buildProductionCapabilityPolicy} from './production-backend-capabilities.mjs';
import {SingleArtifactDriver} from '../pm/single-artifact-driver.mjs';
import {TRANSPORT_VERSION} from '../artifacts/artifact-transport.mjs';
import {createBackendExecutionObserver,defaultEmit,activeOwnedProviderProcessCount} from './backend-execution-observer.mjs';
import {StuckTaskReconciler} from '../reconciliation/stuck-task-reconciler.mjs';
import {SqliteReconciliationRepository} from '../reconciliation/sqlite-reconciliation-repository.mjs';
import {PostgresCancellationReconciliationRepository} from '../reconciliation/postgres-cancellation-reconciliation-repository.mjs';
import {CompositeReconciliationSource,ConservativeResourceGuard,CoordinationLeadershipGuard} from '../reconciliation/reconciliation-ports.mjs';
import {RECONCILIATION_MODE,resolveReconciliationMode} from '../reconciliation/reconciliation-mode.mjs';
import {resolveExecutionOptions,EXECUTION_STAGE} from '../pm/pm-execution-timeout-policy.mjs';
import {resolveGitFileTaskSource,TaskSourceError} from '../owner/task-source-resolver.mjs';
import {findTaskHistoryEntry} from './task-context-index.mjs';
import {withTelegramLongTaskNotifications} from './telegram-long-task-notifier.mjs';
import {createProductionPmWorkflowRunner} from '../workflow/production-pm-workflow-runner.mjs';
import {WorkflowRepository} from '../persistence/repositories/workflow-repository.mjs';
import {DurableWorkflowState} from '../workflow/durable-workflow-state.mjs';
import {resolveExecutionProject,projectExecutionCacheKey,resolveTaskWorkspaceBinding} from '../pm/task-execution-context.mjs';
import {ensureTaskWorkspace} from '../pm/task-workspace-manager.mjs';

const inertPeer={exchange:async()=>{throw Object.assign(new Error('peer backend is not composed'),{code:'PEER_UNAVAILABLE'});},createConversation(){},getConversation(){return null;},result:()=>null};

// DSH_RECONCILIATION_MODE safety gate: production auto-reconciliation is
// DEFAULT OFF. The mode is resolved ONCE, fail-closed, from the single
// bounded config field (config.reconciliation.mode, sourced from the exact
// DSH_RECONCILIATION_MODE env var by loadP5ProductionConfig). In-memory
// configs without the field (pre-gate tests) resolve to 'disabled' —
// never to auto-repair. In 'dry-run' the periodic reconciler still scans
// and classifies real durable state but mutates nothing; only in an
// explicitly configured 'enabled' does the pre-gate 30s leader-fenced
// auto-repair behavior exist at all.
const logDryRunCandidate=(outcome)=>console.log(JSON.stringify({event:'reconciliation.dry_run_candidate',...outcome}));

// P10-R0.1.1 Part L: `observer`, when supplied, is passed straight through
// to `new ProductionPmBackendRegistry({observer})` — this is the ONLY new
// parameter here; every existing caller that omits it gets the exact same
// default (`createBackendExecutionObserver()`, stdout-sentinel only) as
// before.
// P11-R0: `apiProviders`, when supplied, is passed straight through to
// `new ProductionPmBackendRegistry({apiProviders})` — exactly the same
// pass-through pattern `observer` already uses on the line above. Every
// existing caller that omits it gets the registry's own default (`{}` — no
// configured providers), so this is a no-op for every pre-P11 caller.
export function createProductionPmDriverResolver({factories={},scriptedDecisions=null,backendRegistry=null,observer=null,apiProviders=null,profileRegistry=null}={}){
  const production=()=>backendRegistry??(backendRegistry=new ProductionPmBackendRegistry({profileRegistry,...(observer?{observer}:{}),...(apiProviders?{apiProviders}:{})}));
  const resolver=(profile,context={})=>{const factory=factories[profile.product];if(factory)return factory(profile,context);if(profile.product==='scripted'&&profile.transport==='in-process'&&profile.session_kind==='STATELESS'&&Array.isArray(scriptedDecisions)&&scriptedDecisions.length){const decisions=structuredClone(scriptedDecisions);return{name:`scripted:${profile.id}`,async decide(input){const entry=decisions[input?.turn];if(entry===undefined)throw Object.assign(new Error(`scripted PM driver exhausted decisions at turn ${input?.turn}`),{code:'PM_SCRIPT_EXHAUSTED'});return entry;}};}return production().resolve(profile,context);};
  resolver.inspect=profile=>{if(factories[profile.product])return Object.freeze({available:true,code:null,product:profile.product,transport:profile.transport,session_kind:profile.session_kind});if(profile.product==='scripted')return Object.freeze({available:profile.transport==='in-process'&&profile.session_kind==='STATELESS'&&Array.isArray(scriptedDecisions)&&scriptedDecisions.length,code:'PM_BACKEND_UNAVAILABLE',product:profile.product,transport:profile.transport,session_kind:profile.session_kind});return production().inspect(profile);};
  resolver.list=()=>[...production().list(),{product:'scripted',transport:'in-process',session_kind:'STATELESS'}];return resolver;
}

export async function createP5ProductionComposition(config,deps={}){
  if(!config?.postgres?.connectionString||!config?.sqlitePath)throw new TypeError('validated P5 config required');
  const reconciliationMode=resolveReconciliationMode(config.reconciliation?.mode);
  const profileRegistry=new PmProfileRegistry(config.profiles);const backendRegistry=deps.pmBackendRegistry??null;
  // P10-R0.1 Part H/Q: OPT-IN task-scoped diagnostic logging (Part H says
  // "automatic" for the real owner-facing runtime — scripts/p5-runtime.mjs
  // supplies `deps.taskDiagnosticsRoot` derived from `config.sqlitePath`'s
  // own directory for every real `desktop`-spawned process; it stays
  // `null`/off for every composition built without that dep — e.g. the
  // existing P2-P9 test suite — so this foundation adds zero new disk I/O
  // to tests that never asked for it). `.runtime/` is already 100%
  // .gitignore'd, so the default convention (sibling `logs/tasks/` next to
  // the SQLite file) never needs new git hygiene. Built BEFORE
  // `resolveDriver` (moved up from its original position) because the
  // PID/PROCESS_EXIT bridge below needs it already constructed.
  const taskDiagnosticsFactory=deps.taskDiagnosticsRoot?createTaskDiagnosticLogFactory({runtimeRoot:deps.taskDiagnosticsRoot,onWarning:(w)=>{try{console.warn(`[task-diagnostics] ${w.stage} task=${w.taskId}: ${w.message}`);}catch{}}}):null;
  // P10-R0.2 Part Q/S: OPT-IN deterministic repository-context
  // materialization (docs/p10/06_REPOSITORY_CONTEXT_MATERIALIZATION.md).
  // `scripts/p5-runtime.mjs` supplies `deps.enableRepoHistoryMaterialization`
  // for the real owner-facing runtime; off by default so the existing
  // P2-P9 test suite gets zero new writes into whatever `project.repo_path`
  // its fixtures happen to use.
  const enableRepoHistoryMaterialization=Boolean(deps.enableRepoHistoryMaterialization);
  // P20.1D: OPT-IN, INACTIVE artifact workspace foundation
  // (src/artifacts/, docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md).
  // Dependency-injection availability ONLY — nothing in this composition or
  // any current execution path calls it, and no script passes
  // `deps.artifactStore`/`deps.artifactStoreRoot`, so it stays `null` for
  // every real deployment and every existing test. The store also performs
  // zero filesystem I/O until an allocate/ensure method is invoked, so even
  // an opted-in-but-unused store creates no P20 directories. Report routing
  // through this store is a later phase (P20.2+); legacy remains the
  // default task transport (src/artifacts/artifact-transport.mjs).
  const artifactStore=deps.artifactStore??(deps.artifactStoreRoot&&deps.artifactStoreId?createArtifactStore({storeId:deps.artifactStoreId,projectId:deps.artifactStoreProjectId??config.projects[0]?.id,root:deps.artifactStoreRoot}):null);
  // P20.2: OPT-IN, INACTIVE report-content-plane invoker (src/pm/report-
  // invocation.mjs). DI availability ONLY — no script passes
  // `deps.reportInvoker`/`deps.enableArtifactReportInvoker`, nothing in this
  // composition or any owner-facing execution path calls it, and it does no
  // I/O on construction. `artifact_v1` owner-facing report routing stays
  // disabled until P20.3+. Legacy `decide()` control flow is unchanged.
  const reportInvoker=deps.reportInvoker??(deps.enableArtifactReportInvoker?createReportInvoker():null);
  // P20.3 §24: OPT-IN, INACTIVE SINGLE artifact_v1 completion hook
  // (integrity gate -> seal -> Task Final Artifact Gate). DI availability
  // ONLY — no script passes `deps.enableArtifactFinalizer`, nothing here or
  // in any owner-facing path calls it, and it does no I/O on construction.
  // Legacy task completion (DurablePmRuntime) is unchanged; owner-facing
  // `artifact_v1` completion is NOT enabled.
  const artifactFinalizer=deps.artifactFinalizer??(deps.enableArtifactFinalizer?{completeSingleReportArtifact}:null);
  // P20.4: OPT-IN, INACTIVE artifact_v1 Council report-content plane
  // (src/pm/council/council-artifact-orchestrator.mjs). DI availability ONLY
  // — no script passes `deps.enableCouncilArtifactOrchestrator`, nothing in
  // this composition, no worker/startup path, and no owner-facing route
  // calls it; it does no I/O on construction and never invokes a live
  // provider (the caller supplies deterministic report backends). Legacy
  // Council (CouncilChairDriver + CouncilStepWorkflowRunner + decide()/
  // parseDecision) is entirely unchanged and remains the default for every
  // `transport_version=legacy` council. An `artifact_v1` Council requires an
  // explicit admission decision + report-backend transport a later phase
  // (P20.8) wires; until then this stays `null` for every real deployment.
  // P20.4R §4 — the P20.4 stopgap `councilArtifactOrchestrator` seam
  // (a straight-line `runArtifactCouncil` topology loop) is REMOVED. There is
  // now ONE authoritative app-owned Council topology: CouncilChairDriver's
  // deterministic sequencing over the durable turn machine, for BOTH legacy
  // and artifact_v1 (see the `effectiveTransport==='artifact_v1'` branch in
  // createRuntime below). `runArtifactCouncil()` survives only as an offline
  // test convenience over the same primitives — it is not wired here.
  // P20.4R §18 — OPT-IN, LIVE-DISABLED artifact_v1 Council durable-runtime
  // wiring. A council task whose durable context is stamped `artifact_v1`
  // (src/artifacts/artifact-transport.mjs resolveTransportVersion) builds the
  // artifact-aware CouncilChairDriver + CouncilStepWorkflowRunner over the
  // SAME DurablePmRuntime / DurableWorkflowState / PmRepository as legacy. It
  // requires an explicitly injected `artifactStore` + a report-backend
  // resolver; if either is absent the artifact council FAILS CLOSED (typed)
  // — it is NEVER silently downgraded to legacy. `null` for every real
  // deployment: no script passes `deps.councilArtifactRuntime`, and this
  // performs zero I/O on construction.
  const councilArtifactRuntime=deps.councilArtifactRuntime??null;
  // P20.8 §6.1 — project-scoped canonical P20 ArtifactStore resolver. Do
  // NOT bind every project to config.projects[0] (§6.1 explicit rule): one
  // store per project_id, derived from the frozen P20 storage convention
  // (resolveArtifactStoreRoot(): `<runtimeBase>/dsh-artifacts/<project_id>`)
  // and the SAME canonical runtime base `taskDiagnosticsRoot` above already
  // derives from (`dirname(config.sqlitePath)`) — never `process.cwd()`,
  // never a session-scratch path (survives restart/branch/process changes,
  // per the P20 freeze). `deps.artifactStores` (a project_id -> ArtifactStore
  // Map) is a direct test override; `deps.enableProductionArtifactStores`
  // opts a real deployment in. Neither is supplied by any pre-P20.8 caller,
  // so `resolveProjectArtifactStore()` falls back to the legacy singleton
  // `artifactStore` above (unchanged behavior for any existing single-
  // project test/DI caller) and finally to a fail-closed
  // ARTIFACT_STORE_NOT_CONFIGURED refusal.
  const productionArtifactStores=deps.artifactStores instanceof Map?deps.artifactStores:(deps.enableProductionArtifactStores?new Map(config.projects.map(project=>[project.id,createArtifactStore({storeId:deps.artifactStoreId??'store-p20-production-v1',projectId:project.id,runtimeBase:deps.artifactRuntimeBase??dirname(config.sqlitePath)})])):null);
  const resolveProjectArtifactStore=(projectId)=>{
    if(productionArtifactStores){
      const store=productionArtifactStores.get(projectId);
      if(!store)throw new ProductionPmBackendError(`no P20 artifact store is configured for project ${JSON.stringify(projectId)}`,'ARTIFACT_STORE_NOT_CONFIGURED',{projectId});
      return store;
    }
    if(artifactStore)return artifactStore;
    throw new ProductionPmBackendError(`no P20 artifact store is configured for project ${JSON.stringify(projectId)}`,'ARTIFACT_STORE_NOT_CONFIGURED',{projectId});
  };
  // P24.1G7A — durable, non-Git task-history root (single-settlement audit
  // §"History Commit Analysis": "Relocate that value; remove the separate
  // commit from normal settlement"). OPT-IN, exactly like every other
  // capability in this composition (`enableRepoHistoryMaterialization`,
  // `enableProductionArtifactStores` above) — absent for every existing
  // test/DI caller, so `resolveProjectHistoryRoot` stays `null` and the
  // worker's own fallback (`project.repo_path`, byte-for-byte pre-G7A
  // behavior) is unchanged. `scripts/p5-runtime.mjs` is the one caller that
  // turns this on for a real deployment (mirroring how it alone turns on
  // `enableRepoHistoryMaterialization`). Same base convention as the P20
  // artifact store (`dirname(config.sqlitePath)` — never `process.cwd()`,
  // survives restart), but its own sibling folder (`dsh-task-history/`, not
  // `dsh-artifacts/`): this is DSH-internal provenance, never P20 sealed
  // artifact content, and must never share a root an artifact-integrity
  // scan might walk.
  const resolveProjectHistoryRoot=deps.enableProjectHistoryRuntimeStorage
    ?(projectId)=>join(deps.taskHistoryRuntimeBase??dirname(config.sqlitePath),'dsh-task-history',projectId)
    :null;
  // P20.8 §6.2/§8 — production artifact wiring activation switch. Opt-in
  // ONLY: `deps.enableProductionArtifactWiring` is never set by any
  // pre-P20.8 caller (including every existing test), so `createRuntime()`
  // below is byte-for-byte unaffected unless a caller explicitly turns
  // this on (scripts/p5-runtime.mjs, gated by its own explicit env flag —
  // see this file's own composition caller). When on, a per-project
  // report-backend resolver (p20-report-route-resolution.mjs) and the §8
  // durable capability-evidence registry are constructed; the actual
  // per-run capabilityPolicy overlay is still built freshly INSIDE
  // createRuntime() (below) from the EXACT participating profile set of
  // that one task — never a static, pre-broadened policy object.
  const enableProductionArtifactWiring=Boolean(deps.enableProductionArtifactWiring);
  const capabilityEvidenceRegistry=deps.capabilityEvidenceRegistry??(enableProductionArtifactWiring?new CapabilityEvidenceRegistry({filePath:deps.capabilityEvidenceFilePath??join(deps.artifactRuntimeBase??dirname(config.sqlitePath),'p20-capability-evidence.json')}):null);
  // P10-R0.1.1 Part L: forward ONLY PROCESS_SPAWN/PROCESS_EXIT
  // (backend-execution-observer.mjs) into the SAME task-scoped bundle when
  // the event's `ctx` carries a `taskId` (extraCtx — see createRuntime()
  // below) — this is a correlation BRIDGE, not a second source of truth
  // (Part L: "Backend Execution remains runtime observability. Task bundle
  // is task-scoped diagnostic projection."). The existing stdout-sentinel
  // behavior (Desktop's execution-log ring buffer) is always preserved
  // first, unconditionally — this never replaces it. Only active when
  // `deps.resolvePmDriver` is NOT overridden (a caller providing its own
  // resolver owns its own observer entirely) and diagnostics are enabled.
  // P10-R0.2.4.1 Part B-I: bounded, owner-visible Telegram notifications
  // for a LONG task's runtime/liveness transitions. `sendLongTaskNotice`
  // is REBOUND once `adapter` is constructed further below (`adapter` is
  // itself built from `taskFileResolver`, which is deliberately
  // constructed after this point in the file) — this lazy-binding
  // pattern avoids reordering the whole composition function purely for
  // one forward reference; every real notification only ever fires
  // asynchronously, long after this function has returned and `adapter`
  // is fully bound. A throwing/rejecting notifier can never affect real
  // backend execution (withTelegramLongTaskNotifications wraps every
  // call in a swallow-all safeNotify()).
  let sendLongTaskNotice=async()=>{};
  const notifyLongTaskTelegram=async(event)=>{
    const text=renderLongTaskNotification(event);
    if(text)await sendLongTaskNotice(text);
  };
  const execLogObserver=(!deps.resolvePmDriver&&taskDiagnosticsFactory)?withTelegramLongTaskNotifications(createBackendExecutionObserver({emit:(event)=>{
    defaultEmit(event);
    forwardBackendEventToTaskLog(event,taskDiagnosticsFactory);
  }}),{notify:notifyLongTaskTelegram}):null;
  const resolveDriver=deps.resolvePmDriver??createProductionPmDriverResolver({factories:deps.pmDriverFactories,scriptedDecisions:config.pm.scriptedDecisions,backendRegistry,profileRegistry,observer:execLogObserver,apiProviders:config.apiProviders});
  // P20.8R3 §3 — the P20 report-plane resolver must receive the SAME
  // effective execution-observer sink/path the legacy decision plane's
  // ProductionPmBackendRegistry receives above (`execLogObserver`) — never
  // a disconnected P20-only logger. When `execLogObserver` is `null`
  // (task diagnostics not opted in for this composition, or `deps.
  // resolvePmDriver` overridden), `createCliReportBackendResolver()` falls
  // back to its own default (`createBackendExecutionObserver()` — the
  // exact same default `ProductionPmBackendRegistry`'s constructor
  // already uses), so a report execution is never silently unobserved.
  const reportBackendResolversByProject=new Map();
  // P24.3B §7 — the audit's own "project-keyed cache" hazard, identical
  // to `workflowRunnerForProject()`'s own fix above: every backend this
  // resolver builds permanently closes over `project.repo_path` at
  // CONSTRUCTION time (p20-report-route-resolution.mjs's `cwd:
  // project.repo_path` inside each `create...ReportBackend()` call).
  // Keying by `project.id` alone would hand a later v1 task's report
  // invocation a STALE cwd from whichever project/workspace pairing was
  // cached first. The caller always passes the already execution-scoped
  // project (createRuntime's `executionProject`), so keying on its own
  // `repo_path` alongside `id` is sufficient — no separate `taskContext`
  // needed here.
  const resolveProjectReportBackendResolver=(project)=>{
    const cacheKey=`${project.id}::${project.repo_path}`;
    let resolver=reportBackendResolversByProject.get(cacheKey);
    if(!resolver){resolver=createCliReportBackendResolver({profileRegistry,project,spawnImpl:deps.reportBackendSpawnImpl,timeoutMsByProduct:deps.reportBackendTimeoutMsByProduct,apiProviders:config.apiProviders??{},...(deps.reportBackendApiEnv?{apiEnv:deps.reportBackendApiEnv}:{}),...(deps.reportBackendApiFetch?{apiFetch:deps.reportBackendApiFetch}:{}),...(execLogObserver?{observer:execLogObserver}:{})});reportBackendResolversByProject.set(cacheKey,resolver);}
    return resolver;
  };
  // P9-R0.4 Part B/N: `reasoning`/`status` (lifecycle, defaulting ACTIVE)
  // ride along on the readiness snapshot too, so Desktop's Composer
  // selectors have everything needed for the self-describing label
  // (Part A/C) and the active-only filter (Part N) without a second round
  // trip — `id` is `profile_id` above (kept for backward compatibility).
  const pmBackendStatus=profileRegistry.list().map(profile=>Object.freeze({profile_id:profile.id,model:profile.model,reasoning:profile.reasoning,status:profile.status,session_kind:profile.session_kind,...(typeof resolveDriver.inspect==='function'?resolveDriver.inspect(profile):{available:false,code:'PM_BACKEND_RESOLVER_UNINSPECTABLE'})}));
  const unavailable=pmBackendStatus.find(value=>!value.available);if(unavailable)throw new ProductionPmBackendError('configured PM profile backend is unavailable',unavailable.code??'PM_BACKEND_UNAVAILABLE',{profile_id:unavailable.profile_id,product:unavailable.product,transport:unavailable.transport,session_kind:unavailable.session_kind});
  const coordination=deps.coordinationStore??await new PostgresCoordinationStore().open(config.postgres);await coordination.assertReady();
  const ownerRepository=deps.ownerRepository??await new PostgresOwnerRepository().open(config.postgres);
  const sqlite=deps.sqliteStore??await new SqlitePersistenceStore().open({path:config.sqlitePath,busyTimeoutMs:5000});await sqlite.migrate();if(await sqlite.readSchemaVersion()!==SCHEMA_VERSION)throw Object.assign(new Error(`SQLite schema is not exact v${SCHEMA_VERSION}`),{code:'SQLITE_SCHEMA_MISMATCH'});
  const agentBusRepository=new AgentBusRepository({store:sqlite});const pmRepository=new PmRepository({store:sqlite});
  const workflowRunners=new Map();
  // P24.3B §7 — the audit's own "project-keyed cache" hazard: this runner
  // permanently captures whatever `project` object it was FIRST built
  // with (createProfileStepAdapter's closure — production-pm-workflow-
  // runner.mjs), so keying by `project.id` alone would silently hand a
  // LATER v1 task (a different, or by-then-removed, isolated workspace)
  // the FIRST task's stale execution root. Keyed by `(project.id,
  // repo_path)` instead: every legacy task for one project shares the
  // SAME single cache entry, byte-for-byte pre-P24.3 behavior (its
  // `repo_path` never changes); each v1 task's uniquely-pathed workspace
  // gets its own fresh entry, never colliding with a stale one.
  const workflowRunnerForProject=(project,taskContext=null)=>{
    if(deps.workflowRunner)return deps.workflowRunner;
    const executionProject=resolveExecutionProject(project,taskContext);
    const cacheKey=projectExecutionCacheKey(project,taskContext);
    let runner=workflowRunners.get(cacheKey);
    if(!runner){runner=createProductionPmWorkflowRunner({store:sqlite,agentBusRepository,profileRegistry,resolveDriver,project:executionProject,extraCtx:(task)=>({taskId:task.id,pmRunId:task.context?.pmRunId??null})});workflowRunners.set(cacheKey,runner);}
    return runner;
  };
  const peerRelay=deps.peerRelay??inertPeer;
  // P15-REM-R2-A (P15-C-001, docs/p15-rem/03_*.md): ONE shared durable
  // step-state store for EVERY council run this composition creates — the
  // same `workflows`/`workflow_steps` tables (via `WorkflowRepository`/
  // `DurableWorkflowState`) SINGLE's own `createProductionPmWorkflowRunner()`
  // already uses above, reused verbatim (no third persistence model, no
  // schema change). A fresh `CouncilStepWorkflowRunner` is still constructed
  // per createRuntime() call (unchanged) — durability now lives here, in the
  // shared store, not in that transient instance, which is exactly what lets
  // a real process restart recover correctly.
  const councilStepState=deps.councilStepState??new DurableWorkflowState({repository:new WorkflowRepository({store:sqlite})});
  // P7: a council run (`council` present) uses a DIFFERENT driver
  // (CouncilChairDriver — deterministic phase/round orchestration, never a
  // real CLI call itself) and a DIFFERENT workflowRunner
  // (CouncilStepWorkflowRunner, scoped to `kind:'council_step'` specs only —
  // it refuses anything else, so it can never execute a real non-council
  // workflow). `peerRelay`/`pmRepository`/claim-fence/worker plumbing are
  // 100% unchanged and shared with single-PM — a council run is still just
  // ONE DurablePmRuntime-driven PmRun (see src/pm/council/council-contracts.mjs).
  const createRuntime=({profileId,project,ownerControl=null,council=null,ownerTask=null,pmRunId=null,taskId=null,runtimeClass=null,transportVersion=null,taskContext=null})=>{
    // P10-R0.1 Part H/K: `taskLog` is deliberately constructed fresh here
    // (stateless — TaskDiagnosticLog resolves its own path per call, see
    // its file docstring) rather than threaded in as an object from the
    // caller, so BOTH real execution paths that call createRuntime() — the
    // submission path (`startPm` below, turn 0 only) and the worker's
    // resume/executePrepared path (production-pm-worker.mjs, every
    // subsequent turn) — get the SAME per-task events.jsonl just by each
    // passing the same `taskId` they already have in scope.
    const taskLog=taskId&&taskDiagnosticsFactory?taskDiagnosticsFactory({taskId,projectId:project?.id??null,pmRunId,taskMode:council?'COUNCIL':'SINGLE'}):null;
    // P20.4R §18/§19 — transport comes from the DURABLE task context only,
    // never prompt text / an ad-hoc flag. Unsupported/conflicting stamps
    // already fail closed inside resolveTransportVersion().
    const effectiveTransport = transportVersion ?? resolveTransportVersion(taskContext);
    // P24.3B §5/§8/§9 — a project-shaped view whose `repo_path` is this
    // task's execution root (task.workspace_path for an isolated v1 task,
    // `project.repo_path` — byte-for-byte unchanged — for every legacy
    // task). Every downstream consumer below that needs "the project a
    // provider/report-backend/evidence-read should actually operate
    // against" receives THIS, never the bare `project` parameter — see
    // task-execution-context.mjs's own docstring for why this is the one
    // narrow, ephemeral exception to "never construct {...project,
    // repo_path:taskPath}". `resolveProjectArtifactStore(project.id)`
    // below intentionally keeps using the bare registry `project` — the
    // P20 artifact store is a durable, project-scoped root, never the
    // task workspace.
    const executionProject=resolveExecutionProject(project,taskContext);
    // P24.3C-R1 — durable per-invocation task-workspace evidence (the SAME
    // binding `execRepoPath`/`executionProject.repo_path` above already
    // derive from); `null` for every legacy/non-isolated task. Threaded
    // through to the report-content plane ONLY as additive executive.log
    // evidence (report-invocation.mjs) — it never changes provider cwd/
    // behavior, which is already fully determined by `executionProject`.
    const workspaceEvidence=resolveTaskWorkspaceBinding(taskContext);
    if(council && effectiveTransport==='artifact_v1'){
      // P20.8 §6.2 — an explicitly DI-injected `deps.councilArtifactRuntime`
      // (existing seam, e.g. a test's fixed fake resolver) always wins
      // unchanged. Otherwise, when production artifact wiring is enabled,
      // build ONE fresh per-run runtime here: a project-scoped store
      // (§6.1 — never config.projects[0]), the real three-backend report
      // resolver, and a capabilityPolicy overlay scoped to EXACTLY this
      // council's own chair+participant profile ids (§8 — never broadened
      // to any other profile/run).
      let store=null;
      let runtime=councilArtifactRuntime;
      if(runtime){
        store=artifactStore;
      } else if(enableProductionArtifactWiring){
        store=resolveProjectArtifactStore(project.id);
        runtime={
          createdAt:new Date().toISOString(),
          reportBackendResolver:resolveProjectReportBackendResolver(executionProject),
          // P22.4 §G — production admission now reads ONLY the static,
          // profile-independent PRODUCTION_BACKEND_SUPPORT table (see
          // production-backend-capabilities.mjs). It no longer builds a
          // per-run overlay from `capabilityEvidenceRegistry`'s durable
          // exact-tuple evidence file — a new profile_id/model/reasoning/
          // display-name, or an absent/empty/corrupt evidence file, can
          // never disable (or need to separately re-prove) a route this
          // table already marks supported for the participating products.
          capabilityPolicy:buildProductionCapabilityPolicy(),
          consumerInputTransport:'VERBATIM_CONTENT',
        };
      }
      if(!runtime || !store || typeof runtime.reportBackendResolver!=='function'){
        throw new ProductionPmBackendError(
          'artifact_v1 Council requires an injected artifactStore + councilArtifactRuntime.reportBackendResolver (or enableProductionArtifactWiring); refusing to silently run legacy Council',
          'COUNCIL_ARTIFACT_DEPS_MISSING',
          {taskId,pmRunId},
        );
      }
      const aliasRegistry=buildActorAliasRegistry([council.chair_profile_id,...council.participant_profile_ids]);
      const artifactCouncil={
        store,
        taskId,
        taskSlug:ownerTask??'council',
        createdAt:runtime.createdAt??new Date().toISOString(),
        resolveReportBackend:runtime.reportBackendResolver,
        capabilityPolicy:runtime.capabilityPolicy,
        consumerInputTransport:runtime.consumerInputTransport??'VERBATIM_CONTENT',
        aliasRegistry,
        maxReportBytes:runtime.maxReportBytes,
        admittedCapabilitySnapshot:runtime.admittedCapabilitySnapshot??null,
        sourceRevision:taskContext?.sourceRevision??null,
        workspaceId:taskContext?.workspaceId??null,
        workspaceEvidence,
      };
      const stepWorkflowRunner=new CouncilStepWorkflowRunner({resolveDriver,profileRegistry,project:executionProject,extraCtx:(spec)=>({councilId:pmRunId,phase:spec.stepKind,round:spec.round,role:spec.stepKind==='chair_plan'||spec.stepKind==='chair_synthesis'?'chair':'participant',taskId,pmRunId,taskMode:'COUNCIL'}),taskLog,stepState:councilStepState,artifactCouncil});
      const driver=new CouncilChairDriver({council,ownerTask:ownerTask??'',constraints:[],transportMode:'artifact_v1',artifactCouncil,
        resolveWorkspaceCapability:(id)=>resolveProfileCapabilities(profileRegistry?.get?profileRegistry.get(id):null).workspaceCapability,
        loadEvidencePacket:async()=>{const packet=await buildWorkspaceEvidencePacket({project:executionProject,evidencePaths:council.workspace_evidence_paths});return{text:renderWorkspaceEvidencePacketText(packet),hashesByPath:packetHashesByPath(packet)};},
      });
      const councilTurnBudget=councilMaxTurns(council);
      return new DurablePmRuntime({driver,workflowRunner:stepWorkflowRunner,peerRelay,repository:pmRepository,profileRegistry,pmProfileId:profileId,ownerControl,maxTurns:councilTurnBudget,historyLimit:councilTurnBudget,taskLog});
    }
    // P21.2 — GENERIC BACKEND ELIGIBILITY vs P20 REPORT-ADAPTER ELIGIBILITY
    // are two different planes (see docs/P21/P21_2_GENERIC_BACKEND_
    // ELIGIBILITY_AND_TELEGRAM_POISON_FIX_REPORT.md). A profile's product
    // having no P20 production report route (PRODUCTION_ROUTE_BY_PRODUCT —
    // the SAME single source of truth buildCapabilityParticipant() already
    // consults, never a second hard-coded list) must NOT make that backend
    // ineligible for a generic SINGLE task — it only means artifact_v1's
    // P20 SingleArtifactDriver path is unavailable for THIS product, so
    // this run falls through to the pre-existing generic PM decision-plane
    // driver below (line ~443), completely unchanged for every product
    // that already worked through it. `council` is unaffected: a Council
    // whose chair/participants aren't all P20-capable already fails closed
    // above via COUNCIL_ARTIFACT_DEPS_MISSING / buildCapabilityParticipant
    // — that fail-closed posture is untouched by this SINGLE-only guard.
    if(!council && effectiveTransport===TRANSPORT_VERSION.ARTIFACT_V1 && Boolean(PRODUCTION_ROUTE_BY_PRODUCT[profileRegistry.get(profileId).product])){
      const executionOptions=resolveExecutionOptions(runtimeClass==='LONG'?EXECUTION_STAGE.OWNER_SINGLE_LONG:EXECUTION_STAGE.OWNER_SINGLE);
      // P20.8 §6.3 — SINGLE artifact_v1: the same fail-closed-if-deps-
      // missing posture as Council above (§6.2 R5/R16 of the offline test
      // list) — no silent fallback to the legacy decision-plane driver.
      if(!enableProductionArtifactWiring){
        throw new ProductionPmBackendError('artifact_v1 SINGLE requires production artifact wiring to be enabled; refusing to silently run legacy SINGLE','SINGLE_ARTIFACT_WIRING_DISABLED',{taskId,pmRunId});
      }
      const store=resolveProjectArtifactStore(project.id);
      const driver=new SingleArtifactDriver({
        store,
        taskId,
        taskSlug:ownerTask??taskId??'single',
        createdAt:new Date().toISOString(),
        profileId,
        actorAlias:profileId,
        instructions:ownerTask??'',
        resolveReportBackend:resolveProjectReportBackendResolver(executionProject),
        // P22.4 §G — see the identical Council comment above.
        capabilityPolicy:buildProductionCapabilityPolicy(),
        executionOptions,
        workspaceEvidence,
      });
      return new DurablePmRuntime({driver,workflowRunner:workflowRunnerForProject(project,taskContext),peerRelay,repository:pmRepository,profileRegistry,pmProfileId:profileId,ownerControl,taskLog});
    }
    if(council){
      // P10-R0.1.1 Part L: `taskId`/`pmRunId`/`taskMode` are additive
      // correlation fields (same spread-last rule as Part W's original
      // councilId/phase/round/role — see production-pm-backend-registry.mjs's
      // ctx-building comment) that let the PID/PROCESS_EXIT bridge above
      // route a real backend spawn/exit fact back to this task's bundle.
      const stepWorkflowRunner=new CouncilStepWorkflowRunner({resolveDriver,profileRegistry,project:executionProject,extraCtx:(spec)=>({councilId:pmRunId,phase:spec.stepKind,round:spec.round,role:spec.stepKind==='chair_plan'||spec.stepKind==='chair_synthesis'?'chair':'participant',taskId,pmRunId,taskMode:'COUNCIL'}),taskLog,stepState:councilStepState});
      // Council/Debate WORKSPACE_READ remediation (docs/evidence/
      // DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md): both DI seams
      // are no-ops for `council.workspace_requirement === 'NONE'` (every
      // pre-existing council) — CouncilChairDriver never calls either
      // unless a step actually needs a workspace-read capability
      // resolution. `resolveWorkspaceCapability` is a pure, cheap lookup
      // (no I/O); `loadEvidencePacket` is only ever invoked (once, cached
      // by the driver) for a real 'READ' council with a TEXT_ONLY-capability
      // step.
      const driver=new CouncilChairDriver({council,ownerTask:ownerTask??'',constraints:[],
        resolveWorkspaceCapability:(id)=>resolveProfileCapabilities(profileRegistry?.get?profileRegistry.get(id):null).workspaceCapability,
        // Owner-review remediation Gap B: the council's own owner-authored
        // workspace_evidence_paths (absent for a manifest-less READ
        // council, or every pre-Gap-B council) flows straight through to
        // the packet builder, which prioritizes it over the generic
        // anchor-file fallback.
        // Final stabilization patch (§17/§18): the packet is built ONCE
        // here (never twice) and both the rendered text AND its
        // authoritative path->sha256 snapshot are derived from that SAME
        // object, so evidence-hash validation binds to exactly what every
        // stage's prompt embedded.
        loadEvidencePacket:async()=>{const packet=await buildWorkspaceEvidencePacket({project:executionProject,evidencePaths:council.workspace_evidence_paths});return{text:renderWorkspaceEvidencePacketText(packet),hashesByPath:packetHashesByPath(packet)};},
      });
      // P19-D3-REMEDIATE: CouncilChairDriver is not an LLM-context-budgeted
      // consumer of DurablePmRuntime's history -- it is a deterministic
      // state machine (#stepsSoFar()/#debateStepsSoFar()) that reconstructs
      // completed steps by scanning the FULL turn history for chair_plan/
      // participant_report/participant_critique/chair_synthesis/debate_*
      // handoffs. `historyLimit` (DurablePmRuntime's own default: 12,
      // unrelated to and independent of `maxTurns`) was never wired here,
      // so a real live D3 canary (3 participants x 2 Council rounds x
      // Debate) needed exactly 13 completed turns to reach Round-1 debate
      // synthesis -- one past the 12-turn window -- which silently evicted
      // chair_plan (turn 0) from what the driver could see on the very next
      // decide() call, throwing COUNCIL_CHAIR_PLAN_MISSING immediately
      // after a real, fully successful Round-1 Brief/3-Responses/Synthesis
      // sequence (docs/p19/06_P19_D3_LIVE_DEBATE_CANARY_REPORT.md). Every
      // pre-P19 Council configuration happened to stay accidentally safe
      // (4 participants x 2 rounds = 11 turns, one under the ceiling) and
      // every D1/D2 fixture test happened to land at/under exactly 12
      // turns, so this was never triggered before. Fix: one shared turn
      // budget for both fields -- historyLimit must never be less than
      // maxTurns for a council/debate driver, since this is DSH's own
      // orchestration bookkeeping, not LLM prompt context (the actual
      // per-step prompts remain separately bounded via truncateForBudget()/
      // the REPORT_CHAR_BUDGET family, completely unrelated to this
      // parameter). SINGLE's own DurablePmRuntime construction below is
      // unaffected -- it never set historyLimit before and still doesn't.
      const councilTurnBudget=councilMaxTurns(council);
      return new DurablePmRuntime({driver,workflowRunner:stepWorkflowRunner,peerRelay,repository:pmRepository,profileRegistry,pmProfileId:profileId,ownerControl,maxTurns:councilTurnBudget,historyLimit:councilTurnBudget,taskLog});
    }
    // P10-R0.2.1 Part F: every non-council (owner SINGLE) task run gets the
    // OWNER_SINGLE timeout policy class (300_000ms — pm-execution-timeout-
    // policy.mjs) here, at this one composition point — never the Claude
    // bridge's own blind 120_000ms fallback (the T2 owner-live failure this
    // wave remediates). `executionOptions` is a separate, explicit field
    // from `extraCtx` (Part B) — never folded into it.
    // P10-R0.2.4 Part S: `runtimeClass` (stamped ONCE at SUBMIT_TASK time —
    // owner-task-controller.mjs — from whether the dispatch carried a
    // GIT_FILE task_source) selects the LONG stage (1_800_000ms) instead
    // of the NORMAL OWNER_SINGLE stage (300_000ms). Every existing caller
    // that omits `runtimeClass` (every pre-existing test/call site) is
    // byte-for-byte unaffected — `null`/anything other than the literal
    // string `'LONG'` resolves to the exact same OWNER_SINGLE class as
    // before this wave.
    return new DurablePmRuntime({driver:resolveDriver(profileRegistry.get(profileId),{project:executionProject,extraCtx:{taskId,pmRunId,taskMode:'SINGLE'},executionOptions:resolveExecutionOptions(runtimeClass==='LONG'?EXECUTION_STAGE.OWNER_SINGLE_LONG:EXECUTION_STAGE.OWNER_SINGLE)}),workflowRunner:workflowRunnerForProject(project,taskContext),peerRelay,repository:pmRepository,profileRegistry,pmProfileId:profileId,ownerControl,taskLog});
  };
  const startPm=async({task,project,pmProfileId,pmRunId})=>{const runtime=createRuntime({profileId:pmProfileId,project,council:task.context?.council??null,ownerTask:task.body,pmRunId,taskId:task.id,runtimeClass:task.context?.runtimeClass??null,transportVersion:resolveTransportVersion(task.context),taskContext:task.context??null});const prepared=runtime.prepare({objective:task.body,context:task.context,pmRunId});await coordination.registerWorkIdentity(pmWorkIdentity({taskId:task.id,pmRunId}));return prepared;};
  // P12-R5C Part C: REQUEST_CANCEL's real production wiring was missing
  // entirely — `scripts/p5-runtime.mjs` never supplied `deps.requestCancellation`/
  // `deps.resolveWorkItem`, so OwnerTaskController.requestCancel() has always
  // thrown 'CANCELLATION_UNAVAILABLE' unconditionally in the real deployed
  // runtime, regardless of task state or channel. This is NOT a new
  // cancellation engine: `coordination.requestCancellation(leaderFence,
  // workItemId)` (PostgresCoordinationStore) and the deterministic
  // `pmWorkIdentity()` derivation (production-pm-worker.mjs — the SAME
  // function `startPm` above already uses to register this exact work
  // identity) already exist; only the two small adapter closures connecting
  // them to OwnerTaskController were never written.
  // `currentCoordinatorFence` mirrors the EXACT existing pattern
  // `buildCoordinator()` below already uses for AwaitOwnerCloser's
  // `getLeadershipFence` — the coordinator's own most-recently-advanced
  // fence, live, updated on every poll tick. `null` until the coordinator
  // has actually started and ticked at least once (or if this process never
  // runs the coordinator role at all) — cancellation then fails honestly
  // with the SAME 'CANCELLATION_UNAVAILABLE' code, never a crash and never a
  // silently-accepted no-op.
  let currentCoordinatorFence=null;
  const resolveWorkItem=async(taskId)=>{
    const task=agentBusRepository.getOwnerTask(taskId);
    if(!task)throw new OwnerControlError('task not found','TASK_NOT_FOUND');
    const commandId=task.context?.ownerCommandId;
    if(typeof commandId!=='string'||!commandId)throw new OwnerControlError('task has no resolvable PM run lineage for cancellation','CANCELLATION_UNAVAILABLE');
    return pmWorkIdentity({taskId,pmRunId:deterministicOwnerId('pmrun',commandId)});
  };
  const requestCancellation=async(workItemId)=>{
    if(!currentCoordinatorFence)throw new OwnerControlError('cancellation requires an active coordinator lease','CANCELLATION_UNAVAILABLE');
    return coordination.requestCancellation(currentCoordinatorFence,workItemId);
  };
  // P12-R3 Part H / P15-REM-R3-B (P15-D-002): the ONE pre-flight "does this
  // referenced prior task's durable record actually exist" check — a plain
  // read-only filesystem lookup (task-context-index.mjs), never a git
  // operation, never a second resolution subsystem. Returns the found
  // task.json entry, or `null` (never throws) so a caller can refuse with a
  // typed TASK_CONTEXT_REQUIRED_UNAVAILABLE before any pm_run is ever
  // created. Hoisted above `taskController` (was previously defined further
  // down, alongside `taskFileResolver`) specifically so it can be passed
  // into `OwnerTaskController` below — the shared submission authority ALL
  // ingress paths (Desktop pipe, Telegram canonical, Telegram alias
  // shorthand) go through, closing the gap where only the Desktop pipe
  // consumed this resolver.
  const projectsById=new Map(config.projects.map(p=>[p.id,p]));
  const requiredContextResolver=async({projectId,taskId})=>{
    const project=projectsById.get(projectId);
    if(!project)return null;
    // P24.1G7A: the durable, non-Git history root is checked FIRST (every
    // task materialized after this migration lands there); a project's
    // pre-migration `docs/history/**` inside its own repo checkout is the
    // bounded legacy fallback for a task materialized before the switch —
    // never the reverse (the durable root is now the source of truth going
    // forward). `resolveProjectHistoryRoot` is `null` for every existing
    // test/DI caller (opt-in), so this is a byte-for-byte no-op fallback to
    // legacy-only lookup unless a real deployment opted in.
    if(resolveProjectHistoryRoot){
      const durable=findTaskHistoryEntry(resolveProjectHistoryRoot(projectId),taskId);
      if(durable)return durable;
    }
    return findTaskHistoryEntry(project.repo_path,taskId);
  };
  // P20.8 §7 — production transport admission, wired at the ONE existing
  // SUBMIT_TASK authority (OwnerTaskController.submit()). `deps.
  // resolveNewTaskTransportVersion`, when supplied, decides `artifact_v1`
  // vs `legacy` for a NEW task from `{project,council,runtimeClass}` only
  // (never task body text). Absent for every pre-P20.8 caller — every
  // existing test/deployment keeps stamping nothing (legacy, byte-for-byte
  // unchanged context shape).
  const resolveProjectForGit=config.projectsPath?async({projectId})=>{
    const projects=await loadP5Projects(config.projectsPath,{root:config.projectConfigRoot});
    return projects.find(project=>project.id===projectId)??null;
  }:null;
  // P24.1G6A §15 — the ONE shared, in-process, same-physical-workspace
  // admission lock this composition's `taskController` uses. Real
  // production always runs coordinator+worker roles in this SAME process
  // (this composition builds both), so this single instance is sufficient
  // to fence admission against itself; a future distributed deployment
  // would need a cross-process lock instead (out of this phase's scope).
  const workspaceAdmissionLock=createWorkspaceAdmissionLock();
  // P24.3B §20 — isolated task-workspace allocation for NEW Git-bound
  // tasks stays OFF unless a caller explicitly supplies BOTH
  // `deps.enableTaskWorkspaceIsolation` (truthy) AND `deps.
  // taskWorkspaceRoot` (the DSH-owned root). Neither is supplied by
  // `scripts/p5-runtime.mjs` yet (same "capability shipped, deployment
  // decision separate" posture as `enableProductionArtifactWiring`) —
  // every real deployment and every existing test that omits these two
  // keys gets `ensureTaskWorkspace:null` on OwnerTaskController, which is
  // itself the OFF switch (see that class's own constructor docstring).
  const taskWorkspaceRoot=typeof deps.taskWorkspaceRoot==='string'&&deps.taskWorkspaceRoot?deps.taskWorkspaceRoot:null;
  const taskWorkspaceIsolationEnabled=Boolean(deps.enableTaskWorkspaceIsolation&&taskWorkspaceRoot);
  const taskController=new OwnerTaskController({repository:agentBusRepository,startPm,requestCancellation,resolveWorkItem,supersedeInteractions:deps.supersedeInteractions,taskDiagnostics:taskDiagnosticsFactory,resolveRequiredContext:requiredContextResolver,resolveProjectForGit,resolveTransportVersion:deps.resolveNewTaskTransportVersion,workspaceAdmissionLock,...(taskWorkspaceIsolationEnabled?{ensureTaskWorkspace:deps.ensureTaskWorkspace??ensureTaskWorkspace,taskWorkspaceRoot}:{})});
  // P9-R0.4 Part J/W: `statusResolver` lets a Desktop deactivate/reactivate
  // (a write to the SAME pm-profiles.yaml `config.pmProfilesPath` was
  // loaded from) take effect on the very next SUBMIT_TASK this process
  // handles — no restart required. `config.pmProfilesPath` is absent only
  // for a composition built directly from an in-memory `config` object
  // (tests, prototypes) rather than `loadP5ProductionConfig()`; those fall
  // back to the frozen snapshot's own `.status`, exactly like before this
  // wave.
  const pmProfileStatusStore=config.pmProfilesPath?new PmProfileStatusStore(config.pmProfilesPath):null;
  // P9-R0.4.2 Part A/B: `statusListResolver` reuses the SAME
  // pmProfileStatusStore instance `statusResolver` above already wraps —
  // never a second independent lifecycle store — so Telegram's
  // GET_PM_PROFILES read (/profiles, /pms, /aliases) sees the identical
  // fresh lifecycle truth the SUBMIT_TASK gate already does.
  const ownerService=new OwnerControlService({repository:ownerRepository,taskController,projects:config.projects,pmProfiles:profileRegistry.list(),statusResolver:pmProfileStatusStore?(id)=>pmProfileStatusStore.getStatus(id):null,statusListResolver:pmProfileStatusStore?()=>pmProfileStatusStore.getAllStatuses():null});
  // P8-R0: `pmProfiles`/`aliasRegistry` are purely additive — presentation/
  // routing sugar for `/pms`, `/profiles`, `/aliases`, the mobile shorthand,
  // and the richer shorthand ack (Part F/I/J). `config.telegramAliases` is
  // always present (possibly with zero configured aliases — Part O), so
  // canonical-only deployments are unaffected.
  // P10-R0.2.4 Part D/I: DSH itself resolves a `--task-file` dispatch —
  // never the model (Part D stop condition:
  // TASK_FILE_RETRIEVAL_REQUIRES_MODEL_GIT_ACTION). Closes over
  // `config.projects` (already validated/absolute `repo_path` per project
  // — p5-production-config.mjs) so the caller (TelegramOwnerAdapter) only
  // ever needs `projectId`. `TaskSourceError`s propagate as-is — the
  // adapter renders them via `renderTaskFileError()`.
  const taskFileResolver=async({projectId,ref,path})=>{
    const project=projectsById.get(projectId);
    if(!project)throw new TaskSourceError('unknown project for task-file dispatch','TASK_FILE_REPOSITORY_MISMATCH',{});
    return resolveGitFileTaskSource({projectRepoPath:project.repo_path,requestedRef:ref,path});
  };
  // P10-R0.2.4.2 Part D: the SAME taskDiagnosticsFactory as everywhere else
  // in this composition (already opt-in/null unless deps.taskDiagnosticsRoot
  // is supplied) — a preflight `--task-file` failure gets a bounded
  // dispatch-scoped bundle under the identical `logs/tasks/` root real task
  // bundles use (Part I/U), never a second diagnostics subsystem.
  let adapter=null;let ownerRuntime=null;let notifier=null;let interactionNotifier=null;let terminalNotifier=null;
  if(config.telegram){
    adapter=new TelegramOwnerAdapter({token:config.telegram.token,ownerUserId:config.telegram.ownerUserId,ownerChatId:config.telegram.ownerChatId,projects:config.projects,pmProfiles:profileRegistry.list(),aliasRegistry:config.telegramAliases,service:ownerService,fetchImpl:deps.fetchImpl??fetch,maxUpdatesPerPoll:deps.maxUpdatesPerPoll,taskFileResolver,taskDiagnosticsFactory});
    sendLongTaskNotice=(text)=>adapter.send(text);
    interactionNotifier=new OwnerInteractionNotifier({repository:ownerRepository,send:text=>adapter.send(text)});terminalNotifier=new OwnerTerminalResultNotifier({repository:ownerRepository,pmRepository,send:text=>adapter.send(text)});notifier={flush:async()=>{const interactions=await interactionNotifier.flush();const terminals=await terminalNotifier.flush();return{interactions,terminals};}};ownerRuntime=new OwnerRuntime({adapter,notifier,pollIntervalMs:config.telegram.pollIntervalMs,notifierIntervalMs:config.telegram.pollIntervalMs,backoffMs:config.telegram.pollIntervalMs});
  }else{
    sendLongTaskNotice=async()=>{};
    interactionNotifier={flush:async()=>[]};
    terminalNotifier={flush:async()=>[]};
    notifier={flush:async()=>({interactions:[],terminals:[]})};
    ownerRuntime={running:false,draining:false,requestDrain(){},async run({signal}={}){if(signal?.aborted)return{status:'STOPPED',cycles:0};await new Promise(resolve=>signal?.addEventListener('abort',resolve,{once:true}));return{status:'STOPPED',cycles:0};}};
  }
  let coordinatorRuntime=null;let closer=null;let workerRuntime=null;let pmWorkerRuntime=null;let closed=false;
  async function buildCoordinator(){if(coordinatorRuntime)return coordinatorRuntime;let currentFence=null;closer=new AwaitOwnerCloser({ownerRepository,coordinationStore:coordination,getLeadershipFence:()=>currentFence});let reconciler=null;
    // Safety gate: the periodic mutating reconciler is instantiated ONLY in
    // dry-run (scan+classify, zero mutation) or explicitly-configured enabled
    // (pre-gate 30s leader-fenced auto-repair) mode. In the default 'disabled'
    // mode no reconciler object exists at all, so ProductionCoordinatorRuntime
    // never even scans — no candidates, no reads of reconciliation state, no
    // mutation path whatsoever.
    if(reconciliationMode!==RECONCILIATION_MODE.DISABLED&&typeof coordination.observeReconciliationResources==='function'){const source=new CompositeReconciliationSource([new SqliteReconciliationRepository({store:sqlite}),new PostgresCancellationReconciliationRepository({coordinationStore:coordination,sqliteStore:sqlite})]);reconciler=new StuckTaskReconciler({source,resourceGuard:new ConservativeResourceGuard({coordinationStore:coordination,providerProcesses:()=>activeOwnedProviderProcessCount()>0,workspaceOccupancy:()=>Boolean(pmWorkerRuntime?.activeSnapshot().length),providerSlots:()=>Boolean(pmWorkerRuntime?.activeSnapshot().length)}),leadershipGuard:new CoordinationLeadershipGuard(coordination),mode:reconciliationMode,onCandidate:reconciliationMode===RECONCILIATION_MODE.DRY_RUN?deps.onReconciliationCandidate??logDryRunCandidate:null});}
    coordinatorRuntime=new ProductionCoordinatorRuntime({coordinationStore:coordination,logicalCoordinatorId:config.coordinator.logicalId,leaseMs:config.coordinator.leaseMs,pollIntervalMs:config.coordinator.pollIntervalMs,reconciler,reconciliationIntervalMs:deps.reconciliationIntervalMs??30000,reconstruct:deps.reconstruct??(async()=>{}),advance:async({fence})=>{currentFence=fence;currentCoordinatorFence=fence;const result=await closer.runOnce();return deps.advance?deps.advance({fence,ownerClose:result}):result;}});await coordinatorRuntime.start({host_id:hostname()});return coordinatorRuntime;}
  // P13-R1: `deps.pmConcurrencyLimit` is the real production configuration
  // seam for the global active-task limit (§"CONFIGURATION" of the
  // architecture plan: "add it only to the real production composition/
  // configuration path"). P13-R8 accepted 2 as GLOBAL SAFE_DEFAULT; it
  // remains distinct from the still-uncharacterized HARD_MAX.
  // `resolveWorkIdentity` reuses the SAME `projectsById` map (and therefore
  // the SAME `project.workspace_id`, computed once by p5-production-
  // config.mjs's `validateProjects()`) that `taskFileResolver`/
  // `requiredContextResolver` above already close over -- never a second
  // registry.
  async function buildWorker(){if(workerRuntime)return workerRuntime;const incarnationId=createWorkerIncarnationId(config.worker.logicalId);const hostId=String(hostname()).replace(/[^A-Za-z0-9._:-]/g,'-').slice(0,128)||'localhost';const globalLimit=deps.pmConcurrencyLimit??2;await coordination.registerWorkerIncarnation({logical_worker_id:config.worker.logicalId,worker_incarnation_id:incarnationId,host_id:hostId,installed_profiles:[],capacity:{max_concurrency:globalLimit,reported_in_use:0}});const handler=new ProductionPmWorkHandler({coordinationStore:coordination,pmRepository,ownerRepository,taskRepository:agentBusRepository,projects:config.projects,createRuntime,taskDiagnosticsFactory,profileRegistry,enableRepoHistoryMaterialization,resolveProjectArtifactStore,resolveProjectHistoryRoot,...(deps.cleanupTaskWorkspace?{cleanupTaskWorkspace:deps.cleanupTaskWorkspace}:{})});const resolveWorkIdentity=(work)=>resolvePmWorkspaceIdentity({work,pmRepository,taskRepository:agentBusRepository,projects:projectsById});const resolveQueuedCancellation=(work)=>reconcileQueuedCancellation({work,coordinationStore:coordination,pmRepository});
    // P13-R4: `deps.backendConcurrencyLimits` is the real production seam
    // for the second admission dimension -- TEST VALUES only for this
    // gate (docs/p13/12_*.md), never a chosen product default. Omitted by
    // every caller that doesn't pass it, so backend capacity is simply
    // never enforced (no key has a configured limit) unless explicitly
    // opted into.
    const resolveBackendIdentity=(work)=>resolvePmBackendIdentity({work,pmRepository,taskRepository:agentBusRepository,profileRegistry});
    // P13-R5: `deps.resourcePressureGovernor` is the real production seam
    // for the whole-runtime resource-pressure gate (docs/p13/13_*.md) --
    // an object exposing `checkAdmission()` (see resource-pressure-
    // governor.mjs's createResourcePressureGovernor()). Omitted by every
    // caller that doesn't pass it (every pre-R5 test, and every
    // deployment until an owner explicitly opts in), so resource pressure
    // is simply never enforced -- byte-for-byte backward compatible.
    const pmWorker=new ProductionPmWorker({coordinationStore:coordination,handler,workerIncarnationId:incarnationId,leaseMs:config.worker.leaseMs,resolveWorkIdentity,resolveQueuedCancellation,resolveBackendIdentity,backendConcurrencyLimits:deps.backendConcurrencyLimits??null,resourcePressureGovernor:deps.resourcePressureGovernor??null,globalLimit});pmWorkerRuntime=pmWorker;const dispatch=new FencedDispatchCoordinator({coordinationStore:coordination,agentBusRepository});const provider=deps.provider??(async({work})=>completedResultForWork(work));const taskWorker=new MultiProcessTaskWorker({coordinationStore:coordination,dispatchCoordinator:dispatch,workerIncarnationId:incarnationId,provider,leaseMs:config.worker.leaseMs});workerRuntime=new ProductionWorkerRuntime({worker:new CompositeProductionWorker(pmWorker,taskWorker),pollIntervalMs:config.worker.pollIntervalMs});return workerRuntime;}
  // P11-R5 Part C: `pmProfiles.count`/`resolvable` now derive from the SAME
  // live `pmBackendStatus` array reloadPmProfiles() appends to (was
  // `config.profiles.length`, the frozen-at-startup count) — so a
  // hot-admitted profile is reflected here too, generically, for every
  // product.
  // P20.8 §16 — purely additive, non-gating readiness projection: whether
  // production artifact wiring is active, which projects have a configured
  // store, and (best-effort, never throws) the durable §8 capability-
  // evidence registry's own on-disk record count. Never affects the
  // top-level `ready` boolean — P20 wiring stays fully opt-in.
  function p20Readiness(){
    let evidenceRecords=null;
    if(capabilityEvidenceRegistry){try{evidenceRecords=Object.keys(capabilityEvidenceRegistry.read().records).length;}catch{evidenceRecords=null;}}
    return Object.freeze({
      enabled:enableProductionArtifactWiring,
      artifactStoresConfigured:productionArtifactStores?[...productionArtifactStores.keys()]:(artifactStore?[artifactStore.projectId]:[]),
      capabilityEvidence:{configured:Boolean(capabilityEvidenceRegistry),filePath:capabilityEvidenceRegistry?.filePath??null,recordCount:evidenceRecords},
    });
  }
  function readiness(){const pg=coordination?{reachable:true,schema:COORDINATION_SCHEMA_VERSION}:{reachable:false,schema:null};const sq=sqlite?.isOpen?{reachable:true,schema:SCHEMA_VERSION}:{reachable:false,schema:null};const profilesReady=pmBackendStatus.every(value=>value.available);const telegramReady=!config.telegram||Boolean(config.telegram.token);return Object.freeze({ready:Boolean(pg.reachable&&sq.reachable&&config.projects.length&&profilesReady&&telegramReady),postgres:pg,sqlite:sq,configuration:{valid:true},projects:{valid:true,count:config.projects.length},pmProfiles:{valid:true,resolvable:profilesReady,count:pmBackendStatus.length,backends:pmBackendStatus},telegram:config.telegram?{configured:true,token_present:Boolean(config.telegram.token)}:{configured:false,token_present:false},ownerEnrollment:{valid:true},reconciliation:{mode:reconciliationMode,periodicReconciler:reconciliationMode===RECONCILIATION_MODE.DISABLED?'NOT_CONSTRUCTED':(coordinatorRuntime?.reconciler?'CONSTRUCTED':'PENDING')},coordinator:{constructed:Boolean(coordinatorRuntime),running:Boolean(coordinatorRuntime&&!coordinatorRuntime.draining),leadership:coordinatorRuntime?.fence?'LEADER':'NONE'},worker:{constructed:Boolean(workerRuntime),running:Boolean(workerRuntime&&!workerRuntime.draining),available:Boolean(workerRuntime)},ownerRuntime:{constructed:true,running:ownerRuntime.running},notifier:{constructed:true,running:ownerRuntime.running},awaitOwnerCloser:{constructed:Boolean(closer),running:Boolean(closer?.running)},p20:p20Readiness()});}
  function requestDrain(){ownerRuntime.requestDrain();coordinatorRuntime?.requestDrain();workerRuntime?.requestDrain();}
  // P13-R1.1 D4 (§13 of the architecture plan; docs/p13/05_*.md remediates
  // the R1.0 version of this function): stop admitting FIRST
  // (`requestDrain()`, unchanged), then WAIT for real, CONFIRMED settlement
  // of any in-flight PM executions before closing the shared SQLite/
  // Postgres stores they may still be writing to.
  //
  // `drainActive()` (production-pm-worker.mjs) is a grace-period-then-
  // abort-then-confirm sequence, not a blind timeout: it gives active work
  // a grace period to finish on its own, then fires that slot's OWN
  // AbortController (the same canonical shutdown/cancel signal every real
  // backend call already consumes via raceWithWatchdog()) and AWAITS the
  // resulting settlement, bounded by a generous last-resort ceiling.
  //
  // `closed` is set only once stores are ACTUALLY closed (not before the
  // drain attempt), so a caller whose drain could not be confirmed may
  // retry `close()` later -- it is deliberately NOT set here first the way
  // the R1.0 version did, because that made a failed close permanent.
  //
  // If drain still cannot confirm settlement after that (the execution's
  // current code path does not consume the abort signal at all -- see
  // docs/p13/05_*.md "Known limitations"), stores are NOT closed. This is
  // the one case this function refuses to silently accept: it throws
  // rather than close shared persistence out from under a possibly-still-
  // running handler. The process is left for the existing outer
  // supervisor's own force-stop/OS-level kill to reclaim -- exactly what
  // an unresponsive runtime already required before P13 (Desktop's
  // RuntimeSupervisor already has a `forceStop()` escape hatch for this).
  // `drainGracePeriodMs`/`drainTimeoutMs`, when supplied, override
  // ProductionPmWorker.drainActive()'s own defaults -- purely for
  // deterministic testing of a genuinely-unresponsive execution without
  // waiting out the real 600s ceiling; every real caller (scripts/
  // p5-runtime.mjs) omits both and gets the documented production bounds.
  async function close({drainGracePeriodMs,drainTimeoutMs}={}){
    if(closed)return;
    requestDrain();
    if(workerRuntime){
      const drainResult=await workerRuntime.drainActive({gracePeriodMs:drainGracePeriodMs,timeoutMs:drainTimeoutMs});
      if(!drainResult.settled)throw Object.assign(new Error('drain could not confirm all active PM executions settled before shutdown -- refusing to close shared stores'),{code:'DRAIN_SETTLEMENT_UNCONFIRMED',remaining:drainResult.remaining});
    }
    closed=true;
    await sqlite.close();await ownerRepository.close();await coordination.close();
  }
  // P11-R4.2 Part A/E/J — the bounded hot-reload the owner asked for
  // instead of a hidden runtime restart. This process's `config`/
  // `profileRegistry`/`ownerService`/`adapter` are otherwise frozen for
  // its whole lifetime (loadP5ProductionConfig() runs exactly ONCE, in
  // scripts/p5-runtime.mjs) — a PM profile Desktop writes to
  // `pm-profiles.yaml` while this process is already running is invisible
  // until something calls this. Re-reads ONLY pm-profiles.yaml (never
  // touches postgres/sqlite/projects/coordinator/worker), admits every
  // genuinely NEW id (already-known ids are always skipped — Part C:
  // existing profile identity is never re-validated or re-admitted, so it
  // can never change underneath a running process) into the SAME live
  // profileRegistry/ownerService/adapter instances via mutate-in-place
  // methods, then re-runs the EXACT SAME loadReconciledTelegramAliases()
  // startup already uses — same high-water/non-recycling invariants, same
  // function, never a second alias algorithm. A structurally invalid new
  // entry is skipped and reported, never thrown past this function (one
  // bad profile in the file must never crash the running owner runtime or
  // block admission of the others). Returns a bounded, non-secret summary
  // — never any raw profile field beyond id/alias.
  async function reloadPmProfiles(){
    if(!config.pmProfilesPath)return Object.freeze({admitted:[],rejected:[],aliasesAssigned:{}});
    let doc;
    try{doc=parse(await readFile(config.pmProfilesPath,'utf8'));}
    catch(error){return Object.freeze({admitted:[],rejected:[{id:null,code:'PM_PROFILES_FILE_UNREADABLE',message:String(error?.message??'read failed').slice(0,200)}],aliasesAssigned:{}});}
    const rawEntries=Array.isArray(doc?.pm_profiles)?doc.pm_profiles:[];
    const admitted=[];const rejected=[];
    for(const raw of rawEntries){
      if(typeof raw?.id!=='string'||profileRegistry.hasProfile(raw.id))continue;
      try{
        const entry=profileRegistry.admit(raw);
        ownerService.admitPmProfile(entry);
        // P11-R5 Part C/D/E/G: the SAME configuration-validity check (never
        // a live/network probe — see production-pm-backend-registry.mjs's
        // inspect(), a synchronous CLI-installed/backend-registered check)
        // the startup path already computes into `pmBackendStatus` for
        // EVERY profile, generically, for whichever product this entry
        // happens to be — never a per-backend special case. This is what
        // fixes the actual "unavailable" bug: `pmBackendStatus` (and
        // therefore Desktop's connections:list / pm:profiles readiness
        // projection) previously stayed frozen at composition time, so a
        // hot-admitted profile was simply ABSENT from it and defaulted to
        // unavailable regardless of product. Appending here — `array.push`
        // on the SAME array object `readiness()`'s closure already reads —
        // means the very next readiness()/pm:profiles call sees it, no
        // restart, no per-product branch.
        pmBackendStatus.push(Object.freeze({profile_id:entry.id,model:entry.model,reasoning:entry.reasoning,status:entry.status,session_kind:entry.session_kind,...(typeof resolveDriver.inspect==='function'?resolveDriver.inspect(entry):{available:false,code:'PM_BACKEND_RESOLVER_UNINSPECTABLE'})}));
        admitted.push(entry.id);
      }catch(error){
        rejected.push({id:typeof raw?.id==='string'?raw.id:null,code:'PM_PROFILE_INVALID',message:String(error?.message??'invalid profile').slice(0,200)});
      }
    }
    if(adapter)adapter.refreshRouting({pmProfiles:profileRegistry.list()});
    const aliasesAssigned={};
    if(admitted.length&&config.telegramAliasesStatus?.path){
      const{registry:refreshedAliases}=await loadReconciledTelegramAliases({path:config.telegramAliasesStatus.path,registeredProjectIds:[...projectsById.keys()],registeredPmProfileIds:profileRegistry.list().map(p=>p.id)});
      if(adapter)adapter.refreshRouting({aliasRegistry:refreshedAliases});
      for(const id of admitted){const alias=refreshedAliases.pmAliasFor?.(id);if(alias)aliasesAssigned[id]=alias;}
    }
    return Object.freeze({admitted,rejected,aliasesAssigned});
  }
  function runtimeTaskStatus(){const pmWorker=workerRuntime?.worker?.workers?.find(worker=>typeof worker.ownerStatusSnapshot==='function');return pmWorker?.ownerStatusSnapshot()??Object.freeze({global_limit:deps.pmConcurrencyLimit??2,active_count:0,active:[],rejected:[],observed_at:Date.now()});}
  return Object.freeze({config,coordination,ownerRepository,sqlite,agentBusRepository,pmRepository,profileRegistry,workflowRunnerForProject,
    // P24.3B — exposed for the exact same reason `workflowRunnerForProject`
    // already is: a test needs to drive the real per-run runtime-
    // construction logic (execution-scoped project routing, artifact_v1
    // gating, Council/SINGLE branch selection) directly, without spinning
    // up the full async coordinator/worker polling loop. Not itself a new
    // production call path — every real execution still reaches this
    // through `startPm`/`ProductionPmWorkHandler.execute()` exactly as
    // before.
    createRuntime,
    taskController,ownerService,adapter,notifier,interactionNotifier,terminalNotifier,ownerRuntime,buildCoordinator,buildWorker,requestDrain,readiness,runtimeTaskStatus,reloadPmProfiles,resolveTaskFile:taskFileResolver,resolveRequiredContext:requiredContextResolver,artifactStore,reportInvoker,artifactFinalizer,councilArtifactRuntime,close,
    // P20.8 §6/§8 — production artifact wiring surface, for the operator-
    // only capability probe seam (§8.2) and readiness/tests. Every field
    // here is additive; nothing above reads or depends on them.
    enableProductionArtifactWiring,resolveProjectArtifactStore,capabilityEvidenceRegistry,resolveProjectReportBackendResolver,
  });
}
