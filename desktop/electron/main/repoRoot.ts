import path from 'path';
import fs from 'fs';

// M01: a packaged, double-clicked Desktop install has no shell environment
// to supply DSH_REPO_ROOT — the prior W1/W2/W3 waves assumed one always
// existed (an env var, or a source checkout where the compiled output sits
// at a fixed relative depth under the real monorepo root) and had no
// bootstrap path when neither was true. Resolution precedence is now
// deliberate and explicit, in this exact order:
//   1. explicit DSH_REPO_ROOT env override (still validated, never trusted
//      blindly — "reject invalid folder" applies uniformly);
//   2. a persisted Desktop setting (chosen once through the first-run
//      native folder picker, stored outside the repo — see
//      desktopSettingsStore.ts);
//   3. the development-only deterministic fallback (this compiled file's
//      own location under a source checkout);
//   4. otherwise: FIRST-RUN REQUIRED — main.ts must not silently treat
//      packaged resources as a production repo root.

export const DEV_FALLBACK_REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

export type RepoRootSource = 'env' | 'setting' | 'dev-fallback';

export interface RepoRootResolution {
  root: string | null;
  source: RepoRootSource | null;
  requiresFirstRun: boolean;
}

// A real DSH checkout root, at minimum, has the runtime entry point, the
// src/ tree, and a package.json. This is deliberately narrow — it is not a
// full repo-identity check, only enough to reject an obviously wrong
// folder (e.g. the packaged app's own resources directory) before it is
// ever used to resolve scripts/config/dynamic ESM imports.
export function isValidDshRepoRoot(candidate: string): boolean {
  try {
    const hasRuntimeScript = fs.existsSync(path.join(candidate, 'scripts', 'p5-runtime.mjs'));
    const hasSrcDir = fs.statSync(path.join(candidate, 'src')).isDirectory();
    const hasPackageJson = fs.existsSync(path.join(candidate, 'package.json'));
    return hasRuntimeScript && hasSrcDir && hasPackageJson;
  } catch {
    return false;
  }
}

export function resolveRepoRoot(persistedRoot: string | null): RepoRootResolution {
  if (process.env.DSH_REPO_ROOT) {
    const candidate = path.resolve(process.env.DSH_REPO_ROOT);
    if (isValidDshRepoRoot(candidate)) return { root: candidate, source: 'env', requiresFirstRun: false };
  }
  if (persistedRoot) {
    const candidate = path.resolve(persistedRoot);
    if (isValidDshRepoRoot(candidate)) return { root: candidate, source: 'setting', requiresFirstRun: false };
  }
  if (isValidDshRepoRoot(DEV_FALLBACK_REPO_ROOT)) return { root: DEV_FALLBACK_REPO_ROOT, source: 'dev-fallback', requiresFirstRun: false };
  return { root: null, source: null, requiresFirstRun: true };
}

// Resolved once at startup (main.ts, after loading persisted settings) and
// read by every other module that needs an absolute path into the DSH
// source tree (login terminal binary resolvers, the dynamic ESM import
// helper, readProjection's sanitizer import). A plain mutable module-level
// value — not a class/singleton — since Electron main is itself a
// singleton process and every consumer already imports this exact module.
let resolvedRoot: string | null = null;

export function setResolvedRepoRoot(root: string | null): void {
  resolvedRoot = root;
}

// Throws rather than silently falling back to a guessed path — every
// caller of this function only runs after main.ts has confirmed a repo
// root is configured (first-run gating happens before any of them can be
// reached), so a null value here would itself be a real bug to surface
// loudly, not paper over.
export function getRepoRoot(): string {
  if (!resolvedRoot) throw new Error('DSH repo root is not configured. First-run bootstrap must complete before this is called.');
  return resolvedRoot;
}
