import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

export const PROVIDER_EXECUTABLE_RESOLUTION_SOURCE = Object.freeze({
  CONFIGURED: 'CONFIGURED',
  KNOWN_INSTALL: 'KNOWN_INSTALL',
  PATH_DISCOVERY: 'PATH_DISCOVERY',
});

const PORTABLE_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'TERM', 'TZ',
]);

const PROVIDER_ENV_KEYS = Object.freeze({
  'claude-code': Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR']),
  opencode: Object.freeze(['OPENCODE_API_KEY', 'OPENCODE_CONFIG_DIR']),
  codex: Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME']),
  grok: Object.freeze(['XAI_API_KEY', 'GROK_API_KEY', 'GROK_HOME']),
  antigravity: Object.freeze(['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ANTIGRAVITY_HOME']),
});

const PROVIDER_EXECUTABLE_CONFIG_KEYS = Object.freeze({
  'claude-code': 'DSH_CLAUDE_EXECUTABLE',
  opencode: 'DSH_OPENCODE_EXECUTABLE',
  codex: 'DSH_CODEX_EXECUTABLE',
  grok: 'DSH_GROK_EXECUTABLE',
  antigravity: 'DSH_ANTIGRAVITY_EXECUTABLE',
});

const ALWAYS_DENIED_ENV_KEYS = new Set([
  'DSH_RUNTIME_CONTROL_AUTH', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'POSTGRES_URL', 'POSTGRES_DSN', 'DATABASE_URL',
]);

function sourceEntry(sourceEnv, requestedKey) {
  if (Object.hasOwn(sourceEnv, requestedKey)) return [requestedKey, sourceEnv[requestedKey]];
  if (process.platform !== 'win32') return null;
  const found = Object.keys(sourceEnv).find((key) => key.toUpperCase() === requestedKey.toUpperCase());
  return found ? [requestedKey, sourceEnv[found]] : null;
}

function deniedEnvKey(key) {
  const upper = String(key).toUpperCase();
  return upper.startsWith('DSH_') || ALWAYS_DENIED_ENV_KEYS.has(upper)
    || upper.startsWith('TELEGRAM_') || upper.includes('POSTGRES_DSN');
}

/** Build the complete environment for a less-trusted provider child. */
export function buildProviderChildEnv({ provider, sourceEnv = process.env, requiredEnv = {} } = {}) {
  const result = {};
  for (const key of [...PORTABLE_ENV_KEYS, ...(PROVIDER_ENV_KEYS[provider] ?? [])]) {
    const entry = sourceEntry(sourceEnv, key);
    if (entry && entry[1] !== undefined && entry[1] !== null) result[entry[0]] = String(entry[1]);
  }
  if (requiredEnv && typeof requiredEnv === 'object' && !Array.isArray(requiredEnv)) {
    for (const [key, value] of Object.entries(requiredEnv)) {
      if (deniedEnvKey(key) || value === undefined || value === null) continue;
      result[key] = String(value);
    }
  }
  return Object.freeze(result);
}

// DSH-TIMEOUT-1 Part E (audit Finding T-4): the ONE shared cleanup call
// every CLI bridge's own internal timeout handler makes when its bounded
// `timeoutMs` elapses, so a bridge-level timeout reuses the EXACT SAME
// SIGTERM -> grace -> `taskkill /PID <pid> /T /F` (Windows, full process
// tree) / SIGKILL (POSIX) -> bounded reap-wait sequence that owner-
// cancel/shutdown already gets — never a second, weaker cleanup path.
//
// `child.__dshReapOwnedProcessTree` is attached (only in the real
// production path) by `withReapedOwnedSpawnLifecycle()`
// (runtime/backend-execution-observer.mjs) — the SAME wrapper already
// responsible for reaping on `AbortSignal` — as a direct reference to its
// own internal `terminate()` closure; calling it here does not duplicate
// that closure's tree-kill logic, it reuses it verbatim from a second
// trigger (the bridge's own timer firing) as well as the first (the
// caller's AbortSignal firing). A caller that constructs its own bare
// `spawnImpl` (every direct/test caller that never goes through the
// production registry) never gets this property attached at all, so this
// helper falls back to the exact prior behavior — a plain `child.kill()`
// — for every one of those callers, unchanged.
export async function reapOwnedChildProcess(child) {
  const reap = child?.__dshReapOwnedProcessTree;
  if (typeof reap === 'function') {
    const result = await reap();
    return result ?? { state: 'CONFIRMED_EXITED', pid: child?.pid ?? null };
  }
  try { child?.kill?.(); } catch { /* best-effort, matches prior behavior */ }
  return { state: 'UNRESOLVED_OWNERSHIP', pid: child?.pid ?? null };
}

export function concreteProviderExecutableCandidates(base, { platform = process.platform, pathExt = process.env.PATHEXT } = {}) {
  if (platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(base)) return [base];
  const extensions = String(pathExt || '.EXE;.CMD;.BAT')
    .split(';').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return [base, ...new Set(extensions.map((extension) => `${base}${extension.startsWith('.') ? extension : `.${extension}`}`))];
}

export function providerExecutableNeedsShell(executable) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

function canonicalExistingPath(candidate) {
  if (!isAbsolute(candidate) || !existsSync(candidate)) return null;
  try { return realpathSync.native(candidate); } catch { return null; }
}

function insideTrustedRoot(candidate, roots) {
  return roots.some((root) => {
    const canonicalRoot = canonicalExistingPath(root) ?? root;
    const rel = relative(canonicalRoot, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

// P16-LIVE-004: a real owner-live OpenCode task proved that spawning
// opencode.cmd with shell:true (required to avoid the P16-LIVE-001 spawn
// EINVAL on Windows) silently corrupts any prompt containing embedded
// newlines or double quotes -- node's shell:true on win32 hands cmd.exe a
// SINGLE naive `[file, ...args].join(' ')` string with no per-argument
// escaping (see node's own child_process docs warning on this), and
// cmd.exe's own command parser is line-oriented: it cannot carry a raw
// newline through one `/C "..."` invocation at all, regardless of quoting.
// The DSH PM contract's rendered prompt is always multi-line by design
// (Task/Request context/History sections), so this is not
// content-specific -- it reproduced on every real multi-line prompt tried
// (docs/p16-live/07_OPENCODE_PM_DECISION_REMEDIATION.md has the exact
// before/after capture). Every other provider (Claude/Codex/Grok/
// Antigravity) already resolves to a real native executable and spawns it
// with shell:false, which has none of this failure mode.
// opencode.cmd itself is npm's standard generated shim -- a single,
// unconditional line that forwards every argument verbatim to a real
// native .exe sitting next to it (verified by reading the real installed
// shim; https://github.com/npm/cmd-shim's well-known template). Rather
// than trying to make cmd.exe's line-oriented parser safe for a
// multi-line argument (it structurally cannot be), this resolves straight
// through the shim to that real .exe so live execution never touches
// cmd.exe at all. Deliberately narrow: it only unwraps a shim matching
// EXACTLY that one verified shape (one `%*`-forwarding line, one quoted
// `%dp0%\...` relative target, that target ending in `.exe`) and only
// returns a resolved path that both exists and stays inside the SAME
// trusted root the shim itself was resolved from (STRICT_DEFAULT: this
// never widens trust, it only follows a verified-safe indirection within
// it). Anything else -- multiple targets, conditional branches, missing
// or oversized file, a target outside the trusted root -- returns null
// and the caller falls back to the original (still shell:true-safe) .cmd
// candidate, unchanged from before this fix.
const NPM_CMD_SHIM_TARGET_RE = /^"%dp0%[\\/]([^"]+\.exe)"\s+%\*$/i;

export function resolveWindowsCmdShimTarget(shimPath, trustedRoots) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(shimPath)) return null;
  let content;
  try {
    const stat = statSync(shimPath);
    if (!stat.isFile() || stat.size > 4096) return null;
    content = readFileSync(shimPath, 'utf8');
  } catch { return null; }
  const forwardingLines = content.split(/\r?\n/).filter((line) => line.includes('%*'));
  if (forwardingLines.length !== 1) return null;
  const match = forwardingLines[0].trim().match(NPM_CMD_SHIM_TARGET_RE);
  if (!match) return null;
  const canonicalTarget = canonicalExistingPath(join(dirname(shimPath), match[1]));
  if (!canonicalTarget || !insideTrustedRoot(canonicalTarget, trustedRoots)) return null;
  return canonicalTarget;
}

function syncProbe(provider, executable, sourceEnv, timeoutMs) {
  try {
    const probe = spawnSync(executable, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      shell: providerExecutableNeedsShell(executable), env: buildProviderChildEnv({ provider, sourceEnv }),
    });
    if (probe.status !== 0) return null;
    return String(probe.stdout || probe.stderr || '').trim().slice(0, 512) || 'version-probe-ok';
  } catch { return null; }
}

function unavailable(provider, code, source = null) {
  return Object.freeze({ available: false, provider, family: provider, path: null, source, version: null, code });
}

function available(provider, path, source, version) {
  return Object.freeze({ available: true, provider, family: provider, path, source, version, code: null });
}

/**
 * STRICT_DEFAULT: PATH lookup is disabled unless allowPathDiscovery is true.
 * Configured paths must be absolute. Known installs must be absolute and stay
 * inside their declared trusted root after canonical realpath resolution.
 */
export function resolveProviderExecutableSync({
  provider,
  configuredPath = null,
  knownCandidates = [],
  trustedRoots = knownCandidates.filter(isAbsolute).map(dirname),
  executableName = null,
  allowPathDiscovery = false,
  sourceEnv = process.env,
  timeoutMs = 3000,
} = {}) {
  const selected = selectExecutableCandidate({provider,configuredPath,knownCandidates,trustedRoots,executableName,allowPathDiscovery,sourceEnv});
  if (selected.candidates.length === 0) return unavailable(provider, selected.code, selected.source);
  for (const candidate of selected.candidates) {
    const version = syncProbe(provider, candidate.path, sourceEnv, timeoutMs);
    if (version) return available(provider, candidate.path, candidate.source, version);
  }
  return unavailable(provider, 'PROVIDER_EXECUTABLE_UNAVAILABLE', selected.source);
}

function selectExecutableCandidate({provider,configuredPath,knownCandidates,trustedRoots,executableName,allowPathDiscovery,sourceEnv}) {
  if (configuredPath !== null && configuredPath !== undefined) {
    if (typeof configuredPath !== 'string' || !isAbsolute(configuredPath)) return {candidates:[],code:'PROVIDER_EXECUTABLE_UNTRUSTED',source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.CONFIGURED};
    const canonical = canonicalExistingPath(configuredPath);
    if (!canonical) return {candidates:[],code:'PROVIDER_EXECUTABLE_NOT_FOUND',source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.CONFIGURED};
    return {candidates:[{path:canonical,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.CONFIGURED}],code:null,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.CONFIGURED};
  }

  const candidates=[];
  for (const base of knownCandidates) {
    if (typeof base !== 'string' || !isAbsolute(base)) continue;
    for (const candidate of concreteProviderExecutableCandidates(base, { pathExt: sourceEnv.PATHEXT })) {
      const canonical = canonicalExistingPath(candidate);
      if (!canonical || !insideTrustedRoot(canonical, trustedRoots)) continue;
      // P16-LIVE-004: prefer the real .exe a Windows .cmd/.bat shim
      // forwards to (see resolveWindowsCmdShimTarget's docstring) — pushed
      // AHEAD of the shim itself so it is probed first; the shim candidate
      // stays in the list unchanged as the exact same fallback this
      // resolver already had before this fix.
      const unwrapped = resolveWindowsCmdShimTarget(canonical, trustedRoots);
      if (unwrapped) candidates.push({path:unwrapped,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.KNOWN_INSTALL});
      candidates.push({path:canonical,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.KNOWN_INSTALL});
    }
  }
  if(candidates.length>0)return{candidates,code:null,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.KNOWN_INSTALL};

  if (!allowPathDiscovery) return {candidates:[],code:'PROVIDER_EXECUTABLE_UNTRUSTED',source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.PATH_DISCOVERY};
  const discovered = discoverOnPath(executableName, sourceEnv);
  if (!discovered) return {candidates:[],code:'PROVIDER_EXECUTABLE_NOT_FOUND',source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.PATH_DISCOVERY};
  return {candidates:[{path:discovered,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.PATH_DISCOVERY}],code:null,source:PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.PATH_DISCOVERY};
}

export function providerExecutablePolicy({ provider, executableName, knownCandidates, sourceEnv = process.env } = {}) {
  const configKey = PROVIDER_EXECUTABLE_CONFIG_KEYS[provider];
  return {
    provider,
    configuredPath: configKey && sourceEnv[configKey] ? sourceEnv[configKey] : null,
    knownCandidates,
    executableName,
    allowPathDiscovery: sourceEnv.DSH_ALLOW_PROVIDER_PATH_DISCOVERY === '1',
    sourceEnv,
  };
}

function discoverOnPath(executableName, sourceEnv) {
  if (typeof executableName !== 'string' || !executableName || isAbsolute(executableName)) return null;
  const pathValue = sourceEntry(sourceEnv, 'PATH')?.[1];
  if (!pathValue) return null;
  for (const root of String(pathValue).split(delimiter).filter(Boolean)) {
    for (const candidate of concreteProviderExecutableCandidates(join(root, executableName), { pathExt: sourceEntry(sourceEnv, 'PATHEXT')?.[1] })) {
      const canonical = canonicalExistingPath(candidate);
      if (canonical) return canonical;
    }
  }
  return null;
}

export async function resolveProviderExecutable({ ...options } = {}) {
  const sourceEnv=options.sourceEnv??process.env;
  const knownCandidates=options.knownCandidates??[];
  const selected=selectExecutableCandidate({...options,knownCandidates,sourceEnv,trustedRoots:options.trustedRoots??knownCandidates.filter(isAbsolute).map(dirname)});
  if(selected.candidates.length===0)return unavailable(options.provider,selected.code,selected.source);
  for(const candidate of selected.candidates){
    const version=await asyncProbe(options.provider,candidate.path,sourceEnv,options.timeoutMs??3000);
    if(version)return available(options.provider,candidate.path,candidate.source,version);
  }
  return unavailable(options.provider,'PROVIDER_EXECUTABLE_UNAVAILABLE',selected.source);
}

function asyncProbe(provider, executable, sourceEnv, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    try {
      child = spawn(executable, ['--version'], {
        windowsHide: true, shell: providerExecutableNeedsShell(executable), stdio: ['ignore', 'pipe', 'pipe'],
        env: buildProviderChildEnv({ provider, sourceEnv }),
      });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { if (stdout.length < 512) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 512) stderr += chunk; });
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code === 0 ? String(stdout || stderr).trim().slice(0, 512) || 'version-probe-ok' : null));
  });
}
