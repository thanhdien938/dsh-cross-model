import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { resolveRepoRoot } from '../repoRoot';
import { DesktopSettingsStore } from './desktopSettingsStore';

// M02: config + secret-environment bootstrap. Mirrors repoRoot.ts's
// precedence shape (explicit env override > persisted Desktop setting >
// development-only fallback > MISSING) for both the production config
// path and the .env file path, and loads .env content directly in the
// main process — the renderer is never given raw values, only
// CONFIGURED/MISSING/INVALID.

export type PathSource = 'env' | 'setting' | 'dev-fallback' | null;

// M08 hardening: every tier is validated against the real filesystem, not
// just the dev-fallback tier — a persisted setting (or even an explicit
// env override) pointing at a file that no longer exists (moved, deleted,
// a stale value from before a repo was reorganized) must be reported
// MISSING, never blindly trusted as CONFIGURED merely because a path
// string was present.
export function resolveProductionConfigPath(repoRoot: string, persisted: string | null): { path: string | null; source: PathSource } {
  if (process.env.DSH_CONFIG_PATH) {
    const candidate = path.resolve(process.env.DSH_CONFIG_PATH);
    if (fs.existsSync(candidate)) return { path: candidate, source: 'env' };
  }
  if (persisted) {
    const candidate = path.resolve(persisted);
    if (fs.existsSync(candidate)) return { path: candidate, source: 'setting' };
  }
  const fallback = path.join(repoRoot, 'local-config.production.yaml');
  if (fs.existsSync(fallback)) return { path: fallback, source: 'dev-fallback' };
  return { path: null, source: null };
}

// The .env file is optional in the resolution sense (secrets could in
// principle already be present in the process environment), but if
// configured, it must actually exist to be trusted — same existence
// validation at every tier as resolveProductionConfigPath above.
export function resolveEnvFilePath(repoRoot: string, persisted: string | null): { path: string | null; source: PathSource } {
  if (process.env.DSH_ENV_FILE_PATH) {
    const candidate = path.resolve(process.env.DSH_ENV_FILE_PATH);
    if (fs.existsSync(candidate)) return { path: candidate, source: 'env' };
  }
  if (persisted) {
    const candidate = path.resolve(persisted);
    if (fs.existsSync(candidate)) return { path: candidate, source: 'setting' };
  }
  const fallback = path.join(repoRoot, '.env');
  if (fs.existsSync(fallback)) return { path: fallback, source: 'dev-fallback' };
  return { path: null, source: null };
}

// Pure parse — this never mutates process.env itself. The caller decides
// how to layer it into the runtime child's environment (see
// runtimeSupervisor.ts: process env, then loaded .env, then the ephemeral
// pipe capability last/highest-precedence so a stale .env value can never
// shadow a freshly generated one).
export function loadEnvFile(envFilePath: string | null): Record<string, string> {
  if (!envFilePath) return {};
  try {
    return dotenv.parse(fs.readFileSync(envFilePath));
  } catch {
    return {};
  }
}

// The production config YAML itself names which environment variables it
// needs (postgres.dsn_env, telegram.token_env) — this reads only those
// *names*, never any secret value, so Settings/status can honestly report
// PRESENT/MISSING per declared name without hardcoding a fixed list.
export function requiredEnvNames(productionConfigPath: string | null): string[] {
  if (!productionConfigPath || !fs.existsSync(productionConfigPath)) return [];
  try {
    const doc = parseYaml(fs.readFileSync(productionConfigPath, 'utf8'));
    const names: string[] = [];
    if (typeof doc?.postgres?.dsn_env === 'string') names.push(doc.postgres.dsn_env);
    if (typeof doc?.telegram?.token_env === 'string') names.push(doc.telegram.token_env);
    return names;
  } catch {
    return [];
  }
}

export interface BootstrapStatus {
  repoRoot: { state: 'CONFIGURED' | 'MISSING' | 'INVALID'; path: string | null; source: PathSource };
  productionConfig: { state: 'CONFIGURED' | 'MISSING'; path: string | null; source: PathSource };
  envFile: { state: 'CONFIGURED' | 'NOT_CONFIGURED'; path: string | null; source: PathSource };
  requiredEnvNames: { name: string; present: boolean }[];
  readyToStart: boolean;
}

// Everything Start needs to have already validated before spawning the
// runtime child — never printed values, only presence/absence.
export function buildBootstrapStatus(input: {
  repoRootPath: string | null;
  repoRootSource: PathSource;
  productionConfigResolution: { path: string | null; source: PathSource };
  envFileResolution: { path: string | null; source: PathSource };
  mergedEnv: NodeJS.ProcessEnv;
}): BootstrapStatus {
  const names = requiredEnvNames(input.productionConfigResolution.path);
  const requiredEnvNamesStatus = names.map((name) => ({ name, present: typeof input.mergedEnv[name] === 'string' && input.mergedEnv[name] !== '' }));
  const repoRootState: BootstrapStatus['repoRoot']['state'] = input.repoRootPath ? 'CONFIGURED' : 'MISSING';
  const productionConfigState: BootstrapStatus['productionConfig']['state'] = input.productionConfigResolution.path ? 'CONFIGURED' : 'MISSING';
  const envFileState: BootstrapStatus['envFile']['state'] = input.envFileResolution.path ? 'CONFIGURED' : 'NOT_CONFIGURED';
  return {
    repoRoot: { state: repoRootState, path: input.repoRootPath, source: input.repoRootSource },
    productionConfig: { state: productionConfigState, path: input.productionConfigResolution.path, source: input.productionConfigResolution.source },
    envFile: { state: envFileState, path: input.envFileResolution.path, source: input.envFileResolution.source },
    requiredEnvNames: requiredEnvNamesStatus,
    readyToStart: repoRootState === 'CONFIGURED' && productionConfigState === 'CONFIGURED' && requiredEnvNamesStatus.every((n) => n.present),
  };
}

// M08: the single authoritative bootstrap-status computation, reading
// CURRENT persisted settings on every call — never cached, never an
// immutable startup snapshot. main.ts calls this both at real startup and
// from the bootstrap:status IPC handler on every poll, so a picker action
// (which only persists a setting) is reflected the very next time the
// renderer asks, with no restart needed just to make the next picker
// appear. It never mutates process.env — the .env file is parsed into a
// disposable map purely to answer "is each required name PRESENT in the
// currently-selected file", laid under the real process.env (which always
// wins) so a stale/future value in the file can never contradict what the
// process actually has. Applying .env for real (writing into process.env)
// remains a one-time side effect in main.ts's initializeServices(), which
// only runs once per process lifetime.
export function computeBootstrapStatus(settingsStore: Pick<DesktopSettingsStore, 'get'>, currentEnv: NodeJS.ProcessEnv = process.env): { requiresFirstRun: boolean; status: BootstrapStatus } {
  const settings = settingsStore.get();
  const rootResolution = resolveRepoRoot(settings.dshRepoRoot);

  if (rootResolution.requiresFirstRun || !rootResolution.root) {
    const status = buildBootstrapStatus({
      repoRootPath: null,
      repoRootSource: null,
      productionConfigResolution: { path: null, source: null },
      envFileResolution: { path: null, source: null },
      mergedEnv: currentEnv,
    });
    return { requiresFirstRun: true, status };
  }

  const productionConfigResolution = resolveProductionConfigPath(rootResolution.root, settings.productionConfigPath);
  const envFileResolution = resolveEnvFilePath(rootResolution.root, settings.envFilePath);
  const loadedEnv = loadEnvFile(envFileResolution.path);
  const envForPresenceCheckOnly = { ...loadedEnv, ...currentEnv };

  const status = buildBootstrapStatus({
    repoRootPath: rootResolution.root,
    repoRootSource: rootResolution.source,
    productionConfigResolution,
    envFileResolution,
    mergedEnv: envForPresenceCheckOnly,
  });
  return { requiresFirstRun: false, status };
}
