import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ProjectList from './components/ProjectList';
import Timeline from './components/Timeline';
import ConnectionCenter from './components/ConnectionCenter';
import UpdateApiKeyDialog from './components/UpdateApiKeyDialog';
import ActivityPanel from './components/ActivityPanel';
import Composer, { PmProfileOption, LifecycleRequest } from './components/Composer';
import ApprovalPanel from './components/ApprovalPanel';
import AddFolderDialog from './components/AddFolderDialog';
import LoginTerminal from './components/LoginTerminal';
import BackendRuns from './components/BackendRuns';
import CouncilPanel from './components/CouncilPanel';
import BackendExecutionLogs from './components/BackendExecutionLogs';
import LongTaskRuntime from './components/LongTaskRuntime';
import FirstRunBootstrap from './components/FirstRunBootstrap';
import MultiTaskControl from './components/MultiTaskControl';
import PmProfileCreateDialog from './components/PmProfileCreateDialog';
import PmProfileManagement from './components/PmProfileManagement';
import { ConnectionRefreshCoordinator, RefreshMode } from './lib/connectionRefreshCoordinator';
import { useResizableLayout } from './lib/useResizableLayout';
import { RuntimeStatus, Project, TimelineEntry, Connection, InboxItem, BackendCapability, PmProfileEntry } from '../electron/main/types';
import './App.css';

function MainApp() {
  const [status, setStatus] = useState<RuntimeStatus>({
    state: 'STOPPED',
    pid: null,
    uptime: 0,
    lastError: null,
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [armedProjectId, setArmedProjectId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  // P15-REM-R3-G (P15-D-012): `window.desktop.timeline.get()` now returns a
  // typed ProjectionResult — see `inboxUnavailable` above for the same
  // pattern.
  const [timelineUnavailable, setTimelineUnavailable] = useState<{ code: string; message: string } | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  // P15-REM-R3-F (P15-D-014): `window.desktop.inbox.list()` now returns a
  // typed ProjectionResult — `inboxUnavailable` carries the sanitized error
  // whenever the last read did NOT succeed, so ApprovalPanel can render an
  // explicit "could not load" state instead of ever showing an empty inbox
  // as if it were confirmed empty. `null` means the last read genuinely
  // succeeded (whether or not the result was empty).
  const [inboxUnavailable, setInboxUnavailable] = useState<{ code: string; message: string } | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [pmProfiles, setPmProfiles] = useState<PmProfileOption[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<string>('ALL');
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [capabilities, setCapabilities] = useState<BackendCapability[]>([]);
  const [loginTerminalTarget, setLoginTerminalTarget] = useState<{ product: string; mode: 'login' | 'logout' } | null>(null);
  // P6-W3-R4 Connection Center V2: pmProfileEntries is the durable
  // config-file view (independent of whether the runtime has ever
  // started); lastChecked/refreshingKeys back the explicit Refresh/
  // Refresh All UX and the "Last checked" diagnostic (Part B).
  // P6-W3-R4.1: refreshingKeys is a set ('ALL' and/or individual product
  // names) rather than one string, so an 'ALL' refresh and an independent
  // per-product refresh can each show correctly as busy at the same time
  // without one clobbering the other's UI state (R41-6).
  const [pmProfileEntries, setPmProfileEntries] = useState<PmProfileEntry[]>([]);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [refreshingKeys, setRefreshingKeys] = useState<ReadonlySet<string>>(new Set());
  // P8-R0.2 Part C/D: a plain product string opens a blank "Create PM
  // Profile" dialog; a `variantOf` profile opens the SAME dialog seeded
  // with that profile's model/reasoning as a "Create Variant" flow — never
  // an in-place edit of the source profile.
  const [createProfileSeed, setCreateProfileSeed] = useState<{ product: string; variantOf: PmProfileEntry | null } | null>(null);
  // P11-R4.1 Part G: the `api` product's Update API Key dialog — lifted to
  // App.tsx level, same pattern as createProfileSeed/loginTerminalTarget
  // above, rather than owned inside ConnectionCenter itself.
  const [updateApiKeyOpen, setUpdateApiKeyOpen] = useState(false);

  // P14-R0A: owner-resizable Projects / Connection Center columns (drag
  // handles either side of center-content, below). Widths are clamped and
  // persisted per-viewer via localStorage — see useResizableLayout.ts /
  // resizableLayout.ts.
  const { layout, activeSide, startDrag, resetSide } = useResizableLayout();

  // Per-project drafts and PM selections. Switching selection never
  // silently retargets a draft (W2-C draft safety): the draft stays bound
  // to the project it was typed for, visible but disabled unless that
  // project is armed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pmChoices, setPmChoices] = useState<Record<string, string>>({});
  // Optimistic entries keyed by command_id, reconciled away once the same
  // command_id appears in the canonical projection (W2-F/W2-P).
  const [optimistic, setOptimistic] = useState<Record<string, TimelineEntry>>({});

  // P6-W3-R4.1/R4.2 Part R41-1/R41-3/R42-1/R42-2: the one refresh
  // coordinator for Connection Center's native CLI probing — see
  // src/lib/connectionRefreshCoordinator.ts for the single-flight
  // guarantee it provides. Constructed once via a ref (never recreated
  // across renders) so its in-flight/busy state persists for the
  // component's whole lifetime. Deliberately has no scheduling
  // capability (R4.2, owner product decision, R4-M02): periodic
  // background polling caused visible packaged-app sluggishness, so the
  // only refreshes that ever happen are the one startup refresh below and
  // whatever an explicit owner action triggers.
  const coordinatorRef = useRef<ConnectionRefreshCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new ConnectionRefreshCoordinator({
      refreshAll: async (mode: RefreshMode) => {
        const [capabilitiesData, pmProfileEntriesData] = await Promise.all([
          window.desktop.backends.capabilities({ mode }),
          window.desktop.pmProfiles.list(),
        ]);
        setCapabilities(capabilitiesData);
        setPmProfileEntries(pmProfileEntriesData);
        setLastChecked(new Date());
      },
      refreshOne: async (product: string, mode: RefreshMode) => {
        const capability = await window.desktop.backends.capability(product, { mode });
        if (capability) setCapabilities((prev) => prev.map((c) => (c.product === product ? capability : c)));
        setLastChecked(new Date());
      },
      onBusyChange: (keys) => setRefreshingKeys(new Set(keys)),
    });
  }

  // P6-W3-R4.1 Part R41-7: profile config state is refreshed on its own,
  // separate path — a PM profile Create/Create-Variant never runs a native
  // CLI probe (see handleCreateProfile below).
  // P9-R0.4 Part N/T/W: also re-fetches the Single/Chair/Participants
  // selector list (window.desktop.pm.profiles()) — that IPC now reads the
  // durable pm-profiles.yaml fresh on every call (Part T: no restart
  // needed for a deactivate/reactivate to reach those selectors), so a
  // full refreshData() round trip is never required for lifecycle changes
  // to show up there.
  const refreshProfilesOnly = useCallback(async () => {
    try {
      const [entries, selectable] = await Promise.all([window.desktop.pmProfiles.list(), window.desktop.pm.profiles()]);
      setPmProfileEntries(entries);
      setPmProfiles(selectable);
    } catch (error) {
      console.error('Failed to refresh PM profiles:', error);
    }
  }, []);

  useEffect(() => {
    loadInitialData();

    const unsubscribeStatus = window.desktop.runtime.onStatusChange((newStatus: RuntimeStatus) => {
      setStatus(newStatus);
    });
    const unsubscribeArmed = window.desktop.project.onArmedChanged((projectId: string | null) => {
      setArmedProjectId(projectId);
    });
    // P6-W3-R4.1 Part R41-7: pushed after a successful Login/Logout exit,
    // scoped to the one affected product — refreshes only that backend's
    // card, never all four.
    const unsubscribeConnectionsChanged = window.desktop.connections.onChanged((info) => {
      if (info?.product) void coordinatorRef.current?.refreshOne(info.product, 'full');
      else void coordinatorRef.current?.refreshAll('full');
    });

    return () => {
      unsubscribeStatus();
      unsubscribeArmed();
      unsubscribeConnectionsChanged();
    };
  }, []);

  useEffect(() => {
    if (status.state === 'RUNNING') {
      const interval = setInterval(() => {
        refreshData();
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [status.state, selectedProject, timelineFilter]);

  // P6-W3-R4.2 Part R42-1/R42-3: exactly ONE native connection refresh at
  // Desktop app startup — never a recurring timer (R4.1's 60s auto-
  // refresh caused visible packaged-app sluggishness even after its
  // single-flight fix; the owner's product decision was to remove
  // periodic background polling entirely, see R4-M02). Every further
  // native CLI probe only ever happens in direct response to an explicit
  // owner action: Refresh, Refresh All, or a scoped Login/Logout refresh
  // (wired elsewhere in this component). This effect intentionally has no
  // cleanup — there is no timer to cancel — and is NOT gated on runtime
  // being RUNNING: CLI auth/model probing is entirely independent of
  // whether the DSH runtime process is up (Connection Center is the
  // control surface for configuring PM profiles even before the owner has
  // started the runtime — R41-8/R42-8), and it is independent of every
  // later runtime start/stop/restart too — those never trigger a
  // Connection Center refresh of their own. The coordinator's single-
  // flight guard also protects this call against React StrictMode's
  // dev-only double-invoke (R42-3).
  useEffect(() => {
    void coordinatorRef.current?.refreshAll('full');
  }, []);

  const loadInitialData = async () => {
    const currentStatus = await window.desktop.runtime.status();
    setStatus(currentStatus);
    const armed = await window.desktop.project.getArmed();
    setArmedProjectId(armed);

    if (currentStatus.state === 'RUNNING') {
      await refreshData();
    }
  };

  const refreshData = async () => {
    try {
      const [projectsData, timelineData, connectionsData, inboxData, pmProfilesData] = await Promise.all([
        window.desktop.projects.list(),
        window.desktop.timeline.get(selectedProject, {
          limit: 100,
          category: timelineFilter === 'ALL' ? undefined : timelineFilter,
        }),
        window.desktop.connections.list(),
        window.desktop.inbox.list(null),
        window.desktop.pm.profiles(),
      ]);

      setProjects(projectsData);
      // P15-REM-R3-G (P15-D-012): `timelineData` is now a ProjectionResult
      // — an ERROR read keeps the LAST successfully-read timeline on
      // screen (never resets to []); DEGRADED_PARTIAL still updates the
      // list (it IS the freshest available data) but flags it as partial.
      const nextTimeline = timelineData.status === 'ERROR' ? timeline : timelineData.data;
      if (timelineData.status === 'ERROR' || timelineData.status === 'DEGRADED_PARTIAL') setTimelineUnavailable(timelineData.error);
      else setTimelineUnavailable(null);
      setTimeline(nextTimeline);
      setConnections(connectionsData);
      // P15-REM-R3-F (P15-D-014): `inboxData` is now a ProjectionResult —
      // the LAST successfully-read inbox is kept on screen when a read
      // fails (never silently replaced with an empty list), while
      // `inboxUnavailable` tells ApprovalPanel the shown list may be stale
      // and a decision could exist that this render cannot see.
      if (inboxData.status === 'ERROR') {
        setInboxUnavailable(inboxData.error);
      } else {
        setInbox(inboxData.data);
        setInboxUnavailable(null);
      }
      setPmProfiles(pmProfilesData);
      setLastRefresh(new Date());

      // Reconcile: drop any optimistic entry whose command_id now has a
      // canonical row in the projection — never render both.
      const canonicalIds = new Set(nextTimeline.map((e: TimelineEntry) => e.commandId).filter(Boolean));
      setOptimistic((prev) => {
        const next: Record<string, TimelineEntry> = {};
        for (const [id, entry] of Object.entries(prev)) if (!canonicalIds.has(id)) next[id] = entry;
        return next;
      });
    } catch (error) {
      console.error('Failed to refresh data:', error);
    }
  };

  const handleStart = async () => {
    try {
      await window.desktop.runtime.start();
      setRestartRequired(false);
      await refreshData();
    } catch (error: any) {
      console.error('Failed to start runtime:', error);
      alert(`Failed to start runtime: ${error.message}`);
    }
  };

  const handleStop = async () => {
    try {
      await window.desktop.runtime.stop();
    } catch (error: any) {
      console.error('Failed to stop runtime:', error);
      alert(`Failed to stop runtime: ${error.message}`);
    }
  };

  const handleRestart = async () => {
    try {
      await window.desktop.runtime.restart();
      setRestartRequired(false);
      await refreshData();
    } catch (error: any) {
      console.error('Failed to restart runtime:', error);
      alert(`Failed to restart runtime: ${error.message}`);
    }
  };

  // P8-R0.2 Part Q: there is no more in-place Save for an existing
  // profile's execution identity — model/reasoning/product are immutable
  // once created (the backend refuses PM_PROFILE_IDENTITY_IMMUTABLE
  // regardless), so the only owner-facing write path left is create()
  // (a brand-new canonical id — either a fresh profile or a "variant").
  // P6-W3-R4.1 Part R41-7: refreshes only the config-state view
  // (pmProfiles:list) — never runs a native CLI probe for a Create.
  const handleCreateProfile = useCallback(async (args: { id: string; product: string; provider?: string; model?: string | null; reasoning?: string | null }) => {
    const result = await window.desktop.pmProfiles.create(args);
    if (result.ok) await refreshProfilesOnly();
    return result;
  }, [refreshProfilesOnly]);

  // P11-R4.1 Part F-J: one-way OpenRouter key rotation — the value never
  // comes back from this call, only ok/typed-error (see main.ts's
  // `backends:updateApiKey` / apiKeyUpdateService.ts). `onUpdated` on the
  // dialog triggers the SAME per-product Refresh the card's own button
  // uses, so a following model discovery sees the new key immediately.
  const handleUpdateApiKey = useCallback((value: string) => window.desktop.backends.updateApiKey('openrouter', value), []);

  // P9-R0.4 Part D/T: SAFE lifecycle actions — refresh both profile views
  // (Management list + Single/Chair/Participants selectors) on success so
  // a deactivated profile disappears from selectors immediately, without a
  // runtime restart (Part T's live scenario).
  const handleDeactivateProfile = useCallback(async (id: string) => {
    const result = await window.desktop.pmProfiles.deactivate({ id });
    if (result.ok) await refreshProfilesOnly();
    return result;
  }, [refreshProfilesOnly]);
  const handleReactivateProfile = useCallback(async (id: string) => {
    const result = await window.desktop.pmProfiles.reactivate({ id });
    if (result.ok) await refreshProfilesOnly();
    return result;
  }, [refreshProfilesOnly]);

  const handleForceStop = async () => {
    if (!confirm('Force stop will terminate the runtime immediately. Continue?')) {
      return;
    }

    try {
      await window.desktop.runtime.forceStop();
    } catch (error: any) {
      console.error('Failed to force stop runtime:', error);
    }
  };

  const handleArmProject = useCallback(async (projectId: string) => {
    try {
      const armed = await window.desktop.project.arm(projectId);
      setArmedProjectId(armed);
    } catch (error: any) {
      if (error?.message === 'PROJECT_PATH_MISSING') {
        alert('This project\'s configured folder is missing. Restore the folder and restart to arm it.');
      } else {
        alert(`Failed to arm project: ${error?.message ?? 'unknown error'}`);
      }
    }
  }, []);

  const selectedProjectObj = useMemo(() => projects.find((p) => p.id === selectedProject) ?? null, [projects, selectedProject]);

  // P12-R1: `taskFile` is optional and mutually exclusive with typed draft
  // text (Composer.tsx already enforces this in its own canSubmit gate) —
  // when present, `body` is expected to be empty and the resolved file
  // content becomes the task body runtime-side.
  // P12-R5A: `lifecycle` is optional and additive (undefined === DIRECT,
  // byte-for-byte the pre-R5A payload) — see Composer.tsx's LifecycleRequest.
  const handleSubmitTask = useCallback(async (council?: { participantProfileIds: string[]; rounds: number; implementationParticipantId?: string; debate?: { enabled: boolean; maxRounds?: 1 | 2 } }, taskFile?: { ref: string; path: string }, lifecycle?: LifecycleRequest) => {
    if (!selectedProject) return;
    const body = (drafts[selectedProject] ?? '').trim();
    const pmProfileId = pmChoices[selectedProject];
    if ((!body && !taskFile) || !pmProfileId) return;
    const outcome = await window.desktop.owner.submitTask({ projectId: selectedProject, pmProfileId, body, council, taskFile, lifecycle });
    if (outcome.state === 'COMPLETED' || outcome.state === 'AWAITING_ACK' || outcome.state === 'SENDING') {
      setOptimistic((prev) => ({
        ...prev,
        [outcome.commandId]: {
          timestamp: new Date().toISOString(),
          category: 'USER_GUI',
          content: taskFile ? `--task-file ${taskFile.ref} ${taskFile.path}` : body,
          projectId: selectedProject,
          commandId: outcome.commandId,
          pending: outcome.state !== 'COMPLETED',
        },
      }));
      setDrafts((prev) => ({ ...prev, [selectedProject]: '' }));
    }
    if (outcome.state === 'FAILED_TERMINAL' || outcome.state === 'CONFLICT' || outcome.state === 'FAILED_RETRYABLE') {
      throw new Error(outcome.errorCode ?? 'OWNER_COMMAND_FAILED');
    }
    await refreshData();
  }, [selectedProject, drafts, pmChoices]);

  const handleDecide = useCallback(async (interaction: InboxItem, response: string) => {
    // CANCEL is task cancellation, not a PM response. Route it through the
    // canonical REQUEST_CANCEL operation while carrying the interaction's
    // identity/revision as guards. Every other advertised response (RETRY
    // included) retains DECIDE_INTERACTION semantics.
    const outcome: any = response === 'CANCEL'
      ? interaction.task_id
        ? await window.desktop.owner.requestCancel({
            projectId: interaction.project_id,
            taskId: interaction.task_id,
            interactionId: interaction.interaction_id,
            expectedRevision: interaction.revision,
          })
        : { state: 'FAILED_TERMINAL', errorCode: 'INTERACTION_TASK_MISMATCH' }
      : await window.desktop.owner.decideInteraction({
          projectId: interaction.project_id,
          interactionId: interaction.interaction_id,
          expectedRevision: interaction.revision,
          response,
        });
    if (outcome.state !== 'COMPLETED') throw new Error(outcome.errorCode ?? 'OWNER_COMMAND_FAILED');
    await refreshData();
  }, []);

  const handleReply = useCallback(async (interaction: InboxItem, text: string) => {
    const outcome: any = await window.desktop.owner.replyToInteraction({
      projectId: interaction.project_id,
      interactionId: interaction.interaction_id,
      expectedRevision: interaction.revision,
      text,
    });
    if (outcome.state !== 'COMPLETED') throw new Error(outcome.errorCode ?? 'OWNER_COMMAND_FAILED');
    await refreshData();
  }, []);

  // P12-R5C Part E/F/I: confirmation now happens in CancelTaskDialog (a
  // dedicated dialog with explicit "Cancel task"/"Keep running" actions —
  // never a hidden one-click destructive control), so this handler no
  // longer prompts itself; it throws on failure (matching handleDecide/
  // handleReply's pattern) so the dialog can show the real error inline
  // instead of a native alert(). The IPC call itself is unchanged — the
  // exact same canonical window.desktop.owner.requestCancel() round-trip.
  const handleCancelTask = useCallback(async (taskId: string, projectId: string) => {
    const outcome: any = await window.desktop.owner.requestCancel({ projectId, taskId });
    if (outcome.state !== 'COMPLETED') {
      throw new Error(outcome.errorCode ?? 'OWNER_COMMAND_FAILED');
    }
    await refreshData();
  }, []);

  const getStatusColor = () => {
    switch (status.state) {
      case 'RUNNING': return 'var(--dsh-status-success)';
      case 'STOPPED': return 'var(--dsh-text-muted)';
      case 'STARTING': return 'var(--dsh-status-info)';
      case 'STOPPING': return 'var(--dsh-status-warning)';
      case 'ERROR': return 'var(--dsh-status-error)';
      default: return 'var(--dsh-text-muted)';
    }
  };

  const formatUptime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const combinedTimeline = useMemo(() => {
    const pendingForView = Object.values(optimistic).filter((e) => selectedProject === null || e.projectId === selectedProject);
    return [...pendingForView, ...timeline].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [optimistic, timeline, selectedProject]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-left">
          <h1 className="app-title">DSH Desktop</h1>
          <div className="runtime-status">
            <span
              className="status-indicator"
              style={{ backgroundColor: getStatusColor() }}
            />
            <span className="status-text">{status.state}</span>
            {status.state === 'RUNNING' && status.uptime > 0 && (
              <span className="status-uptime">{formatUptime(status.uptime)}</span>
            )}
          </div>
        </div>

        <div className="topbar-actions">
          <button
            className="btn btn-primary"
            onClick={handleStart}
            disabled={status.state === 'RUNNING' || status.state === 'STARTING'}
          >
            Start
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleStop}
            disabled={status.state !== 'RUNNING'}
          >
            Stop
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleRestart}
            disabled={status.state !== 'RUNNING'}
          >
            Restart
          </button>
          {status.state === 'STOPPING' && (
            <button
              className="btn btn-danger"
              onClick={handleForceStop}
            >
              Force Stop
            </button>
          )}
        </div>
      </div>

      {status.lastError && (
        <div className="error-banner">
          <strong>Error:</strong> {status.lastError}
        </div>
      )}

      {status.state !== 'RUNNING' && status.state !== 'STARTING' && (
        <div className="info-banner">
          Runtime is not running. Start the runtime to see projects and activity.
        </div>
      )}

      {restartRequired && (
        <div className="info-banner">
          A folder was added while the runtime was active. Restart the runtime to pick up the new project.
          <button className="btn btn-secondary" style={{ marginLeft: 12 }} onClick={handleRestart}>
            Restart now
          </button>
        </div>
      )}

      <div className="main-content">
        <div className="sidebar sidebar-left" style={{ width: layout.leftWidth }}>
          <ProjectList
            projects={projects}
            selectedProject={selectedProject}
            armedProjectId={armedProjectId}
            onSelectProject={setSelectedProject}
            onArmProject={handleArmProject}
            onAddFolder={() => setShowAddFolder(true)}
          />
        </div>

        <div
          className={`resize-handle${activeSide === 'left' ? ' active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize projects panel"
          title="Drag to resize · double-click to reset"
          onMouseDown={startDrag('left')}
          onDoubleClick={resetSide('left')}
        />

        <div className="center-content">
          {/* UI V2.1: a header label for the center column, completing the
              three-column header row (Projects / Workspace / Connection
              Center) the operator-shell direction calls for. Purely a new
              label above the existing content — Composer/CouncilPanel/
              Timeline below are untouched, in the same order, inside the
              same .center-top wrapper. */}
          <div className="workspace-header">
            <span className="panel-header-label">Workspace</span>
          </div>
          {/* P14-R0B: Composer/history is the TOP of the center column
              only — the owner-provided wireframe's "Composer / task
              composition area". Unchanged from before this gate (still
              exactly Composer + CouncilPanel + Timeline, in the same
              order, with the exact same internal-scroll CSS via
              Timeline.css/CouncilPanel.css) — only its wrapper is new. */}
          <div className="center-top">
            <Composer
              selectedProject={selectedProjectObj}
              armedProjectId={armedProjectId}
              runtimeRunning={status.state === 'RUNNING'}
              pmProfiles={pmProfiles}
              draft={selectedProject ? drafts[selectedProject] ?? '' : ''}
              onDraftChange={(value) => selectedProject && setDrafts((prev) => ({ ...prev, [selectedProject]: value }))}
              pmProfileId={selectedProject ? pmChoices[selectedProject] ?? null : null}
              onPmProfileChange={(id) => selectedProject && setPmChoices((prev) => ({ ...prev, [selectedProject]: id }))}
              onArm={handleArmProject}
              onSubmit={handleSubmitTask}
            />
            <CouncilPanel selectedProjectId={selectedProject} />
            <Timeline
              entries={combinedTimeline}
              unavailable={timelineUnavailable}
              filter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedProject={selectedProject}
              projects={projects}
            />
          </div>

          <div
            className={`resize-handle-row${activeSide === 'centerBottom' ? ' active' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize task status pane"
            title="Drag to resize · double-click to reset"
            onMouseDown={startDrag('centerBottom')}
            onDoubleClick={resetSide('centerBottom')}
          />

          {/* P14-R0B: the BOTTOM of the center column only — the owner-
              provided wireframe's "smaller task-status/history pane"
              (Running/Queued/Awaiting-owner + task list). This is exactly
              MultiTaskControl, moved here from being a full-app-width band
              below main-content (R0A's mistake, see the R0B doc) — the
              component itself is byte-for-byte unchanged, only where it
              mounts and how its container is sized. */}
          <div className="center-bottom" style={{ height: layout.centerBottomHeight }}>
            <MultiTaskControl runtimeRunning={status.state === 'RUNNING'} armedProjectId={armedProjectId} onCancelTask={handleCancelTask} />
          </div>
        </div>

        <div
          className={`resize-handle${activeSide === 'right' ? ' active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize connection center panel"
          title="Drag to resize · double-click to reset"
          onMouseDown={startDrag('right')}
          onDoubleClick={resetSide('right')}
        />

        <div className="sidebar sidebar-right" style={{ width: layout.rightWidth }}>
          <ConnectionCenter
            connections={connections}
            capabilities={capabilities}
            pmProfileEntries={pmProfileEntries}
            lastChecked={lastChecked}
            refreshingKeys={refreshingKeys}
            onOpenLoginTerminal={(product, mode) => setLoginTerminalTarget({ product, mode })}
            onRefreshAll={() => void coordinatorRef.current?.refreshAll('full')}
            onRefreshOne={(product) => void coordinatorRef.current?.refreshOne(product, 'full')}
            onCreateProfile={(product) => setCreateProfileSeed({ product, variantOf: null })}
            onCreateVariant={(profile) => setCreateProfileSeed({ product: profile.product, variantOf: profile })}
            onUpdateApiKey={() => setUpdateApiKeyOpen(true)}
          />

          {/* P9-R0.4 Part L: dedicated management surface, deliberately
              separate from Connection Center — lifecycle status/actions
              get their own compact home as the profile count grows. */}
          <PmProfileManagement
            profiles={pmProfileEntries}
            onDeactivate={handleDeactivateProfile}
            onReactivate={handleReactivateProfile}
          />

          <ApprovalPanel
            interactions={inbox}
            unavailable={inboxUnavailable}
            projects={projects}
            armedProjectId={armedProjectId}
            onNavigate={setSelectedProject}
            onDecide={handleDecide}
            onReply={handleReply}
          />

          {status.state === 'RUNNING' && timeline.length === 0 && !timelineUnavailable && (
            <div className="info-card card">
              <div className="info-card-content">
                <p className="info-card-title">No Activity Yet</p>
                <p className="info-card-text">
                  Arm a project and submit a task, or use Telegram, to see activity here.
                </p>
                <p className="info-card-note">
                  Last refresh: {lastRefresh.toLocaleTimeString()}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <BackendRuns selectedProject={selectedProject} runtimeRunning={status.state === 'RUNNING'} armedProjectId={armedProjectId} onCancelTask={handleCancelTask} />
      <LongTaskRuntime runtimeRunning={status.state === 'RUNNING'} />
      <BackendExecutionLogs runtimeRunning={status.state === 'RUNNING'} />
      <ActivityPanel status={status} />

      {loginTerminalTarget && (
        <LoginTerminal
          product={loginTerminalTarget.product}
          mode={loginTerminalTarget.mode}
          onClose={() => setLoginTerminalTarget(null)}
        />
      )}

      {createProfileSeed && (
        <PmProfileCreateDialog
          product={createProfileSeed.product}
          capability={capabilities.find((c) => c.product === createProfileSeed.product)}
          existingIds={pmProfileEntries.map((p) => p.id)}
          variantOf={createProfileSeed.variantOf ? { id: createProfileSeed.variantOf.id, model: createProfileSeed.variantOf.model ?? null, reasoning: createProfileSeed.variantOf.reasoning ?? null } : null}
          onClose={() => setCreateProfileSeed(null)}
          onCreate={handleCreateProfile}
          onCreated={() => void refreshProfilesOnly()}
        />
      )}

      {updateApiKeyOpen && (
        <UpdateApiKeyDialog
          onClose={() => setUpdateApiKeyOpen(false)}
          onSave={handleUpdateApiKey}
          onUpdated={() => void coordinatorRef.current?.refreshOne('api', 'full')}
        />
      )}

      {showAddFolder && (
        <AddFolderDialog
          pmProfiles={pmProfiles}
          onClose={() => setShowAddFolder(false)}
          onAdded={({ restartRequired: needsRestart }) => {
            setRestartRequired(needsRestart);
            void refreshData();
          }}
        />
      )}
    </div>
  );
}

// M01/M02: main.ts never treats a missing/invalid repo root, missing
// production config, or missing required secret env names as something
// the normal app can silently work around — this gate keeps MainApp (and
// its effects, which assume every IPC call returns real data) from
// mounting at all until bootstrap:status confirms readiness.
function App() {
  const [blocked, setBlocked] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.desktop.bootstrap
      .status()
      .then((result) => {
        if (!cancelled) setBlocked(result.requiresFirstRun || !result.status?.readyToStart);
      })
      .catch(() => {
        if (!cancelled) setBlocked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (blocked === null) return <div className="first-run-loading">Loading…</div>;
  if (blocked) return <FirstRunBootstrap />;
  return <MainApp />;
}

export default App;
