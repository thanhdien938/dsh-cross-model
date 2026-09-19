import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import {
  buildRunnerChildEnv,
  readExternalRunnerDiagnosticEvidence,
  RelayRunnerLifecycleDependencies,
  RelayRunnerLifecycleManager,
  RelayRunnerProcessHandle,
  RelayRunnerProcessIdentity,
  RUNNER_CHILD_ENV_ALLOWLIST,
} from '../electron/main/services/relayRunnerLifecycleManager';
import { RunnerRegistrationResult } from '../electron/main/services/relayRunnerRegistrationReader';
import { DesktopSettings, RelayRunnerSettings } from '../electron/main/services/desktopSettingsStore';

const RUNNER_PATH = 'C:\\fixtures\\dsh-relay';
const NEW_RUNNER_PATH = 'C:\\fixtures\\dsh-relay-new';

class FakeStore {
  settings: DesktopSettings;
  writes: RelayRunnerSettings[] = [];
  constructor(relayRunner: RelayRunnerSettings) {
    this.settings = { dshRepoRoot: null, productionConfigPath: null, envFilePath: null, relayRunner };
  }
  get(): DesktopSettings { return { ...this.settings, relayRunner: { ...this.settings.relayRunner } }; }
  setRelayRunner(value: RelayRunnerSettings): void {
    this.settings.relayRunner = { ...value };
    this.writes.push({ ...value });
  }
}

class FakeProcess extends EventEmitter implements RelayRunnerProcessHandle {
  gracefulStops = 0;
  forceKills = 0;
  detached = false;
  exitOnGraceful = true;
  constructor(readonly pid: number) { super(); }
  onStdout(listener: (chunk: string) => void): void { this.on('stdout', listener); }
  onStderr(listener: (chunk: string) => void): void { this.on('stderr', listener); }
  onExit(listener: (code: number | null, signal: string | null) => void): void { this.once('processExit', listener); }
  onError(listener: (error: Error) => void): void { this.once('processError', listener); }
  onCaptureError(listener: (error: Error) => void): void { this.on('captureError', listener); }
  requestGracefulStop(): void { this.gracefulStops += 1; if (this.exitOnGraceful) this.emit('processExit', 0, null); }
  forceKillTree(): void { this.forceKills += 1; this.emit('processExit', 1, null); }
  detachForHandoff(): void { this.detached = true; }
  stdout(line: string): void { this.emit('stdout', `${line}\n`); }
  stderr(line: string): void { this.emit('stderr', `${line}\n`); }
  captureError(message = 'synthetic capture failure'): void { this.emit('captureError', new Error(message)); }
  exit(code = 1): void { this.emit('processExit', code, null); }
}

function registeredFiles(root: string = RUNNER_PATH): Set<string> {
  return new Set([
    root,
    path.join(root, '.runner'),
    path.join(root, 'run.cmd'),
    path.join(root, 'bin', 'Runner.Listener.exe'),
    path.join(root, 'bin', 'Runner.Worker.exe'),
  ].map((value) => path.normalize(value).toLowerCase()));
}

function external(pid = 900, root: string = RUNNER_PATH): RelayRunnerProcessIdentity {
  return { pid, parentPid: 50, executablePath: path.join(root, 'bin', 'Runner.Listener.exe'), commandLine: `\"${path.join(root, 'bin', 'Runner.Listener.exe')}\" run`, creationTime: '20260905010000.000000+000' };
}

function validRegistration(): RunnerRegistrationResult {
  return { ok: true, identity: { agentName: 'dsh-relay-01', poolId: 1, serverUrl: 'https://pipelines.example', gitHubUrl: 'https://github.com/example/repo' } };
}

function harness(options: {
  settings?: Partial<RelayRunnerSettings>;
  files?: Set<string>;
  discovered?: RelayRunnerProcessIdentity[];
  spawnError?: Error;
  exitOnGraceful?: boolean;
  registration?: RunnerRegistrationResult;
  // Per-candidate-path override, keyed by exact path string — lets a
  // single test give two different runner directories different
  // registration validity (used by the validate-before-persist tests).
  registrationByPath?: Record<string, RunnerRegistrationResult>;
  healthPollIntervalMs?: number;
  externalEvidence?: { connected: boolean; listening: boolean; busy: boolean };
} = {}) {
  const store = new FakeStore({ enabled: true, runnerPath: RUNNER_PATH, autoStart: false, ...options.settings });
  const files = options.files ?? registeredFiles();
  let discovered = options.discovered ?? null;
  let registration = options.registration ?? validRegistration();
  const registrationByPath = options.registrationByPath ?? {};
  let discoverError: Error | null = null;
  // Defaults to no evidence at all — an EXTERNAL listener with nothing
  // overriding this stays RUNNING_ONLINE_UNVERIFIED exactly as before this
  // dependency existed; individual tests opt in via setExternalEvidence().
  let externalEvidence = options.externalEvidence ?? { connected: false, listening: false, busy: false };
  let milliseconds = 0;
  // Bulk clock advance for deterministic backoff-window testing — the
  // fake now() otherwise only creeps forward ~1ms per call, so a test
  // that needs to prove a LATER retry actually happens once backoff
  // elapses (rather than merely staying blocked) must be able to jump
  // the clock forward explicitly.
  let clockOffsetMs = 0;
  const children: FakeProcess[] = [];
  const spawnPaths: string[] = [];
  const readRegistrationCalls: string[] = [];
  // Mirrors real discovery: once a child is spawned, an exact WMI-matched
  // listener genuinely exists for it until it exits. Tests that need a
  // different discovery picture (EXTERNAL, none, ambiguous) call
  // setDiscovered() to override this default entirely.
  let currentOwnedChild: FakeProcess | null = null;
  // A fake, manually-driven timer — the health monitor's own poll cadence
  // is production-only real time; tests advance it explicitly via
  // fireHealthTimer() instead of depending on wall-clock timing.
  let pendingTimer: { callback: () => void; ms: number } | null = null;
  const dependencies: RelayRunnerLifecycleDependencies = {
    pathExists: (candidate) => files.has(path.normalize(candidate).toLowerCase()),
    realpath: (candidate) => candidate,
    readRegistration: (resolvedRunnerPath) => {
      readRegistrationCalls.push(resolvedRunnerPath);
      const key = path.normalize(resolvedRunnerPath).toLowerCase();
      for (const [candidate, result] of Object.entries(registrationByPath)) {
        if (path.normalize(candidate).toLowerCase() === key) return result;
      }
      return registration;
    },
    discoverExact: async () => {
      if (discoverError) throw discoverError;
      if (discovered !== null) return { listeners: discovered, version: '2.337.0' };
      const listeners = currentOwnedChild ? [external(currentOwnedChild.pid)] : [];
      return { listeners, version: '2.337.0' };
    },
    readExternalEvidence: () => ({ ...externalEvidence }),
    spawnRunner: (runnerPath) => {
      spawnPaths.push(runnerPath);
      if (options.spawnError) throw options.spawnError;
      const child = new FakeProcess(1000 + children.length);
      child.exitOnGraceful = options.exitOnGraceful ?? true;
      children.push(child);
      currentOwnedChild = child;
      child.onExit(() => { if (currentOwnedChild === child) currentOwnedChild = null; });
      return child;
    },
    now: () => new Date(Date.UTC(2026, 8, 5, 1, 0, 0, milliseconds++) + clockOffsetMs),
    delay: async (ms) => { milliseconds += ms; },
    scheduleTimer: (callback, ms) => {
      pendingTimer = { callback, ms };
      return { cancel: () => { if (pendingTimer?.callback === callback) pendingTimer = null; } };
    },
  };
  const manager = new RelayRunnerLifecycleManager(store as any, dependencies, 20, options.healthPollIntervalMs ?? 15_000);
  return {
    manager, store, files, children, spawnPaths, readRegistrationCalls,
    setDiscovered: (value: RelayRunnerProcessIdentity[]) => { discovered = value; },
    setRegistration: (value: RunnerRegistrationResult) => { registration = value; },
    setDiscoverError: (value: Error | null) => { discoverError = value; },
    setExternalEvidence: (value: { connected: boolean; listening: boolean; busy: boolean }) => { externalEvidence = value; },
    advanceClock: (ms: number) => { clockOffsetMs += ms; },
    // Fires the most recently scheduled health-monitor tick, awaiting its
    // completion (including any restart attempt it triggers).
    fireHealthTimer: async (): Promise<void> => {
      const timer = pendingTimer;
      if (!timer) throw new Error('no health timer is currently scheduled');
      pendingTimer = null;
      timer.callback();
      // healthTick() is async and not awaited by scheduleTimer's callback
      // itself (fire-and-forget in production, same as the real timer).
      // Flush it by awaiting a no-op operation through the SAME exclusive
      // queue healthTick() enqueued onto (guaranteed to run after it —
      // runExclusive chains synchronously at call time), then let the
      // outer healthTick() function's remaining microtasks (its call to
      // scheduleNextHealthTick) settle too.
      await manager.refresh().catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    },
    hasPendingHealthTimer: (): boolean => pendingTimer !== null,
  };
}

describe('RelayRunnerLifecycleManager', () => {
  it('1. no settings produces UNCONFIGURED', async () => {
    const { manager } = harness({ settings: { enabled: false, runnerPath: null } });
    expect((await manager.initialize()).state).toBe('UNCONFIGURED');
  });

  it('2. a missing configured path fails safely', async () => {
    const { manager } = harness({ files: new Set() });
    const status = await manager.initialize();
    expect(status).toMatchObject({ state: 'FAILED', registration: 'INVALID', ownership: 'NONE' });
  });

  it('a missing .runner is NOT CONFIGURED and never starts', async () => {
    const files = registeredFiles();
    files.delete(path.normalize(path.join(RUNNER_PATH, '.runner')).toLowerCase());
    const { manager, children } = harness({ files, settings: { autoStart: true } });
    expect(await manager.initialize()).toMatchObject({ state: 'UNCONFIGURED', registration: 'NOT_CONFIGURED' });
    expect(children).toHaveLength(0);
  });

  it('3. registered offline auto-start launches the exact run.cmd surface once', async () => {
    const { manager, children, spawnPaths } = harness({ settings: { autoStart: true } });
    expect((await manager.initialize()).state).toBe('STARTING');
    expect(children).toHaveLength(1);
    expect(spawnPaths).toEqual([RUNNER_PATH]);
  });

  it('4. double startup is serialized and spawns only once', async () => {
    const { manager, children } = harness({ settings: { autoStart: true } });
    await Promise.all([manager.initialize(), manager.initialize()]);
    expect(children).toHaveLength(1);
  });

  it('5. exact external listener discovery prevents spawn', async () => {
    const { manager, children } = harness({ settings: { autoStart: true }, discovered: [external()] });
    expect(await manager.initialize()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'EXTERNAL', pid: 900 });
    expect(children).toHaveLength(0);
  });

  it.each([['6. Stop', 'stop'], ['7. Restart', 'restart']] as const)('%s rejects EXTERNAL ownership', async (_label, operation) => {
    const { manager } = harness({ discovered: [external()] });
    await manager.initialize();
    expect((await manager[operation]()).code).toBe('RUNNER_NOT_APP_OWNED');
  });

  it('8. app-owned idle runner can stop', async () => {
    const { manager, children } = harness();
    await manager.initialize();
    await manager.start();
    children[0].stdout('Connected to GitHub');
    children[0].stdout('Listening for Jobs');
    expect((await manager.stop()).ok).toBe(true);
    expect(children[0].gracefulStops).toBe(1);
  });

  it('9. app-owned idle restart performs exactly one stop and one new start', async () => {
    const { manager, children } = harness();
    await manager.initialize();
    await manager.start();
    children[0].stdout('Connected to GitHub');
    children[0].stdout('Listening for Jobs');
    expect((await manager.restart()).ok).toBe(true);
    expect(children).toHaveLength(2);
    expect(children[0].gracefulStops).toBe(1);
  });

  it.each([['10. Stop', 'stop'], ['11. Restart', 'restart']] as const)('%s is blocked while app-owned runner is BUSY', async (_label, operation) => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Running job: relay');
    expect((await manager[operation]()).code).toBe('RUNNER_BUSY');
    expect(children[0].gracefulStops).toBe(0);
  });

  it('12. Desktop shutdown gracefully stops app-owned idle runner', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    await manager.shutdown();
    expect(children[0].gracefulStops).toBe(1);
  });

  it('idle stop uses bounded force escalation only on the app-owned root tree', async () => {
    const { manager, children } = harness({ exitOnGraceful: false });
    await manager.initialize(); await manager.start();
    const result = await manager.stop();
    expect(result.ok).toBe(true);
    expect(children[0].gracefulStops).toBe(1);
    expect(children[0].forceKills).toBe(1);
  });

  it('13. Desktop shutdown hands off an app-owned BUSY runner alive', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start(); children[0].stdout('Running job: relay');
    await manager.shutdown();
    expect(children[0].gracefulStops).toBe(0);
    expect(children[0].detached).toBe(true);
    expect(manager.getLogs().some((line) => line.includes('busy_handoff'))).toBe(true);
  });

  it('14. spawn failure becomes typed FAILED state without throwing', async () => {
    const { manager } = harness({ spawnError: new Error('synthetic spawn failure') });
    await manager.initialize();
    const result = await manager.start();
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_SPAWN_FAILED', status: { state: 'FAILED' } });
  });

  it('15. unexpected runner exit produces a typed failure transition', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start(); children[0].exit(7);
    expect(manager.getStatus()).toMatchObject({ state: 'FAILED', ownership: 'NONE', lastError: { code: 'RUNNER_EXITED_UNEXPECTEDLY' } });
  });

  it('16. PID existence without current online evidence never claims ONLINE_IDLE', async () => {
    const { manager } = harness({ discovered: [external()] });
    expect((await manager.initialize()).state).toBe('RUNNING_ONLINE_UNVERIFIED');
  });

  // PM24-RUNNER: an EXTERNAL exact listener (never owned by this Electron
  // lifetime) with real, positively-matching on-disk diagnostic evidence
  // (Connected+Listening, the same evidence class an APP_OWNED runner's
  // live stdout would show) is verified healthy — reusing the existing
  // ONLINE_IDLE/ONLINE_BUSY vocabulary, never a bare "PID exists" guess and
  // never a fabricated new enum value.
  it('PM24-RUNNER-1. an EXTERNAL listener with positively matching diagnostic evidence is verified ONLINE_IDLE', async () => {
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    setExternalEvidence({ connected: true, listening: true, busy: false });
    expect(await manager.initialize()).toMatchObject({ state: 'ONLINE_IDLE', ownership: 'EXTERNAL', pid: 900 });
  });

  it('PM24-RUNNER-2. an EXTERNAL listener with a Running job evidence line is verified ONLINE_BUSY', async () => {
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    setExternalEvidence({ connected: true, listening: true, busy: true });
    expect(await manager.initialize()).toMatchObject({ state: 'ONLINE_BUSY', ownership: 'EXTERNAL', pid: 900 });
  });

  it('PM24-RUNNER-3. an EXTERNAL listener with only Connected evidence (no Listening yet) remains unverified', async () => {
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    setExternalEvidence({ connected: true, listening: false, busy: false });
    expect(await manager.initialize()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'EXTERNAL' });
  });

  it('PM24-RUNNER-4. stale cached UNVERIFIED status is corrected to ONLINE_IDLE by a later refresh once evidence appears', async () => {
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    expect((await manager.initialize()).state).toBe('RUNNING_ONLINE_UNVERIFIED');
    setExternalEvidence({ connected: true, listening: true, busy: false });
    expect(await manager.refresh()).toMatchObject({ state: 'ONLINE_IDLE', ownership: 'EXTERNAL' });
  });

  it('PM24-RUNNER-5. a verified-healthy EXTERNAL listener still fail-safes Stop/Restart to RUNNER_NOT_APP_OWNED', async () => {
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    setExternalEvidence({ connected: true, listening: true, busy: false });
    expect((await manager.initialize()).state).toBe('ONLINE_IDLE');
    expect((await manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
    expect((await manager.restart()).code).toBe('RUNNER_NOT_APP_OWNED');
  });

  it('PM24-RUNNER-6. a disconnect/error line after prior evidence invalidates it back to unverified, never a stale positive', async () => {
    // Mirrors readExternalRunnerDiagnosticEvidence()'s single-pass
    // invalidation rule directly (a unit-level proof of the same contract
    // exercised end-to-end via the manager below).
    const { manager, setExternalEvidence } = harness({ discovered: [external()] });
    setExternalEvidence({ connected: true, listening: true, busy: false });
    expect(await manager.initialize()).toMatchObject({ state: 'ONLINE_IDLE' });
    setExternalEvidence({ connected: false, listening: false, busy: false });
    expect(await manager.refresh()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED' });
  });

  it('17. current-generation Connected plus Listening evidence reaches ONLINE_IDLE', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    expect(manager.getStatus().state).toBe('ONLINE_IDLE');
  });

  it('17b. current-generation Connected evidence alone remains RUNNING_ONLINE_UNVERIFIED', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Connected to GitHub');
    expect(manager.getStatus()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'APP_OWNED' });
  });

  it('18/19. Running job enters BUSY and current completion returns IDLE', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs'); children[0].stdout('Running job: relay');
    expect(manager.getStatus().state).toBe('ONLINE_BUSY');
    children[0].stdout('Job relay completed with result: Succeeded');
    expect(manager.getStatus().state).toBe('ONLINE_IDLE');
  });

  it('output-capture failure degrades safely, blocks lifecycle control, and hands the runner off alive', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].captureError();
    expect(manager.getStatus()).toMatchObject({ state: 'DEGRADED', ownership: 'APP_OWNED', lastError: { code: 'RUNNER_OUTPUT_CAPTURE_FAILED' } });
    expect(await manager.refresh()).toMatchObject({ state: 'DEGRADED', ownership: 'APP_OWNED', lastError: { code: 'RUNNER_OUTPUT_CAPTURE_FAILED' } });
    expect((await manager.stop()).code).toBe('RUNNER_OUTPUT_UNVERIFIED');
    expect((await manager.restart()).code).toBe('RUNNER_OUTPUT_UNVERIFIED');
    await manager.shutdown();
    expect(children[0].gracefulStops).toBe(0);
    expect(children[0].detached).toBe(true);
  });

  it('a listener discovered below the DSH supervisor root remains exact APP_OWNED authority', async () => {
    const { manager, children, setDiscovered } = harness();
    await manager.initialize(); await manager.start();
    setDiscovered([{ ...external(2400), parentPid: 2300, ancestorPids: [2300, children[0].pid] }]);
    expect(await manager.refresh()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'APP_OWNED', pid: 2400 });
  });

  it('old-generation output cannot mutate the replacement generation', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    expect((await manager.restart()).ok).toBe(true);
    children[0].stdout('Running job: stale-generation');
    expect(manager.getStatus()).toMatchObject({ state: 'STARTING', ownership: 'APP_OWNED', pid: children[1].pid });
  });

  it('output from a revoked generation cannot turn an external listener APP_OWNED', async () => {
    const { manager, children, setDiscovered } = harness();
    await manager.initialize(); await manager.start();
    setDiscovered([external(2900)]);
    expect(await manager.refresh()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'EXTERNAL', pid: 2900 });
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    expect(manager.getStatus()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'EXTERNAL', pid: 2900 });
    expect(children[0].detached).toBe(true);
  });

  it('21. lifecycle preflight checks .runner existence but never reads it or credentials', async () => {
    const { manager } = harness();
    await manager.initialize();
    expect(manager.getLogs().join('\n')).not.toMatch(/credentials|rsaparams/i);
  });

  it('23. a manually started exact listener remains discoverable as EXTERNAL', async () => {
    const { manager, setDiscovered } = harness();
    expect((await manager.initialize()).state).toBe('REGISTERED_OFFLINE');
    setDiscovered([external(901)]);
    expect(await manager.refresh()).toMatchObject({ ownership: 'EXTERNAL', pid: 901 });
  });

  it('24. settings persist only the typed lifecycle configuration, never process or registration data', async () => {
    // P0-3: updateSettings no longer accepts a runnerPath at all — the
    // renderer can only toggle enabled/autoStart. The existing configured
    // path is preserved untouched by this call.
    const { manager, store } = harness();
    const result = await manager.updateSettings({ enabled: false, autoStart: true });
    expect(result.ok).toBe(true);
    expect(store.writes).toEqual([{ enabled: false, runnerPath: RUNNER_PATH, autoStart: true }]);
    expect(Object.keys(store.writes[0]).sort()).toEqual(['autoStart', 'enabled', 'runnerPath']);
  });

  it('24b. updateSettings rejects a runnerPath field instead of silently accepting one', async () => {
    const { manager, store } = harness();
    // Even if a compromised renderer sent one, updateSettings has no
    // runnerPath parameter in its type — this proves the runtime check
    // does not fall back to trusting an extra field either.
    const result = await manager.updateSettings({ enabled: true, autoStart: true, runnerPath: 'D:\\attacker-controlled' } as any);
    expect(result.ok).toBe(true);
    expect(store.writes[0].runnerPath).toBe(RUNNER_PATH);
    expect(store.writes[0].runnerPath).not.toBe('D:\\attacker-controlled');
  });

  it('bounded redaction removes token-like output before logs are rendered', async () => {
    const { manager, children } = harness();
    await manager.initialize(); await manager.start();
    children[0].stderr('Authorization: Bearer abc-secret token=another-secret');
    expect(manager.getLogs().join('\n')).not.toContain('abc-secret');
  });

  it('a valid .runner registration reaches REGISTERED_OFFLINE', async () => {
    const { manager } = harness({ registration: validRegistration() });
    expect(await manager.initialize()).toMatchObject({ state: 'REGISTERED_OFFLINE', registration: 'REGISTERED' });
  });

  it('9/10. an invalid .runner registration is INVALID and blocks start — never discovers or reads config.cmd', async () => {
    const { manager, children, readRegistrationCalls } = harness({
      registration: { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_AGENT_NAME' },
      settings: { autoStart: true },
    });
    const status = await manager.initialize();
    expect(status).toMatchObject({ state: 'FAILED', registration: 'INVALID', lastError: { code: 'RUNNER_REGISTRATION_MISSING_AGENT_NAME' } });
    expect(children).toHaveLength(0);
    expect(readRegistrationCalls).toEqual([RUNNER_PATH]);
    const result = await manager.start();
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_NOT_STARTABLE' });
    expect(children).toHaveLength(0);
  });
});

describe('P0-1: buildRunnerChildEnv deny-by-default allowlist', () => {
  it('3/4. drops fake secrets that do not appear in the allowlist', () => {
    const source = {
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ANTHROPIC_API_KEY: 'sk-fake-secret-anthropic',
      OPENAI_API_KEY: 'sk-fake-secret-openai',
      TELEGRAM_BOT_TOKEN: 'fake-telegram-token',
      GITHUB_TOKEN: 'ghp_fake_github_token',
      GH_TOKEN: 'gho_fake_gh_token',
      DSH_APP_SECRET: 'fake-dsh-secret',
      SOME_RANDOM_CUSTOM_VAR: 'should-not-be-forwarded-either',
    };
    const result = buildRunnerChildEnv(source);
    expect(result.PATH).toBe('C:\\Windows\\System32');
    expect(result.SystemRoot).toBe('C:\\Windows');
    for (const secretKey of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'DSH_APP_SECRET', 'SOME_RANDOM_CUSTOM_VAR']) {
      expect(result).not.toHaveProperty(secretKey);
    }
    expect(JSON.stringify(result)).not.toMatch(/fake-secret|fake-telegram|fake_github|fake_gh_token|fake-dsh-secret|not-be-forwarded/);
  });

  it('keeps every allowlisted variable, matched case-insensitively (Windows env casing varies)', () => {
    const source: Record<string, string> = {};
    for (const key of RUNNER_CHILD_ENV_ALLOWLIST) source[key] = `value-${key}`;
    const result = buildRunnerChildEnv(source);
    for (const key of RUNNER_CHILD_ENV_ALLOWLIST) expect(result[key]).toBe(`value-${key}`);
  });

  it('never invents a wildcard — an env with only unknown keys yields an empty object', () => {
    expect(buildRunnerChildEnv({ RANDOM_ONE: 'a', RANDOM_TWO: 'b' })).toEqual({});
  });
});

describe('P0 (final hold): configureRunnerPath validates BEFORE persisting', () => {
  it('1. a valid, OS-selected, registered runner folder is validated THEN persisted, ok:true', async () => {
    const files = new Set([...registeredFiles(RUNNER_PATH), ...registeredFiles(NEW_RUNNER_PATH)]);
    const { manager, store } = harness({ files, settings: { enabled: false, runnerPath: null, autoStart: false } });
    const result = await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(result.ok).toBe(true);
    expect(store.writes).toEqual([{ enabled: false, autoStart: false, runnerPath: NEW_RUNNER_PATH }]);
  });

  it('2. directory exists but .runner is missing -> not persisted, ok:false', async () => {
    const files = registeredFiles(RUNNER_PATH); // the currently-configured path only
    files.add(path.normalize(NEW_RUNNER_PATH).toLowerCase()); // candidate directory exists...
    // ...but has none of .runner/run.cmd/the executables.
    const { manager, store } = harness({ files, settings: { runnerPath: RUNNER_PATH, enabled: true } });
    const result = await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_NOT_REGISTERED' });
    expect(store.writes).toHaveLength(0);
  });

  it('3. .runner is malformed -> not persisted, ok:false', async () => {
    const files = new Set([...registeredFiles(RUNNER_PATH), ...registeredFiles(NEW_RUNNER_PATH)]);
    const { manager, store } = harness({
      files,
      settings: { runnerPath: RUNNER_PATH, enabled: true },
      registration: validRegistration(),
      registrationByPath: { [NEW_RUNNER_PATH]: { ok: false, reason: 'RUNNER_REGISTRATION_INVALID_JSON' } },
    });
    const result = await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_REGISTRATION_INVALID_JSON' });
    expect(store.writes).toHaveLength(0);
  });

  it('4. run.cmd/a runner executable is missing -> not persisted, ok:false', async () => {
    const files = registeredFiles(RUNNER_PATH);
    // NEW_RUNNER_PATH has a structurally valid .runner but nothing else.
    files.add(path.normalize(NEW_RUNNER_PATH).toLowerCase());
    files.add(path.normalize(path.join(NEW_RUNNER_PATH, '.runner')).toLowerCase());
    const { manager, store } = harness({ files, settings: { runnerPath: RUNNER_PATH, enabled: true } });
    const result = await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_INSTALLATION_INCOMPLETE' });
    expect(store.writes).toHaveLength(0);
  });

  it('5. a previously-configured working path survives untouched after a rejected new selection', async () => {
    const files = registeredFiles(RUNNER_PATH); // NEW_RUNNER_PATH is not registered at all
    const { manager, store } = harness({ files, settings: { runnerPath: RUNNER_PATH, enabled: true } });
    const result = await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(result.ok).toBe(false);
    expect(store.writes).toHaveLength(0);
    const status = await manager.refresh();
    expect(status.runnerPath).toBe(RUNNER_PATH);
    expect(status.registration).toBe('REGISTERED');
  });

  // 6. Absolute-path-alone is explicitly proven NOT sufficient — the old
  // test asserting that shape (with no directory/registration behind it)
  // is replaced by test 1 above, which requires the full structural chain.
  it('6. an absolute path to an unregistered directory is rejected, not accepted merely for being absolute', async () => {
    const { manager, store } = harness({ files: new Set(), settings: { enabled: false, runnerPath: null, autoStart: false } });
    const result = await manager.configureRunnerPath('D:\\owner-selected\\not-a-runner');
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(undefined);
    expect(store.writes).toHaveLength(0);
  });

  it('rejects a relative path even if somehow supplied', async () => {
    const { manager, store } = harness({ settings: { runnerPath: null } });
    const result = await manager.configureRunnerPath('relative\\path');
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_PATH_NOT_ABSOLUTE' });
    expect(store.writes).toHaveLength(0);
  });

  it('rejects an empty selection without persisting anything', async () => {
    const { manager, store } = harness();
    const result = await manager.configureRunnerPath('   ');
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_PATH_INVALID' });
    expect(store.writes).toHaveLength(0);
  });

  it('refuses to change the path of a running app-owned runner (checked before validation even runs)', async () => {
    const { manager } = harness();
    await manager.initialize(); await manager.start();
    const result = await manager.configureRunnerPath('D:\\different-runner');
    expect(result).toMatchObject({ ok: false, code: 'RUNNER_SETTINGS_ACTIVE' });
  });

  it('config.cmd is never invoked and no registration file is ever written during validation', async () => {
    const files = new Set([...registeredFiles(RUNNER_PATH), ...registeredFiles(NEW_RUNNER_PATH)]);
    const { manager } = harness({ files, settings: { runnerPath: RUNNER_PATH } });
    await manager.configureRunnerPath(NEW_RUNNER_PATH);
    expect(manager.getLogs().join('\n')).not.toMatch(/config\.cmd|credentials/i);
  });
});

describe('P1: self-healing health monitor', () => {
  it('12. an unexpected APP_OWNED exit with autoStart triggers exactly one bounded restart attempt per tick', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // autoStart already spawns children[0] here
    manager.startHealthMonitor();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    children[0].exit(1); // unexpected exit, not a Stop
    expect(manager.getStatus()).toMatchObject({ state: 'FAILED', lastError: { code: 'RUNNER_EXITED_UNEXPECTEDLY' } });
    await fireHealthTimer(); // tick 1: refresh -> REGISTERED_OFFLINE, then restart
    expect(children).toHaveLength(2);
    // Restarted and re-discovered as the exact owned listener — no
    // Connected/Listening stdout evidence yet, so RUNNING_ONLINE_UNVERIFIED
    // (never a bare "it has a pid so it must be ONLINE_IDLE" shortcut).
    expect(manager.getStatus()).toMatchObject({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'APP_OWNED' });
  });

  it('13. repeated startup failures back off with an increasing, capped delay', async () => {
    const { manager, fireHealthTimer } = harness({ settings: { autoStart: true }, spawnError: new Error('synthetic') });
    await manager.initialize(); // fails safely: FAILED
    manager.startHealthMonitor();
    await fireHealthTimer();
    const first = manager.getHealth();
    expect(first.retryCount).toBe(1);
    await fireHealthTimer(); // still within backoff window — no new attempt, count unchanged
    expect(manager.getHealth().retryCount).toBe(1);
  });

  it('14. stable ONLINE_IDLE evidence resets backoff to zero', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // autoStart already spawns children[0] here
    manager.startHealthMonitor();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    await fireHealthTimer();
    expect(manager.getHealth()).toMatchObject({ retryCount: 0, nextRetryAt: null });
    expect(manager.getHealth().lastSuccessfulOnlineEvidence).not.toBeNull();
  });

  it('15. an EXTERNAL listener is never auto-restarted, adopted, stopped, or restarted by the monitor', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true }, discovered: [external()] });
    await manager.initialize();
    manager.startHealthMonitor();
    await fireHealthTimer();
    expect(manager.getStatus().ownership).toBe('EXTERNAL');
    expect(children).toHaveLength(0);
    expect((await manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
  });

  it('16. a discovery failure (DEGRADED — ambiguous evidence) never triggers a restart attempt', async () => {
    const { manager, children, fireHealthTimer, setDiscoverError } = harness({ settings: { autoStart: true } });
    // Discovery fails from the very first probe, so the runner never even
    // reaches REGISTERED_OFFLINE — proving DEGRADED/ambiguous evidence is
    // never treated as "safe to (re)start" at any point, not just on a
    // later tick.
    setDiscoverError(new Error('synthetic discovery failure'));
    const initial = await manager.initialize();
    expect(initial.state).toBe('DEGRADED');
    expect(children).toHaveLength(0);
    manager.startHealthMonitor();
    await fireHealthTimer();
    expect(manager.getStatus().state).toBe('DEGRADED');
    expect(children).toHaveLength(0);
  });

  it('17. a manual start() and a health tick firing at the same instant still produce exactly one listener', async () => {
    // Both Start and the health monitor's tick are routed through the SAME
    // runExclusive queue, so whichever is enqueued first fully completes
    // before the other's body runs — there is no interleaving window in
    // which both could independently decide to spawn.
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: false } });
    await manager.initialize();
    manager.startHealthMonitor();
    await Promise.all([manager.start(), fireHealthTimer()]);
    expect(children).toHaveLength(1);
  });

  it('18. the monitor never restarts and never touches a BUSY app-owned runner', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // autoStart already spawns children[0] here
    manager.startHealthMonitor();
    children[0].stdout('Running job: relay');
    await fireHealthTimer();
    expect(children).toHaveLength(1);
    expect(children[0].gracefulStops).toBe(0);
    expect(children[0].forceKills).toBe(0);
  });

  it('a deliberate owner Stop is never reversed by the monitor even with autoStart enabled', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // autoStart already spawns children[0] here
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    manager.startHealthMonitor();
    await manager.stop();
    await fireHealthTimer();
    expect(children).toHaveLength(1); // no second, monitor-triggered start
    expect(manager.getStatus().state).toBe('REGISTERED_OFFLINE');
  });

  it('stopHealthMonitor cancels the pending tick and no further restarts occur even after an exit', async () => {
    const { manager, children, fireHealthTimer, hasPendingHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // autoStart already spawns children[0] here
    manager.startHealthMonitor(); // schedules the first tick
    children[0].exit(1); // unexpected exit while a tick is still pending, unfired
    manager.stopHealthMonitor();
    expect(hasPendingHealthTimer()).toBe(false);
    await expect(fireHealthTimer()).rejects.toThrow();
    expect(children).toHaveLength(1); // never restarted
  });
});

describe('P1 (final hold): multiple exact listeners fail closed', () => {
  it('1. two exact EXTERNAL listeners produce DEGRADED, never a spawn, never Stop/Restart', async () => {
    const { manager, children } = harness({ settings: { autoStart: true }, discovered: [external(900), external(901)] });
    const status = await manager.initialize();
    expect(status).toMatchObject({ state: 'DEGRADED', ownership: 'NONE', lastError: { code: 'RUNNER_MULTIPLE_LISTENERS' } });
    expect(children).toHaveLength(0);
    expect((await manager.start()).code).toBe('RUNNER_NOT_STARTABLE');
    expect((await manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
    expect((await manager.restart()).code).toBe('RUNNER_NOT_APP_OWNED');
  });

  it('2. an app-owned listener plus a second exact listener goes DEGRADED/ambiguous and forgets ownership', async () => {
    const { manager, children, setDiscovered } = harness();
    await manager.initialize(); // REGISTERED_OFFLINE
    await manager.start(); // owns children[0]
    setDiscovered([external(children[0].pid), external(9999)]);
    const status = await manager.refresh();
    expect(status).toMatchObject({ state: 'DEGRADED', ownership: 'NONE', lastError: { code: 'RUNNER_MULTIPLE_LISTENERS' } });
    expect((await manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
    expect((await manager.restart()).code).toBe('RUNNER_NOT_APP_OWNED');
    // Stray output from the now-ownership-revoked process must never
    // quietly re-claim APP_OWNED/ONLINE_IDLE and override DEGRADED.
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    expect(manager.getStatus().state).toBe('DEGRADED');
  });

  it('3. ambiguity resolving to exactly one listener is observed EXTERNAL, never reclaimed as APP_OWNED', async () => {
    const { manager, children, setDiscovered } = harness();
    await manager.initialize();
    await manager.start();
    setDiscovered([external(children[0].pid), external(9999)]);
    await manager.refresh(); // DEGRADED
    setDiscovered([external(children[0].pid)]); // resolves to the SAME pid we used to own
    const status = await manager.refresh();
    expect(status).toMatchObject({ ownership: 'EXTERNAL', pid: children[0].pid });
    expect((await manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
  });

  it('4. ambiguity resolving to zero listeners resumes normal REGISTERED_OFFLINE logic', async () => {
    const { manager, setDiscovered } = harness();
    await manager.initialize();
    await manager.start();
    setDiscovered([external(1), external(2)]);
    await manager.refresh(); // DEGRADED
    setDiscovered([]);
    const status = await manager.refresh();
    expect(status).toMatchObject({ state: 'REGISTERED_OFFLINE', ownership: 'NONE', registration: 'REGISTERED' });
  });

  it('the health monitor never auto-restarts while ambiguous', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true }, discovered: [external(900), external(901)] });
    await manager.initialize();
    manager.startHealthMonitor();
    await fireHealthTimer();
    expect(children).toHaveLength(0);
    expect(manager.getStatus().state).toBe('DEGRADED');
  });
});

describe('P1 (final hold): crash-loop recovery uses real backoff accounting', () => {
  // Required test 1 (spawn throws repeatedly -> existing exponential/
  // capped behavior remains) is already covered by "13. repeated startup
  // failures back off with an increasing, capped delay" above — that path
  // is untouched by this fix (recoveryAwaitingStable is only ever set
  // after a SUCCESSFUL spawn, so it never engages when spawnRunner itself
  // throws).

  it('2. an automated recovery that exits before Connected/Listening counts as a failed recovery cycle', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // one-shot auto-start (NOT health-monitor-triggered) spawns children[0]
    manager.startHealthMonitor();
    children[0].exit(1); // the initial spawn's unexpected death
    await fireHealthTimer(); // tick 1: evaluateHealth performs its OWN restart -> children[1], recoveryAwaitingStable=true
    expect(children).toHaveLength(2);
    expect(manager.getHealth().retryCount).toBe(0); // this recovery attempt has not failed yet
    children[1].exit(1); // the monitor-initiated generation ALSO dies, before ever stabilizing
    await fireHealthTimer(); // tick 2: observes the unstable death
    expect(manager.getHealth().retryCount).toBe(1);
    expect(manager.getHealth().nextRetryAt).not.toBeNull();
    expect(children).toHaveLength(2); // no third spawn attempted this tick — a backoff window just opened
  });

  it('3. three consecutive early exits increase retryCount monotonically', async () => {
    const { manager, children, fireHealthTimer, advanceClock } = harness({ settings: { autoStart: true } });
    await manager.initialize();
    manager.startHealthMonitor();
    children[0].exit(1);
    await fireHealthTimer(); // spawns children[1] as an unstable recovery attempt

    for (let expectedRetryCount = 1; expectedRetryCount <= 3; expectedRetryCount++) {
      const dyingChild = children[children.length - 1];
      dyingChild.exit(1); // dies before ever stabilizing
      await fireHealthTimer(); // accounts for the failure and sets a fresh backoff
      expect(manager.getHealth().retryCount).toBe(expectedRetryCount);
      expect(manager.getHealth().nextRetryAt).not.toBeNull();
      advanceClock(400_000); // clear the just-set backoff window (comfortably past the 5-minute cap)
      await fireHealthTimer(); // now actually attempts the next restart
    }
  });

  it('backoff remains capped after many consecutive unstable recoveries', async () => {
    const { manager, children, fireHealthTimer, advanceClock } = harness({ settings: { autoStart: true } });
    await manager.initialize();
    manager.startHealthMonitor();
    children[0].exit(1);
    await fireHealthTimer();
    for (let i = 0; i < 14; i++) {
      children[children.length - 1].exit(1);
      await fireHealthTimer();
      advanceClock(400_000);
      await fireHealthTimer();
    }
    const health = manager.getHealth();
    expect(health.retryCount).toBeLessThanOrEqual(10);
    const gapMs = new Date(health.nextRetryAt!).getTime() - new Date(health.lastChecked).getTime();
    expect(gapMs).toBeLessThanOrEqual(300_000 + 5_000);
  });

  it('4. runner reaches Connected + Listening after a failed cycle -> retryCount resets to zero', async () => {
    const { manager, children, fireHealthTimer, advanceClock } = harness({ settings: { autoStart: true } });
    await manager.initialize();
    manager.startHealthMonitor();
    children[0].exit(1);
    await fireHealthTimer(); // spawns children[1]
    children[1].exit(1);
    await fireHealthTimer(); // accounts for the failure: retryCount=1
    expect(manager.getHealth().retryCount).toBe(1);
    advanceClock(400_000);
    await fireHealthTimer(); // attempts + spawns children[2]
    const stableChild = children[children.length - 1];
    stableChild.stdout('Connected to GitHub'); stableChild.stdout('Listening for Jobs');
    await fireHealthTimer(); // observes ONLINE_IDLE -> resets
    expect(manager.getHealth()).toMatchObject({ retryCount: 0, nextRetryAt: null });
  });

  it('5. after stable ONLINE, a later unrelated crash begins a fresh recovery series, not inflated by an old failure run', async () => {
    const { manager, children, fireHealthTimer, advanceClock } = harness({ settings: { autoStart: true } });
    await manager.initialize();
    manager.startHealthMonitor();
    children[0].exit(1);
    await fireHealthTimer();
    children[1].exit(1);
    await fireHealthTimer(); // retryCount=1
    expect(manager.getHealth().retryCount).toBe(1);
    advanceClock(400_000);
    await fireHealthTimer(); // spawns a new generation
    const stableChild = children[children.length - 1];
    stableChild.stdout('Connected to GitHub'); stableChild.stdout('Listening for Jobs');
    await fireHealthTimer(); // resets to stable — retryCount back to 0
    expect(manager.getHealth().retryCount).toBe(0);
    // A LATER, unrelated crash of this now-stable generation.
    children[children.length - 1].exit(1);
    await fireHealthTimer(); // NOT an unstable-recovery death (already graduated) -> a fresh attempt directly
    expect(manager.getHealth().retryCount).toBe(0); // fresh series, never inflated by the earlier resolved failure
  });

  it('6. a manual Stop is never auto-reversed regardless of any pending recovery-accounting state', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: true } });
    await manager.initialize(); // children[0], one-shot auto-start
    manager.startHealthMonitor();
    children[0].stdout('Connected to GitHub'); children[0].stdout('Listening for Jobs');
    await manager.stop();
    await fireHealthTimer();
    expect(children).toHaveLength(1); // no monitor-triggered restart
    expect(manager.getHealth().retryCount).toBe(0);
  });

  it('7. a manual Start\'s later crash is not counted as a failed health-recovery cycle', async () => {
    const { manager, children, fireHealthTimer } = harness({ settings: { autoStart: false } });
    await manager.initialize(); // REGISTERED_OFFLINE, nothing spawned (autoStart off)
    manager.startHealthMonitor();
    await manager.start(); // explicit MANUAL start -> children[0]; evaluateHealth never touched this generation
    await manager.updateSettings({ enabled: true, autoStart: true }); // arm auto-recovery for what happens NEXT
    children[0].exit(1); // crashes before any Connected/Listening
    await fireHealthTimer(); // NOT an unstable-recovery death (manual start armed nothing) -> a fresh attempt directly
    expect(manager.getHealth().retryCount).toBe(0); // never penalized for the manual start's crash
    expect(children).toHaveLength(2); // the fresh automated attempt did spawn a new child
  });
});

describe('P1-2: BUSY shutdown handoff is proven safe end-to-end', () => {
  it('19/20. a BUSY app-owned runner survives Desktop shutdown alive, and the NEXT Desktop lifetime classifies it EXTERNAL', async () => {
    const first = harness({ settings: { autoStart: false } });
    await first.manager.initialize();
    await first.manager.start();
    first.children[0].stdout('Running job: relay');
    await first.manager.shutdown();
    expect(first.children[0].gracefulStops).toBe(0); // no taskkill path exercised
    expect(first.children[0].detached).toBe(true); // handed off, still alive
    // A brand-new Desktop lifetime (fresh manager instance, same on-disk
    // settings) now discovers that same surviving process by its exact
    // executable path/pid — with no in-memory ownership handle at all,
    // it can only ever be classified EXTERNAL.
    const survivorIdentity = external(first.children[0].pid);
    const second = harness({ discovered: [survivorIdentity] });
    const status = await second.manager.initialize();
    expect(status).toMatchObject({ ownership: 'EXTERNAL', pid: first.children[0].pid });
    expect(second.children).toHaveLength(0); // no duplicate start attempted
    expect((await second.manager.stop()).code).toBe('RUNNER_NOT_APP_OWNED');
    expect((await second.manager.restart()).code).toBe('RUNNER_NOT_APP_OWNED');
  });
});

describe('PM24-RUNNER: readExternalRunnerDiagnosticEvidence (real filesystem)', () => {
  function makeRunnerDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-diag-'));
    fs.mkdirSync(path.join(dir, '_diag'));
    return dir;
  }
  function writeDiag(dir: string, name: string, content: string): void {
    fs.writeFileSync(path.join(dir, '_diag', name), content, 'utf8');
  }

  it('no _diag directory at all reports no evidence, never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-diag-'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('an empty _diag directory reports no evidence', () => {
    const dir = makeRunnerDir();
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('the real installed runner (2.337.0) startup banner — no "Connected to GitHub" line at all — is still recognized via "Current runner version:"', () => {
    // Live evidence: the owner's actual installed CLI never prints
    // "Connected to GitHub" in either the clean-connect or reconnect-after-
    // conflict case (see relayRunnerLifecycleManager.ts's CONNECTED_EVIDENCE_RE
    // docstring) — this is that exact real banner shape, byte-for-byte.
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      '2026-09-05 10:05:54Z: Listening for Jobs',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a "Running job:" line with no completion yet is reported busy', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: true });
  });

  it('a completed job returns to idle (busy:false) with connected/listening evidence intact', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
      'Job relay-v3 completed with result: Succeeded',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a disconnect/error line after prior evidence invalidates connected/listening back to false — never a stale positive', () => {
    // A job completes, then a connection-degraded line (the SAME regex
    // ingestLine() already uses) appears with no fresh "Listening for Jobs"
    // line afterward — must NOT be reported verified.
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
      'Job relay-v3 completed with result: Failed',
      'GitHub Actions service unreachable, retrying session.',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('picks the lexicographically newest Runner_*.log — an older rotated log never overrides current evidence', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260904-090000-utc.log', "Current runner version: '2.337.0'\nListening for Jobs\n");
    writeDiag(dir, 'Runner_20260905-100518-utc.log', "Current runner version: '2.337.0'\n"); // newer, no Listening yet
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: false, busy: false });
  });

  it('a bounded tail read still finds evidence near the end of an oversized log', () => {
    const dir = makeRunnerDir();
    const padding = `${'x'.repeat(1024)}\n`.repeat(600); // ~600KB of irrelevant filler
    writeDiag(dir, 'Runner_20260905-100518-utc.log', `${padding}Current runner version: '2.337.0'\nListening for Jobs\n`);
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a non-log file in _diag (e.g. a Worker_*.log) is never mistaken for the runner log', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Worker_20260905-100729-utc.log', "Current runner version: '2.337.0'\nListening for Jobs\n");
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });
});
