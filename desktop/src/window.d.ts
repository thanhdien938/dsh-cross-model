// Ambient type for the closed `desktop` API the preload script exposes via
// contextBridge (see electron/preload/preload.ts). This file documents the
// renderer-facing contract; it is not consulted by the Vite/esbuild build
// (which does not type-check), only by editors and an explicit `tsc`
// invocation against tsconfig.json.
export {};

interface OwnerCommandOutcome {
  clientMessageId: string;
  commandId: string;
  state: 'PENDING' | 'SENDING' | 'AWAITING_ACK' | 'COMPLETED' | 'CONFLICT' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL';
  result?: unknown;
  errorCode?: string;
}

interface PmProfile {
  id: string;
  product: string;
  model: string | null;
  sessionKind: string;
  available: boolean;
  // P9-R0.4 Part A/C: the one canonical "backend · model · reasoning"
  // label (src/pm/pm-profile-display.mjs), computed main-process-side —
  // this list itself already only ever contains ACTIVE profiles (Part N).
  displayLabel: string;
}

interface AddFolderOutcome {
  ok: boolean;
  projectId?: string;
  restartRequired?: boolean;
  code?: string;
  message?: string;
  existingProjectId?: string;
}

interface BootstrapPathStatus {
  state: string;
  path: string | null;
  source: 'env' | 'setting' | 'dev-fallback' | null;
}
interface BootstrapStatusPayload {
  requiresFirstRun: boolean;
  status: {
    repoRoot: BootstrapPathStatus;
    productionConfig: BootstrapPathStatus;
    envFile: BootstrapPathStatus;
    requiredEnvNames: { name: string; present: boolean }[];
    readyToStart: boolean;
  } | null;
}
interface BootstrapPickResult {
  ok: boolean;
  path?: string;
  code?: string;
  message?: string;
  restartRequired?: boolean;
}

type RelayRunnerState = 'UNCONFIGURED' | 'REGISTERED_OFFLINE' | 'STARTING' | 'RUNNING_ONLINE_UNVERIFIED' | 'ONLINE_IDLE' | 'ONLINE_BUSY' | 'DEGRADED' | 'STOPPING' | 'FAILED';
interface RelayRunnerStatus {
  state: RelayRunnerState;
  registration: 'REGISTERED' | 'NOT_CONFIGURED' | 'INVALID';
  ownership: 'APP_OWNED' | 'EXTERNAL' | 'NONE';
  enabled: boolean;
  autoStart: boolean;
  runnerPath: string | null;
  version: string | null;
  pid: number | null;
  lastChecked: string;
  lastError: { code: string; message: string } | null;
}
interface RelayRunnerOperationResult { ok: boolean; status: RelayRunnerStatus; code?: string; message?: string; }
interface RelayRunnerHealth { lastChecked: string; lastSuccessfulOnlineEvidence: string | null; retryCount: number; nextRetryAt: string | null; }

declare global {
  // Ambient (not module-scoped) so any renderer component can reference
  // these by bare name without an import, matching how `Window.desktop`
  // itself is declared here.

  // P7: mirrors src/pm/council/council-projection.mjs's projectCouncil()
  // shape — a pure, read-only projection of a council's durable PmRun. Kept
  // as a loose shape here (not re-deriving the exact union) since this is a
  // renderer-side display contract, not a validation boundary.
  interface CouncilParticipantStatus {
    profileId: string;
    status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  }
  interface CouncilProjection {
    councilId: string;
    chairProfileId: string;
    participantProfileIds: string[];
    rounds: number;
    strategy: string;
    phase: 'PLANNING' | 'ROUND_1_INDEPENDENT_ANALYSIS' | 'ROUND_2_CRITIQUE' | 'CHAIR_SYNTHESIS' | 'DEBATE_ROUND_1' | 'DEBATE_ROUND_2' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    status: string;
    degraded: boolean | null;
    // P19-D6: passed through verbatim from council-projection.mjs's
    // projectCouncil() — the same normalized W4R6 scalar, never re-derived.
    // `null` for every council with no selected implementation participant.
    implementationParticipantId: string | null;
    participants: CouncilParticipantStatus[];
    round1: Array<{ profileId: string; ok: boolean | null; report: { analysis: string | null; recommendation: string | null; risks: string[]; uncertainties: string[]; reason: string | null } | null }>;
    round2: Array<{ profileId: string; ok: boolean | null; critique: { criticisms: string[]; agreements: string[]; revisedRecommendation: string | null; remainingDisagreements: string[]; reason: string | null } | null }>;
    synthesis: { ok: boolean; output: string | null; reason: string | null } | null;
    // P19-D4: passed through verbatim from council-projection.mjs's
    // projectCouncil() (D2) — the IPC layer (readProjection.ts's
    // getCouncil()/getCouncilRuns()) never filters this object, so this
    // field reaches the renderer with zero backend changes needed this
    // wave. `{enabled:false,...}` for every debate-disabled council —
    // never absent, never undefined.
    debate: {
      enabled: boolean;
      maxRounds: number;
      currentRound: number | null;
      status: 'NOT_ENABLED' | 'PENDING' | 'ROUND_1_IN_PROGRESS' | 'ROUND_1_COMPLETE' | 'ROUND_2_IN_PROGRESS' | 'COMPLETE';
      completedRounds: number[];
      currentRoundPhase: 'BRIEF' | 'RESPONSES' | 'SYNTHESIS' | 'DONE' | null;
      finalReportAvailable: boolean;
      finalReport: { round: number; output: string | null; continueDebate: boolean; unresolvedQuestions: string[]; engineForcedStop: boolean } | null;
    };
    finalOutput: string | null;
    error: { name?: string; message?: string; code?: string } | null;
    projectId?: string | null;
    taskId?: string | null;
  }

  interface BackendExecutionLogEntry {
    seq: number;
    timestamp: string;
    backendProduct: string;
    profileId: string | null;
    projectId: string | null;
    taskId: string | null;
    pmRunId: string | null;
    runId: string | null;
    phase: string | null;
    stream: string | null;
    eventKind: string | null;
    message: string;
    cwd: string | null;
    model: string | null;
    pid: number | null;
    exitCode: number | null;
    durationMs: number | null;
    parserOutcome: string | null;
    status: string | null;
  }

  interface BackendRunState {
    badge: 'idle' | 'running' | 'completed' | 'failed';
    runId: string | null;
    projectId: string | null;
    taskId: string | null;
    profileId: string | null;
    cwd: string | null;
    model: string | null;
    startedAt: string | null;
    updatedAt: string | null;
  }

  // P10-R0.2.4.1 Part J/K: owner-visible LONG-task runtime/liveness
  // projection — see backendExecutionLogService.ts's own docstring.
  interface LongTaskRuntimeState {
    taskId: string;
    pmRunId: string | null;
    projectId: string | null;
    profileId: string | null;
    product: string | null;
    pid: number | null;
    startedAt: string | null;
    hardDeadlineMs: number;
    liveness: 'ACTIVE' | 'QUIET_RUNNING' | 'STALLED' | 'EXITED' | null;
    lastActivityKind: string | null;
    lastActivityAgeMs: number | null;
    snapshotAt: string;
    sandboxState: string | null;
    processExited: boolean;
    exitCode: number | null;
    hardDeadlineReached: boolean;
    updatedAt: string;
  }

  interface Window {
    desktop: {
      bootstrap: {
        status: () => Promise<BootstrapStatusPayload>;
        pickRepoRoot: () => Promise<BootstrapPickResult | null>;
        pickProductionConfig: () => Promise<BootstrapPickResult | null>;
        pickEnvFile: () => Promise<BootstrapPickResult | null>;
        restartApp: () => Promise<void>;
      };
      runtime: {
        status: () => Promise<import('../electron/main/types').RuntimeStatus>;
        start: () => Promise<void>;
        stop: () => Promise<void>;
        restart: () => Promise<void>;
        forceStop: () => Promise<void>;
        onStatusChange: (callback: (status: import('../electron/main/types').RuntimeStatus) => void) => () => void;
      };
      relayRunner: {
        getStatus: () => Promise<RelayRunnerStatus | null>;
        refresh: () => Promise<RelayRunnerStatus | null>;
        start: () => Promise<RelayRunnerOperationResult | null>;
        stop: () => Promise<RelayRunnerOperationResult | null>;
        restart: () => Promise<RelayRunnerOperationResult | null>;
        getLogs: () => Promise<string[]>;
        getHealth: () => Promise<RelayRunnerHealth | null>;
        // P0-3: no `runnerPath` field — see preload.ts.
        updateSettings: (settings: { enabled: boolean; autoStart: boolean }) => Promise<RelayRunnerOperationResult | null>;
        pickFolder: () => Promise<RelayRunnerOperationResult | null>;
        onStatusChange: (callback: (status: RelayRunnerStatus) => void) => () => void;
      };
      projects: {
        list: () => Promise<import('../electron/main/types').Project[]>;
      };
      // P15-REM-R3-G (P15-D-012): a typed ProjectionResult — a PostgreSQL-
      // or SQLite-only failure must never discard the other source's rows
      // (see Timeline.tsx).
      timeline: {
        get: (projectId: string | null, options: any) => Promise<import('../electron/main/services/projectionResult').ProjectionResult<import('../electron/main/types').TimelineEntry[]>>;
      };
      // P15-REM-R3-F (P15-D-014): a typed ProjectionResult, not a bare
      // array — a read failure must never be indistinguishable from "no
      // approval pending" (see ApprovalPanel.tsx).
      inbox: {
        list: (projectId: string | null) => Promise<import('../electron/main/services/projectionResult').ProjectionResult<import('../electron/main/types').InboxItem[]>>;
      };
      // P15-REM-R3-G (P14-A4-001): a typed ProjectionResult — a malformed
      // row must never discard healthy rows (see BackendRuns.tsx).
      runs: {
        list: (projectId: string | null, options?: { limit?: number; status?: string }) => Promise<import('../electron/main/services/projectionResult').ProjectionResult<import('../electron/main/types').BackendRun[]>>;
      };
      // P15-REM-R3-G (P15-D-015): a typed ProjectionResult — a read failure
      // must never unmount the task-status pane (see MultiTaskControl.tsx).
      tasks: {
        runtimeStatus: () => Promise<import('../electron/main/services/projectionResult').ProjectionResult<import('../electron/main/types').MultiTaskStatus>>;
      };
      // P7 Part M/M1: Council panel — product-level surface, distinct from
      // Backend Runs' debug surface above.
      council: {
        list: (projectId: string | null, options?: { limit?: number }) => Promise<import('../electron/main/services/projectionResult').ProjectionResult<CouncilProjection[]>>;
        get: (pmRunId: string) => Promise<import('../electron/main/services/projectionResult').ProjectionResult<CouncilProjection | null>>;
      };
      connections: {
        list: () => Promise<import('../electron/main/types').Connection[]>;
        onChanged: (callback: (info?: { product?: string }) => void) => () => void;
      };
      logs: {
        runtime: (options: any) => Promise<any[]>;
      };
      // P6-W3-R3 Part B: READ-ONLY execution logs for the four production
      // backends. No write/command method exists on this surface.
      execLogs: {
        list: (
          product: string,
          options?: { afterSeq?: number; limit?: number },
        ) => Promise<{ entries: BackendExecutionLogEntry[]; truncated: boolean; latestSeq: number }>;
        statuses: () => Promise<Record<string, BackendRunState>>;
      };
      // P10-R0.2.4.1 Part J/K/M: read-only, poll-only. No stdin, no task
      // control, no raw event stream.
      longTasks: {
        statuses: () => Promise<LongTaskRuntimeState[]>;
      };
      project: {
        arm: (projectId: string) => Promise<string | null>;
        disarm: () => Promise<string | null>;
        getArmed: () => Promise<string | null>;
        onArmedChanged: (callback: (projectId: string | null) => void) => () => void;
        addFolder: (args: { folderPath: string; displayName?: string; defaultPmProfileId: string; force?: boolean }) => Promise<AddFolderOutcome>;
      };
      dialogs: {
        pickFolder: () => Promise<string | null>;
      };
      owner: {
        submitTask: (args: { projectId: string; pmProfileId: string; body: string; council?: { participantProfileIds: string[]; rounds: number; implementationParticipantId?: string; debate?: { enabled: boolean; maxRounds?: 1 | 2 } }; taskFile?: { ref: string; path: string }; lifecycle?: { durability: 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE'; commitLocal?: boolean; pushRemote?: boolean; requestReview?: boolean; remoteName?: string } }) => Promise<OwnerCommandOutcome>;
        replyToInteraction: (args: { projectId: string; interactionId: string; expectedRevision: number; text: string }) => Promise<OwnerCommandOutcome>;
        decideInteraction: (args: { projectId: string; interactionId: string; expectedRevision: number; response: string }) => Promise<OwnerCommandOutcome>;
        requestCancel: (args: { projectId: string; taskId: string; interactionId?: string; expectedRevision?: number }) => Promise<OwnerCommandOutcome>;
      };
      outbox: {
        list: (limit?: number) => Promise<any[]>;
      };
      pm: {
        profiles: () => Promise<PmProfile[]>;
      };
      backends: {
        capabilities: (options?: { mode?: 'full' | 'auto' }) => Promise<import('../electron/main/types').BackendCapability[]>;
        capability: (product: string, options?: { mode?: 'full' | 'auto' }) => Promise<import('../electron/main/types').BackendCapability | null>;
        products: () => Promise<string[]>;
        // P11-R1: explicit, single-provider, owner-triggered live probe —
        // never called on a timer (manual refresh only).
        apiProviderLive: (providerId: string) => Promise<import('../electron/main/types').ApiProviderStatus | null>;
        apiProviderModels: (providerId: string) => Promise<import('../electron/main/types').ApiModelDiscoveryResult>;
        // P11-R4.1 Part F-J: one-way credential rotation for `api` — the
        // result never carries a secret back (see main.ts's
        // `backends:updateApiKey` handler / apiKeyUpdateService.ts).
        updateApiKey: (providerId: string, value: string) => Promise<import('../electron/main/types').ApiKeyUpdateResult>;
      };
      pmProfiles: {
        list: () => Promise<import('../electron/main/types').PmProfileEntry[]>;
        create: (args: { id: string; product: string; provider?: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => Promise<import('../electron/main/types').PmProfileWriteResult>;
        update: (args: { id: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => Promise<import('../electron/main/types').PmProfileWriteResult>;
        // P9-R0.4 Part D/H/I: SAFE lifecycle only — no delete call exists.
        deactivate: (args: { id: string }) => Promise<import('../electron/main/types').PmProfileWriteResult>;
        reactivate: (args: { id: string }) => Promise<import('../electron/main/types').PmProfileWriteResult>;
      };
      loginTerminal: {
        start: (args: { product: string; mode: 'login' | 'logout' }) => Promise<{ product: string; mode: string }>;
        write: (data: string) => Promise<void>;
        stop: () => Promise<void>;
        status: () => Promise<{ product: string; mode: string; running: boolean; buffer: string } | null>;
        onData: (callback: (chunk: string) => void) => () => void;
        onExit: (callback: (info: { code: number | null; signal: string | null; error?: string }) => void) => () => void;
      };
    };
  }
}
