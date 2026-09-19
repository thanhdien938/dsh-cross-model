import { spawn } from 'node:child_process';
import { buildProviderChildEnv } from './provider-child-policy.mjs';

// P6.5 Part C/D/E: async, non-blocking counterpart to each session bridge's
// existing synchronous `resolveXBinary()` (still spawnSync-based, still
// used unchanged by the runtime child process's own registry construction
// — see production-pm-backend-registry.mjs's constructor defaults, which
// this file deliberately does NOT touch). Electron main process forensics
// (docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md) found the sync resolvers,
// called eagerly as constructor defaults, spawning up to ~13 sequential
// synchronous `--version` child processes (2-4 candidates x 2-4 platform
// suffixes, per product) — a real multi-second UI freeze source when that
// path runs on the Electron main process itself (not the separate runtime
// child process, where synchronous work never touches the UI thread).
//
// `resolveBinaryAsync` reproduces the exact same first-match-wins
// candidate/suffix search order as every `resolveXBinary()`, just via
// `spawn()` + a bounded timeout instead of the synchronous spawn call, so it never
// blocks the event loop it runs on. Electron main resolves all four
// products' binaries in parallel (`Promise.all`) rather than the eager
// synchronous defaults — see main.ts's `getPmBackendRegistry()` and
// loginTerminalService.ts's `PRODUCTS` table.

export function concreteBinaryCandidates(base) {
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(base)) {
    return [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`];
  }
  return [base];
}

function needsShell(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
}

// Resolves true only if the candidate binary actually runs `--version`
// successfully within `timeoutMs` — same success criterion every sync
// resolver already uses (`probe.status === 0`). Never throws; a spawn
// error, non-zero exit, or timeout all resolve `false`. On timeout, only
// this one probe child is killed — nothing else is touched.
function probeAsync(binary, timeoutMs, provider) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(binary, ['--version'], { windowsHide: true, stdio: 'ignore', shell: needsShell(binary), env: buildProviderChildEnv({provider}) });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best-effort */ }
      resolve(false);
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function resolveBinaryAsync(candidates, fallback, { timeoutMs = 3000, provider = null } = {}) {
  for (const candidate of candidates) {
    for (const concrete of concreteBinaryCandidates(candidate)) {
      // eslint-disable-next-line no-await-in-loop -- first-match-wins search must stay sequential to match the sync resolvers' semantics
      if (await probeAsync(concrete, timeoutMs, provider)) return concrete;
    }
  }
  return fallback;
}
