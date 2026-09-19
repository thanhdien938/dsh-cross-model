import { spawn as nodeSpawn } from 'node:child_process';
import { basename } from 'node:path';

// P9-R0.1 Part C: async counterpart to Desktop's existing, synchronous
// `gatherGitFacts()` (desktop/electron/main/services/projectRegistry.ts,
// used only by the infrequent Add Folder flow on Electron main). This is a
// PORT of that exact same field shape and git-subcommand set — not a
// literal import, since that file lives in Electron-main TypeScript and
// this one needs to run from the plain-ESM runtime layer (src/pm/*.mjs),
// invoked once per PM turn via the Antigravity context packet (Part B).
// Reusing the sync implementation here (P6.5 Part D) would put a
// synchronous git subprocess on a path that runs far more often than Add
// Folder — every spawn below is async/bounded instead, so this never blocks
// whichever event loop calls it.
//
// Read-only Git observation only — every subcommand below is a plain,
// non-mutating `git` subcommand (mirrors the W2-I invariant the sync
// version documents). No Git write action is ever issued from here.

const DEFAULT_TIMEOUT_MS = 3000;

function runGit(args, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('git', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best-effort */ } finish({ ok: false, stdout: '' }); }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => { if (stdout.length < 65536) stdout += String(chunk).slice(0, 65536 - stdout.length); });
    child.once('error', () => finish({ ok: false, stdout: '' }));
    child.once('close', (code) => finish({ ok: code === 0, stdout }));
  });
}

// Same GitFacts shape as the sync version: { isGitRepo, root, branch,
// detachedHead, dirtyCount, hasRemote, repoName }. Never throws — any
// individual probe failure degrades that one field to its "unknown" value
// (false/null), exactly like the sync version's own failure handling.
export async function gatherGitFactsAsync(repoPath, { timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = nodeSpawn } = {}) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    return { isGitRepo: false, root: null, branch: null, detachedHead: false, dirtyCount: null, hasRemote: null, repoName: null };
  }
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], repoPath, { timeoutMs, spawnImpl });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isGitRepo: false, root: null, branch: null, detachedHead: false, dirtyCount: null, hasRemote: null, repoName: null };
  }
  const [root, branchResult, status, remote] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel'], repoPath, { timeoutMs, spawnImpl }),
    runGit(['branch', '--show-current'], repoPath, { timeoutMs, spawnImpl }),
    runGit(['status', '--porcelain'], repoPath, { timeoutMs, spawnImpl }),
    runGit(['remote'], repoPath, { timeoutMs, spawnImpl }),
  ]);
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  const dirtyCount = status.ok ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length : null;
  const hasRemote = remote.ok ? remote.stdout.trim().length > 0 : null;
  const rootPath = root.ok ? root.stdout.trim() : null;
  return {
    isGitRepo: true,
    root: rootPath,
    branch: branch || null,
    detachedHead: branch === '',
    dirtyCount,
    hasRemote,
    repoName: rootPath ? basename(rootPath) : null,
  };
}
