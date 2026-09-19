// Shared types between main and renderer processes

export interface RuntimeStatus {
  state: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
  pid: number | null;
  uptime: number;
  lastError: string | null;
}

// P12-R5A Part P: a SAFE, derived, owner-facing projection of the
// project's real PUSH_REMOTE autonomy policy — never the raw autonomy
// envelope itself (no other effects, no revision number, no internals).
// Computed via the exact same normalizeAutonomyEnvelope() the runtime
// (production-pm-worker.mjs's isPushAuthorized()) actually enforces, so
// this can never drift from ground truth. 'UNKNOWN' only when the policy
// genuinely could not be determined (e.g. a malformed autonomy block) —
// never fabricated as a specific level.
export type PushRemotePolicy = 'FORBID' | 'APPROVAL' | 'ALLOW' | 'UNKNOWN';

export interface Project {
  id: string;
  name: string;
  path: string;
  branch?: string;
  state?: string;
  pushRemotePolicy?: PushRemotePolicy;
}

export interface TimelineEntry {
  timestamp: string;
  category: 'USER_TELEGRAM' | 'USER_GUI' | 'PM' | 'AGENT' | 'APPROVAL' | 'RESULT' | 'SYSTEM';
  content: string;
  projectId?: string;
  taskId?: string;
  commandId?: string;
  metadata?: Record<string, any>;
  // Renderer-only: true for an optimistic outbox row not yet reconciled
  // against the canonical projection (W2-F/W2-P).
  pending?: boolean;
}

// M07: a CONFIGURED PM profile's current health/auth-evidence facts. This
// is deliberately NOT the enumeration source for Connection Center — a
// product with zero configured profiles must still be visible (see
// BackendCapability below) rather than disappearing.
export interface Connection {
  name: string;
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  cliInstalled?: boolean;
  version?: string;
  authStatus?: string;
  backend?: string;
  profileId?: string;
  models?: string[];
}

export interface InboxItem {
  interaction_id: string;
  project_id: string;
  task_id: string | null;
  origin: 'PM' | 'SYSTEM';
  kind: 'QUESTION' | 'APPROVAL' | 'INFO';
  title: string;
  prompt_text: string;
  allowed_responses: string[];
  revision: number;
  requires_response: boolean;
  status: string;
  created_at: string;
}

// Real production PM backend capability truth (src/pm/production-pm-
// backend-registry.mjs's capabilities()), never a hardcoded frontend
// matrix. P6-W3-R4 Part A/E/F/G: `authState`/`authProbe` replace the old
// permanently-'UNKNOWN' `authReady` field with a real, per-backend,
// non-mutating native auth probe (see src/pm/pm-connection-probe.mjs) —
// still deliberately distinct from AuthEvidenceStore's PROVEN/FAILED
// execution-derived evidence, which is a separate signal surfaced via
// Connection (below), never collapsed into this one.
// P11-R1: zero-network, per-provider readiness for the `api` product
// (src/pm/api-backend/api-provider-readiness.mjs's `synchronousReadiness`)
// — env-key presence only, never a live HTTP result. `status` is
// deliberately a plain string (not a narrow union) here: the runtime enum
// (api-provider-readiness.mjs's API_PROVIDER_READINESS) is the single
// source of truth; this type only needs to describe the wire shape.
export interface ApiProviderStatus {
  id: string;
  protocol: string;
  configured: boolean;
  keyPresent: boolean;
  status: string;
}
export interface ApiModelEntry { id: string; name: string | null; family: string | null; contextLength: number | null; pricing: Record<string, string | number> | null; supportedParameters: string[]; created: number | string | null; reasoningSupport: 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'; reasoningOptions: string[]; }
export type ApiModelDiscoveryResult = { ok: true; provider: string; httpStatus: number; retrievedAt: string; models: ApiModelEntry[] } | { ok: false; code: string; message: string; httpStatus?: number };

export interface BackendCapability {
  product: string;
  transport: string;
  /** `null` for the `api` product — "CLI installed" is not a meaningful concept for an HTTP backend (see providers[] instead). */
  cliInstalled: boolean | null;
  cliVersion: string | null;
  dshBackendAvailable: boolean;
  sessionKinds: string[];
  modelSelection: boolean;
  loginCommandSupported: boolean;
  logoutCommandSupported: boolean;
  structuredOutput: boolean;
  usageTelemetry: boolean;
  /** Whether a safe, non-mutating native auth probe exists for this product at all. `NOT_APPLICABLE` for `api` — see providers[] for real per-provider readiness. */
  authProbe: 'SUPPORTED' | 'UNSUPPORTED' | 'NOT_APPLICABLE';
  /** The probe's actual finding — never fabricated from --version success alone. `SEE_PROVIDERS`/`UNCONFIGURED` are `api`-only (per-provider detail lives in providers[], never collapsed into one boolean). */
  authState: 'LOGGED_IN' | 'LOGGED_OUT' | 'UNKNOWN' | 'ERROR' | 'SEE_PROVIDERS' | 'UNCONFIGURED';
  /** Short, sanitized human-readable detail — never a raw credential/token/email. */
  authDetail: string | null;
  /** ISO timestamp of this probe (Part B2 "Last checked"). */
  authCheckedAt: string;
  /** CLI's own current/default model, if safely queryable — kept separate from any DSH profile's configured model (Part G). */
  nativeDefaultModel: string | null;
  modelDiscovery: {
    supported: boolean;
    models: string[] | null;
    source: string;
    /** P11-R5.1: optional, generic (never backend-specific in the renderer) id -> display label map — separates the execution value from what the owner sees, for any backend whose native model ids aren't already human-readable. `undefined`/`null` for a backend with no distinct labels (the renderer falls back to the raw id). */
    modelLabels?: Record<string, string> | null;
    /** P11-R5.1: optional, generic id -> the subset of `reasoning.levels` that model actually supports (Part L "model-specific effort capabilities"). When the selected model has an entry here, the renderer must use it instead of the product-wide `reasoning.levels` — never invent a level that isn't in this list for that model. `undefined`/`null` for a backend with no per-model variation. */
    modelEffortLevels?: Record<string, string[]> | null;
  };
  reasoning: {
    selection: 'SUPPORTED' | 'UNSUPPORTED' | 'CLI_MANAGED' | 'UNKNOWN' | 'PROVIDER_DEPENDENT';
    levels: string[] | null;
    flag: string | null;
    /** Where this capability's evidence came from (e.g. "claude --help (2.1.235): ..."). Never a secret; safe to show as a tooltip. */
    source: string | null;
    /** P11-R5.1: optional, generic execution-value -> owner-facing display label map (e.g. codex's "xhigh" -> "Extra High"), sourced from the backend's own documentation/catalogue — never invented. `undefined`/`null` means the raw level string is already the display label. */
    labels?: Record<string, string> | null;
  };
  /** `api` product only — one entry per configured provider (openrouter/deepseek/xcode-best/...). Absent for every CLI backend. */
  providers?: ApiProviderStatus[];
}

// P6-W3-R4 Part D: one entry in the durable pm-profiles.yaml file, as
// returned by pmProfiles:list — the config-file source of truth for the
// Connection Center editor (independent of whether the runtime is
// currently running; see pmProfileConfigService.ts).
// P9-R0.4 Part D/F: `status` is the durable lifecycle field (ACTIVE is the
// default for any entry that predates this field — Part G). `displayLabel`
// is computed main-process-side from the ONE canonical display helper
// (src/pm/pm-profile-display.mjs — Part A) and handed to the renderer
// ready to show; the renderer never derives it itself.
export type PmProfileLifecycleStatus = 'ACTIVE' | 'INACTIVE';

export interface PmProfileEntry {
  id: string;
  role_kind?: string;
  session_kind: string;
  product: string;
  provider?: string;
  transport: string;
  model?: string | null;
  reasoning?: string | null;
  status: PmProfileLifecycleStatus;
  displayLabel: string;
  // P11-R4.2 Part E/F/N: the current Telegram numeric alias for this
  // profile, freshly read (never cached) from telegram-aliases.yaml on
  // every pmProfiles:list() call — `null` means "not yet assigned" (a
  // brand-new profile before the running runtime's next hot-reload/start)
  // or "runtime never running yet", never a real absence of the feature.
  alias?: string | null;
}

export type PmProfileWriteResult =
  // P11-R4.2 Part E/N: `alias` is present only when a create() successfully
  // triggered the running runtime's hot-reload AND that reload actually
  // assigned this new profile a fresh alias (see main.ts's pmProfiles:create
  // handler / apiKeyUpdateService-style best-effort pipe call). Absent —
  // never `null` — whenever the runtime isn't running, predates this
  // feature, or the reload simply hasn't produced an alias yet; the
  // renderer must treat "absent" as "not yet known", not "no alias exists".
  | { ok: true; profile: PmProfileEntry; alias?: string }
  | { ok: false; code: string; message: string };

// P11-R4.1 Part F-J/I: the ONE result shape `backends:updateApiKey` may
// ever return — deliberately carries no secret/prefix/fingerprint field,
// only success or a typed, safe error.
export type ApiKeyUpdateResult = { ok: true } | { ok: false; code: string; message: string };

export interface BackendRun {
  runId: string;
  product: string;
  pmProfileId: string | null;
  projectId: string | null;
  taskId: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  output: unknown;
  error: unknown;
  // Part C — best-effort only, backfilled from still-in-memory execution
  // log entries when available (see readProjection.ts getBackendRuns());
  // null whenever the ephemeral buffer no longer holds this run.
  cwd?: string | null;
  model?: string | null;
  exitCode?: number | null;
  parserOutcome?: string | null;
  // P12-R2: the durable six-dimension outcome model
  // (src/pm/task-outcome-model.mjs), read back from pm_runs.data's reserved
  // `dsh_outcome` key (recordTaskOutcome() — no schema change). `null` for
  // any run that predates P12 or never had it recorded — never fabricated.
  dshOutcome?: DshTaskOutcome | null;
}

export type OwnerTaskDisplayState = 'RUNNING' | 'WAITING — GLOBAL CAPACITY' | 'WAITING — WORKSPACE BUSY' | 'WAITING — BACKEND CAPACITY' | 'WAITING — RESOURCE PRESSURE' | 'WAITING — OTHER' | 'AWAITING OWNER' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface MultiTaskRow {
  taskId: string; projectId: string | null; projectName: string | null; pmRunId: string;
  profileId: string | null; backend: string | null; mode: 'SINGLE' | 'COUNCIL'; runtimeClass: 'NORMAL' | 'LONG' | null;
  durability: 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE' | null; displayState: OwnerTaskDisplayState;
  waitingReason: string | null; startedAt: string | null; queuedSince: string | null; elapsedSince: string | null; cancellable: boolean;
  reconciliation?: { indicator: 'RECONCILED' | 'RECOVERY REQUIRED'; classification: string; affectedLayer: string; reason: string; ageMs: number | null; resourceImpact: string; safeAllowedActions: string[] } | null;
}
export interface MultiTaskStatus { globalLimit: number; activeCount: number; queuedCount: number; awaitOwnerCount: number; observedAt: string; tasks: MultiTaskRow[]; }

// P12-R2 — mirrors src/pm/task-outcome-model.mjs's buildTaskOutcome() shape
// exactly. Kept loosely typed (plain strings, not a closed union) so a
// future new enum value on the runtime side never breaks the Desktop build.
export interface DshTaskOutcome {
  execution_status: string;
  verification_status: string;
  artifact_status: string;
  local_git_status: string;
  remote_sync_status: string;
  review_status: string;
  degraded: boolean;
  persistence_warning: boolean;
  terminal_marker: string;
}

export interface LogOptions {
  limit?: number;
  since?: string;
}

export interface TimelineOptions {
  limit?: number;
  since?: string;
  category?: string;
}
