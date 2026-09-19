import { contextBridge, ipcRenderer } from 'electron';

// Closed desktop API - only specific operations allowed
contextBridge.exposeInMainWorld('desktop', {
  // M01/M02 bootstrap: only path *references* ever cross this boundary —
  // main.ts never returns a raw secret value here, only CONFIGURED/
  // MISSING/INVALID states and the paths themselves (which are not
  // secrets).
  bootstrap: {
    status: () => ipcRenderer.invoke('bootstrap:status'),
    pickRepoRoot: () => ipcRenderer.invoke('bootstrap:pickRepoRoot'),
    pickProductionConfig: () => ipcRenderer.invoke('bootstrap:pickProductionConfig'),
    pickEnvFile: () => ipcRenderer.invoke('bootstrap:pickEnvFile'),
    restartApp: () => ipcRenderer.invoke('bootstrap:restartApp'),
  },
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
    start: () => ipcRenderer.invoke('runtime:start'),
    stop: () => ipcRenderer.invoke('runtime:stop'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    forceStop: () => ipcRenderer.invoke('runtime:forceStop'),
    onStatusChange: (callback: (status: any) => void) => {
      const subscription = (_event: any, status: any) => callback(status);
      ipcRenderer.on('runtime:statusChanged', subscription);
      return () => {
        ipcRenderer.removeListener('runtime:statusChanged', subscription);
      };
    },
  },
  relayRunner: {
    getStatus: () => ipcRenderer.invoke('relayRunner:getStatus'),
    refresh: () => ipcRenderer.invoke('relayRunner:refresh'),
    start: () => ipcRenderer.invoke('relayRunner:start'),
    stop: () => ipcRenderer.invoke('relayRunner:stop'),
    restart: () => ipcRenderer.invoke('relayRunner:restart'),
    getLogs: () => ipcRenderer.invoke('relayRunner:getLogs'),
    getHealth: () => ipcRenderer.invoke('relayRunner:getHealth'),
    // P0-3: no `runnerPath` field — the renderer can never supply a path
    // value to this privileged IPC. The runner directory is set only via
    // pickFolder(), which shows a MAIN-process-owned native OS picker.
    updateSettings: (settings: { enabled: boolean; autoStart: boolean }) => ipcRenderer.invoke('relayRunner:updateSettings', settings),
    pickFolder: () => ipcRenderer.invoke('relayRunner:pickFolder'),
    onStatusChange: (callback: (status: any) => void) => {
      const subscription = (_event: any, status: any) => callback(status);
      ipcRenderer.on('relayRunner:statusChanged', subscription);
      return () => ipcRenderer.removeListener('relayRunner:statusChanged', subscription);
    },
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
  },
  timeline: {
    get: (projectId: string | null, options: any) =>
      ipcRenderer.invoke('timeline:get', projectId, options),
  },
  inbox: {
    list: (projectId: string | null) => ipcRenderer.invoke('inbox:list', projectId),
  },
  runs: {
    list: (projectId: string | null, options: any) => ipcRenderer.invoke('runs:list', projectId, options),
  },
  tasks: {
    runtimeStatus: () => ipcRenderer.invoke('tasks:runtimeStatus'),
  },
  // P7 Part M: Council panel read surface — product-level, distinct from
  // the Backend Runs debug surface above.
  council: {
    list: (projectId: string | null, options?: { limit?: number }) => ipcRenderer.invoke('council:list', projectId, options),
    get: (pmRunId: string) => ipcRenderer.invoke('council:get', pmRunId),
  },
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    // P6-W3-R4/R4.1 Part B/A4/R41-7: pushed once, from the main process,
    // right after a successful Login/Logout exit — lets the renderer
    // refresh immediately instead of waiting for its next auto-refresh
    // tick. Carries the one affected product so the renderer can scope
    // the refresh to that backend only, never all four.
    onChanged: (callback: (info?: { product?: string }) => void) => {
      const subscription = (_event: any, info?: { product?: string }) => callback(info);
      ipcRenderer.on('connections:changed', subscription);
      return () => ipcRenderer.removeListener('connections:changed', subscription);
    },
  },
  logs: {
    runtime: (options: any) => ipcRenderer.invoke('logs:runtime', options),
  },
  // P6-W3-R3 Part B: read-only execution-log surface for the four
  // production backends. No write/command call exists here — this is
  // intentionally poll-only (list + statuses), never a stdin/PTY channel.
  execLogs: {
    list: (product: string, options?: { afterSeq?: number; limit?: number }) => ipcRenderer.invoke('execLogs:list', product, options),
    statuses: () => ipcRenderer.invoke('execLogs:statuses'),
  },
  // P10-R0.2.4.1 Part J/K/M: read-only, poll-only LONG-task runtime/
  // liveness projection — no stdin, no task control.
  longTasks: {
    statuses: () => ipcRenderer.invoke('longTasks:statuses'),
  },
  project: {
    arm: (projectId: string) => ipcRenderer.invoke('project:arm', projectId),
    disarm: () => ipcRenderer.invoke('project:disarm'),
    getArmed: () => ipcRenderer.invoke('project:getArmed'),
    onArmedChanged: (callback: (projectId: string | null) => void) => {
      const subscription = (_event: any, projectId: string | null) => callback(projectId);
      ipcRenderer.on('project:armedChanged', subscription);
      return () => ipcRenderer.removeListener('project:armedChanged', subscription);
    },
    addFolder: (args: { folderPath: string; displayName?: string; defaultPmProfileId: string; force?: boolean }) =>
      ipcRenderer.invoke('project:addFolder', args),
  },
  dialogs: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
  // Closed owner-mutation surface: exactly these five named calls, never a
  // generic owner.mutate(operation, payload) passthrough.
  owner: {
    submitTask: (args: { projectId: string; pmProfileId: string; body: string; council?: { participantProfileIds: string[]; rounds: number }; taskFile?: { ref: string; path: string }; lifecycle?: { durability: 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE'; commitLocal?: boolean; pushRemote?: boolean; requestReview?: boolean; remoteName?: string } }) => ipcRenderer.invoke('owner:submitTask', args),
    replyToInteraction: (args: { projectId: string; interactionId: string; expectedRevision: number; text: string }) =>
      ipcRenderer.invoke('owner:replyToInteraction', args),
    decideInteraction: (args: { projectId: string; interactionId: string; expectedRevision: number; response: string }) =>
      ipcRenderer.invoke('owner:decideInteraction', args),
    requestCancel: (args: { projectId: string; taskId: string; interactionId?: string; expectedRevision?: number }) => ipcRenderer.invoke('owner:requestCancel', args),
  },
  outbox: {
    list: (limit?: number) => ipcRenderer.invoke('outbox:list', limit),
  },
  pm: {
    profiles: () => ipcRenderer.invoke('pm:profiles'),
  },
  backends: {
    capabilities: (options?: { mode?: 'full' | 'auto' }) => ipcRenderer.invoke('backends:capabilities', options),
    // P6-W3-R4.1 Part R41-3: narrow, single-product probe — never an
    // arbitrary executable/argv, just the one product name.
    capability: (product: string, options?: { mode?: 'full' | 'auto' }) => ipcRenderer.invoke('backends:capability', product, options),
    // P6.5 Part I: static product-name list, zero CLI probing — for
    // callers (e.g. BackendExecutionLogs' tabs) that only need to know
    // *which* backends exist, never their live auth/model status.
    products: () => ipcRenderer.invoke('backends:products'),
    // P11-R1: the ONE explicit, single-provider, owner-triggered live
    // probe — never invoked on a timer by any renderer code (manual
    // refresh only, see ConnectionCenter.tsx's "Check live" button).
    apiProviderLive: (providerId: string) => ipcRenderer.invoke('backends:apiProviderLive', providerId),
    apiProviderModels: (providerId: string) => ipcRenderer.invoke('backends:apiProviderModels', providerId),
    // P11-R4.1 Part F-J: one-way credential rotation — `value` only ever
    // travels renderer->main; the result never carries a secret back.
    updateApiKey: (providerId: string, value: string) => ipcRenderer.invoke('backends:updateApiKey', { providerId, value }),
  },
  // Closed PM-profile editor surface (P6-W3-R4 Part D/I1): exactly these
  // named calls, never a generic writeConfig(path, data) passthrough — the
  // target file is always the one path the main process already resolved
  // from production config, never renderer-supplied. P9-R0.4 Part D/X:
  // deactivate/reactivate take only a bare canonical id — no identity
  // fields, no file path — every guard lives in the trusted main-process
  // service.
  pmProfiles: {
    list: () => ipcRenderer.invoke('pmProfiles:list'),
    create: (args: { id: string; product: string; provider?: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => ipcRenderer.invoke('pmProfiles:create', args),
    update: (args: { id: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => ipcRenderer.invoke('pmProfiles:update', args),
    deactivate: (args: { id: string }) => ipcRenderer.invoke('pmProfiles:deactivate', args),
    reactivate: (args: { id: string }) => ipcRenderer.invoke('pmProfiles:reactivate', args),
  },
  // Closed Login Terminal surface: product/mode are validated against a
  // fixed enum in the main process; there is no generic exec/spawn call.
  loginTerminal: {
    start: (args: { product: string; mode: 'login' | 'logout' }) => ipcRenderer.invoke('loginTerminal:start', args),
    write: (data: string) => ipcRenderer.invoke('loginTerminal:write', data),
    stop: () => ipcRenderer.invoke('loginTerminal:stop'),
    status: () => ipcRenderer.invoke('loginTerminal:status'),
    onData: (callback: (chunk: string) => void) => {
      const subscription = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on('loginTerminal:data', subscription);
      return () => ipcRenderer.removeListener('loginTerminal:data', subscription);
    },
    onExit: (callback: (info: { code: number | null; signal: string | null; error?: string }) => void) => {
      const subscription = (_event: any, info: any) => callback(info);
      ipcRenderer.on('loginTerminal:exit', subscription);
      return () => ipcRenderer.removeListener('loginTerminal:exit', subscription);
    },
  },
});
