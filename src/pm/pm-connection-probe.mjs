import { spawn as nodeSpawn } from 'node:child_process';
import { loadCodexCatalogue, catalogueToModelDiscoveryFields } from './codex-model-catalogue.mjs';
import { buildProviderChildEnv } from '../session/provider-child-policy.mjs';

// P6-W3-R4/P6.5 Part A/E/G/C/D: safe, non-mutating native probes for the
// four production PM backends. Every probe here is read-only by
// construction — `claude auth status`, `opencode auth list`, `codex login
// status`, `grok models` — none of these are documented as mutating auth
// state, and none of them are ever called with `login`/`logout` argv (that
// stays the closed LoginTerminalSession surface in desktop/electron/main/
// services/loginTerminalService.ts). Every probe is bounded by
// `timeoutMs` and wrapped so a hung/misbehaving CLI degrades to UNKNOWN,
// never a thrown exception or an indefinite hang.
//
// P6.5: this module was originally spawnSync-based. Desktop responsiveness
// forensics (docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md) proved that ran
// synchronously on the Electron *main* process whenever Connection
// Center's `backends:capabilities`/`backends:capability` IPC handlers
// called into it — each spawnSync call blocks the entire main process
// event loop for its own duration, so a single Refresh All (up to ~4
// backends x up to 2 spawns each) could freeze the whole UI for multiple
// seconds. Every probe here is now spawn()+Promise-based instead —
// functionally identical output/timeout/sanitization behavior, but the
// event loop stays free for the whole probe duration. `runBoundedProbe()`
// is the one shared async primitive (Part D); every per-product prober
// goes through it.
//
// Evidence for the exact commands/flags below was gathered live against
// the installed CLIs on the owner's machine during the R4 wave:
//   claude 2.1.235   -> `claude auth status` (JSON), `claude --help`
//   opencode 1.18.18 -> `opencode auth list`, `opencode models`
//   codex 0.147.0    -> `codex login status`, `codex doctor --json`
//   grok 1.0.5       -> `grok models` (also the model-list source)
// See docs/p6/implementation/24_CONNECTION_CENTER_V2.md for the full
// research log and the exact transcripts.

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
function strip(text) { return String(text ?? '').replace(ANSI_ESCAPE, ''); }
function needsShell(binary) { return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary ?? '')); }

// P6.5 Part D — the one shared async, bounded, Windows-safe probe
// primitive. Never uses shell:true except for the existing .cmd/.bat
// platform-wrapper case every sync probe already required. Kills only the
// one child process it spawned, only on timeout; never touches any other
// process (real task execution uses entirely separate spawn call sites).
// stdout/stderr are each capped at `maxOutputBytes` so a runaway/verbose
// CLI can never grow unbounded memory.
export function runBoundedProbe({ executable, args, provider, timeoutMs = 6000, maxOutputBytes = 256 * 1024, spawnImpl = nodeSpawn }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(executable, args, { windowsHide: true, shell: needsShell(executable), stdio: ['ignore', 'pipe', 'pipe'], env: buildProviderChildEnv({provider}) });
    } catch {
      resolve({ ok: false, timedOut: false, stdout: '', stderr: '', exitCode: null, durationMs: Date.now() - startedAt });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort — only this probe child */ }
      finish({ ok: false, timedOut: true, stdout: strip(stdout), stderr: strip(stderr), exitCode: null });
    }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { if (stdout.length < maxOutputBytes) stdout += String(chunk).slice(0, maxOutputBytes - stdout.length); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < maxOutputBytes) stderr += String(chunk).slice(0, maxOutputBytes - stderr.length); });
    child.once('error', () => finish({ ok: false, timedOut: false, stdout: '', stderr: '', exitCode: null }));
    child.once('close', (code) => finish({ ok: true, timedOut: false, stdout: strip(stdout), stderr: strip(stderr), exitCode: code }));
  });
}

// Back-compat thin wrapper each per-product prober below calls — same
// {timeoutMs, spawnImpl} shape the sync version used, now async.
function run(spawnImpl, binary, args, timeoutMs, provider) {
  return runBoundedProbe({ executable: binary, args, provider, timeoutMs, spawnImpl }).then((r) => ({ ok: r.ok, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr, code: r.exitCode }));
}

function baseFacts(authDetail) {
  return { authProbe: 'SUPPORTED', authState: 'UNKNOWN', authDetail, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'unavailable' } };
}

// Tier-2 "documented CLI model list" (Part E2): parsed live from the
// installed CLI's own --help text rather than a hardcoded catalogue, so it
// tracks whatever the installed claude binary currently documents. Bounded
// window + token allowlist so this can never accidentally slurp unrelated
// help text.
function extractClaudeModelAliases(helpText) {
  const idx = helpText.indexOf('--model <model>');
  if (idx < 0) return null;
  const window = helpText.slice(idx, idx + 400);
  const tokens = [...window.matchAll(/'([a-z0-9][a-z0-9._-]{0,40})'/gi)].map((m) => m[1]);
  const unique = [...new Set(tokens)];
  return unique.length ? unique : null;
}

// R41-5: `mode: 'auto'` skips the heavier, slower-changing secondary spawn
// (claude --help / opencode models / codex doctor --json) that a fresh
// 'full' probe (Refresh, Refresh All, Login/Logout, or the very first
// probe of a session) always runs — the caller (ProductionPmBackendRegistry
// .capability()/.capabilities()) merges the always-fresh auth fields with
// its own per-product static-fact cache for whatever was skipped. Grok has
// no separate secondary spawn to skip (`grok models` is the auth probe
// *and* the model/native-default source in one call), so `mode` makes no
// difference to it.
async function probeClaude(binary, { timeoutMs, spawnImpl, mode }) {
  const facts = baseFacts(null);
  const authR = await run(spawnImpl, binary, ['auth', 'status'], timeoutMs, 'claude-code');
  if (authR.ok) {
    try {
      const parsed = JSON.parse(authR.stdout.trim());
      if (typeof parsed?.loggedIn === 'boolean') {
        facts.authState = parsed.loggedIn ? 'LOGGED_IN' : 'LOGGED_OUT';
        // Deliberately never forwards email/orgId/orgName/subscriptionType
        // (Part I): only the boolean and the auth method are safe enough
        // to render.
        facts.authDetail = parsed.loggedIn ? `logged in via ${parsed.authMethod ?? 'unknown method'}` : 'not logged in';
      } else {
        facts.authDetail = 'auth status returned an unrecognized shape';
      }
    } catch {
      facts.authDetail = 'auth status output was not parseable JSON';
    }
  } else {
    facts.authDetail = authR.timedOut ? 'auth probe timed out' : 'auth probe command failed to run';
  }

  if (mode !== 'auto') {
    const help = await run(spawnImpl, binary, ['--help'], timeoutMs, 'claude-code');
    if (help.ok) {
      const models = extractClaudeModelAliases(help.stdout);
      facts.modelDiscovery = { supported: Boolean(models), models, source: models ? 'claude --help text (documented aliases, not an exhaustive catalogue)' : 'unavailable' };
    }
  }
  return facts;
}

async function probeOpenCode(binary, { timeoutMs, spawnImpl, mode }) {
  const facts = baseFacts(null);
  const authR = await run(spawnImpl, binary, ['auth', 'list'], timeoutMs, 'opencode');
  if (authR.ok) {
    const text = `${authR.stdout}\n${authR.stderr}`;
    const match = text.match(/(\d+)\s+credentials?/i);
    if (match) {
      const count = Number(match[1]);
      facts.authState = count > 0 ? 'LOGGED_IN' : 'LOGGED_OUT';
      facts.authDetail = count > 0 ? `${count} provider credential(s) configured` : 'no provider credentials configured';
    } else {
      facts.authDetail = 'auth list output was not recognized';
    }
  } else {
    facts.authDetail = authR.timedOut ? 'auth probe timed out' : 'auth probe command failed to run';
  }

  if (mode !== 'auto') {
    const modelsR = await run(spawnImpl, binary, ['models'], timeoutMs, 'opencode');
    if (modelsR.ok) {
      const list = modelsR.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(line));
      const models = list.length ? [...new Set(list)].slice(0, 200) : null;
      facts.modelDiscovery = { supported: Boolean(models), models, source: models ? 'opencode models (configured providers)' : 'unavailable' };
    }
  }
  return facts;
}

async function probeCodex(binary, { timeoutMs, spawnImpl, mode }) {
  const facts = baseFacts(null);
  const statusR = await run(spawnImpl, binary, ['login', 'status'], timeoutMs, 'codex');
  if (statusR.ok) {
    const text = `${statusR.stdout}${statusR.stderr}`.trim();
    if (/not logged in/i.test(text)) {
      facts.authState = 'LOGGED_OUT';
      facts.authDetail = text.slice(0, 160);
    } else if (/logged in/i.test(text)) {
      facts.authState = 'LOGGED_IN';
      facts.authDetail = text.slice(0, 160);
    } else {
      facts.authDetail = 'login status output was not recognized';
    }
  } else {
    facts.authDetail = statusR.timedOut ? 'auth probe timed out' : 'auth probe command failed to run';
  }

  // codex doctor --json is Codex's own redacted diagnostic report — safe to
  // parse for the configured model and, only if the dedicated probe above
  // was inconclusive, as secondary corroborating auth evidence (Part A3's
  // evidence hierarchy). It never overrides a LOGGED_IN/LOGGED_OUT result
  // the dedicated probe already produced. It is also the single slowest
  // probe in this file (runs many diagnostic checks), so it is the one
  // R41-5 skips on an 'auto' (periodic) refresh.
  if (mode !== 'auto') {
    const doctorR = await run(spawnImpl, binary, ['doctor', '--json'], timeoutMs, 'codex');
    if (doctorR.ok) {
      try {
        const parsed = JSON.parse(doctorR.stdout.trim());
        const model = parsed?.checks?.['config.load']?.details?.model;
        if (typeof model === 'string' && model) facts.nativeDefaultModel = model;
        if (facts.authState === 'UNKNOWN' && parsed?.checks?.['auth.credentials']?.status === 'ok') {
          facts.authState = 'LOGGED_IN';
          facts.authDetail = 'codex doctor reports auth is configured';
        }
      } catch { /* non-authoritative: doctor output is best-effort only */ }
    }
  }
  // P11-R5.1 Part A/M: `codex debug models` (a real, documented, local,
  // non-secret CLI subcommand — see codex-model-catalogue.mjs's header)
  // is tried first; a DSH-managed JSON catalogue is the fallback only
  // when that live command is unavailable. Either way `source` says
  // honestly which one actually produced this result — never claims to
  // be live when it fell back, never hides that live discovery worked.
  // `supported: true` means "a real, curated option list exists" for
  // either mode.
  const catalogue = await loadCodexCatalogue({ spawnImpl, binary, timeoutMs });
  const catalogueFields = catalogueToModelDiscoveryFields(catalogue);
  facts.modelDiscovery = {
    supported: catalogueFields.models.length > 0,
    models: catalogueFields.models.length ? catalogueFields.models : null,
    source: catalogueFields.models.length ? catalogueFields.source : 'no Codex model catalogue (live discovery and JSON fallback both unavailable)',
    modelLabels: catalogueFields.models.length ? catalogueFields.modelLabels : null,
    modelEffortLevels: catalogueFields.models.length ? catalogueFields.modelEffortLevels : null,
  };
  return facts;
}

async function probeGrok(binary, { timeoutMs, spawnImpl }) {
  const facts = baseFacts(null);
  // `grok models` triples as the auth probe, native-default-model source,
  // and model discovery source (Part M): the CLI's own first line states
  // whether the owner is logged in before it prints the model catalogue.
  const modelsR = await run(spawnImpl, binary, ['models'], timeoutMs, 'grok');
  if (modelsR.ok) {
    const text = modelsR.stdout;
    if (/you are logged in/i.test(text)) {
      facts.authState = 'LOGGED_IN';
      facts.authDetail = (text.match(/you are logged in[^\n]*/i) ?? [])[0] ?? 'logged in';
    } else if (/not logged in|run `?grok login`?|sign in/i.test(text)) {
      facts.authState = 'LOGGED_OUT';
      facts.authDetail = 'grok reports not logged in';
    } else {
      facts.authDetail = 'models output was not recognized';
    }
    const defaultMatch = text.match(/Default model:\s*(\S+)/i);
    if (defaultMatch) facts.nativeDefaultModel = defaultMatch[1];
    const list = [...text.matchAll(/^\s*[*-]\s+([a-z0-9][a-z0-9._-]*)/gim)].map((m) => m[1]);
    const models = list.length ? [...new Set(list)] : null;
    facts.modelDiscovery = { supported: Boolean(models), models, source: models ? 'grok models' : 'unavailable' };
  } else {
    facts.authDetail = modelsR.timedOut ? 'auth probe timed out' : 'auth probe command failed to run';
  }
  return facts;
}

// P9-R0 Part C/N/V: `agy models` is a metadata-only call (proven live —
// completes in ~1s with no usage/token output, unlike a real `-p` prompt
// run) that also doubles as the auth probe: an unauthenticated CLI cannot
// fetch the live model catalogue, so a successful, non-empty model list is
// real evidence of LOGGED_IN — never inferred merely from "CLI installed"
// or a `--version` success (Part C). A run that completes but yields no
// recognizable model lines, or fails to run at all, stays UNKNOWN rather
// than guessing LOGGED_OUT — this environment never exercised a genuine
// logged-out `agy` to observe its real wording (Part C: "never infer login
// solely from... version command success" cuts both ways — absence of
// success is not proof of logged-out either). Slugs like
// "gemini-3.7-flash-high" / "claude-sonnet-4-6" / "gpt-oss-120b-medium"
// were observed live (docs/p9/01) — first whitespace-delimited token per
// line, tab-separated from a human display name.
function extractAntigravityModelSlugs(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const slugs = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0];
    if (/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(first)) slugs.push(first);
  }
  return [...new Set(slugs)];
}

async function probeAntigravity(binary, { timeoutMs, spawnImpl }) {
  const facts = baseFacts(null);
  const modelsR = await run(spawnImpl, binary, ['models'], timeoutMs, 'antigravity');
  if (modelsR.ok && modelsR.code === 0) {
    const slugs = extractAntigravityModelSlugs(modelsR.stdout);
    if (slugs.length) {
      facts.authState = 'LOGGED_IN';
      facts.authDetail = `agy models returned ${slugs.length} model(s)`;
      facts.modelDiscovery = { supported: true, models: slugs, source: 'agy models' };
    } else if (/not authenticated|please (sign|log) in|authentication required/i.test(`${modelsR.stdout}${modelsR.stderr}`)) {
      facts.authState = 'LOGGED_OUT';
      facts.authDetail = 'agy models reports authentication is required';
    } else {
      facts.authDetail = 'agy models returned no recognizable model list';
    }
  } else {
    facts.authDetail = modelsR.timedOut ? 'model discovery probe timed out' : 'model discovery probe command failed to run';
  }
  return facts;
}

const PROBES = Object.freeze({ 'claude-code': probeClaude, opencode: probeOpenCode, codex: probeCodex, grok: probeGrok, antigravity: probeAntigravity });

// Fail-closed default facts for a product whose CLI is not installed, or
// whose live probe threw unexpectedly (Part A3: never fabricate LOGGED_IN
// from weak/absent evidence).
export function unavailableConnectionFacts(reason = 'CLI not installed') {
  return { authProbe: 'SUPPORTED', authState: 'UNKNOWN', authDetail: reason, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'unavailable' } };
}

// `mode`: 'full' (default) probes everything this product supports; 'auto'
// (R41-5) probes only the always-fresh auth fields and skips the heavier
// secondary spawn — see the per-product functions above for exactly what
// that means per product. Async (P6.5): every spawn this reaches is
// non-blocking, so awaiting this never stalls the caller's event loop.
export async function probeConnectionFacts(product, binary, { timeoutMs = 6000, spawnImpl = nodeSpawn, mode = 'full' } = {}) {
  const probe = PROBES[product];
  if (!probe) return { authProbe: 'UNSUPPORTED', authState: 'UNKNOWN', authDetail: 'no auth probe defined for this product', nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'unsupported product' } };
  try {
    return await probe(binary, { timeoutMs, spawnImpl, mode });
  } catch {
    return { authProbe: 'SUPPORTED', authState: 'ERROR', authDetail: 'connection probe threw unexpectedly', nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'error' } };
  }
}

// R41-4/P6.5: combines the "is it installed" and "what version" checks
// into one bounded, timeout-safe, non-blocking spawn — cheaper than two
// separate probes, and a hung `--version` can no longer hang Connection
// Center (or the Electron main event loop) at all.
export async function probeInstalledAndVersion(binary, { timeoutMs = 5000, spawnImpl = nodeSpawn, product = null } = {}) {
  if (typeof binary !== 'string' || !binary) return { installed: false, version: null };
  const r = await run(spawnImpl, binary, ['--version'], timeoutMs, product);
  if (!r.ok || r.code !== 0) return { installed: false, version: null };
  const version = String(r.stdout || r.stderr).trim().split(/\r?\n/)[0] || null;
  return { installed: true, version };
}
