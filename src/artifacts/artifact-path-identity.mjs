/**
 * P20.3R R8 — the ONE platform-aware path identity / containment primitive.
 *
 * Authority: docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §10/§18,
 * docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §10,
 * docs/P20/P20_3R_SONNET_REMEDIATION_MASTER_PROMPT.md §11.
 *
 * The P20.0 freeze forbids "display-string lowercasing" as the authority
 * check. This module never lowercases an arbitrary Unicode path string. It
 * delegates case/separator semantics to Node's own platform-aware
 * `path.relative` (which, on win32, already performs a correct
 * case-insensitive comparison of resolved absolute paths) and, for existing
 * paths, to `fs.realpathSync.native` (the OS canonical form). An
 * unresolvable real path fails closed.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathIdentityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'PathIdentityError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A UNC / network path (`\\server\share`, `//server/share`). */
export function isUncPath(p) {
  return /^[\\/]{2}[^\\/]/.test(String(p ?? ''));
}

/**
 * Canonical OS real path of an EXISTING path. Throws `PATH_REALPATH_FAILED`
 * (fail closed) when it cannot be resolved — never silently returns the
 * input.
 */
export function realCanonical(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch (error) {
    throw new PathIdentityError(`cannot resolve the real path of ${JSON.stringify(String(p))} (failing closed): ${error.message}`, 'PATH_REALPATH_FAILED', { path: p, cause: error.code ?? null });
  }
}

/**
 * True iff `childAbs` is `parentAbs` itself or strictly inside it. Uses
 * `path.relative` on the resolved absolutes (platform-aware: correct on
 * win32 for drive-letter case and separators) plus explicit `..` / absolute
 * rejection. No manual lowercasing.
 */
export function isWithin(parentAbs, childAbs) {
  if (typeof parentAbs !== 'string' || typeof childAbs !== 'string') return false;
  const rel = relative(resolve(parentAbs), resolve(childAbs));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  if (rel.split(sep).includes('..')) return false;
  return true;
}

/**
 * Real-filesystem containment: BOTH paths must exist; compares their OS
 * canonical real forms with `isWithin`. Catches a symlink/junction/reparse
 * escape. Fails closed if either real path cannot be resolved.
 */
export function isWithinReal(parentAbs, childAbs) {
  return isWithin(realCanonical(parentAbs), realCanonical(childAbs));
}

/**
 * LEXICAL same-path identity — compares the resolved absolutes via
 * `path.relative` (platform-aware: correct win32 case/separator handling)
 * WITHOUT calling realpath. Use this to detect a reparse point: compare a
 * lexical resolved path against its `realCanonical(...)` form; a difference
 * means the logical path went through a symlink/junction/reparse point.
 */
export function sameLexicalPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return relative(resolve(a), resolve(b)) === '';
}

/**
 * Same-path identity. When both exist, compares canonical real forms;
 * otherwise compares resolved absolutes via `path.relative`. Never
 * lowercases.
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ra = resolve(a);
  const rb = resolve(b);
  if (relative(ra, rb) === '') return true;
  try {
    return relative(realCanonical(ra), realCanonical(rb)) === '';
  } catch {
    return false;
  }
}

/**
 * Assert `reportPath` is a real regular file strictly inside `attemptDir`
 * which is strictly inside `storeRoot`, with no traversal / drive change /
 * UNC / symlink / junction / reparse escape. Returns the resolved absolute
 * path. `fail` is a caller-supplied `(code, message) => never` so each
 * caller maps to its own typed error/state family.
 */
export function assertContainedRegularFile({ storeRoot, attemptDir, reportPath, fail, lstatSync, existsSync }) {
  for (const [label, v] of [['storeRoot', storeRoot], ['attemptDir', attemptDir], ['reportPath', reportPath]]) {
    if (typeof v !== 'string' || !v) fail('PATH_INVALID', `${label} is required`);
    if (isUncPath(v)) fail('PATH_INVALID', `UNC/network path unsupported in P20 v1: ${v}`);
    if (!isAbsolute(v)) fail('PATH_INVALID', `${label} must be absolute: ${v}`);
  }
  const absReport = resolve(reportPath);
  if (absReport.split(sep).includes('..')) fail('PATH_INVALID', `report path contains a traversal segment: ${reportPath}`);
  if (!isWithin(attemptDir, absReport)) fail('OUTSIDE_WORKSPACE', `report path is outside the assigned attempt dir: ${absReport}`);
  if (!isWithin(storeRoot, attemptDir)) fail('OUTSIDE_WORKSPACE', `attempt dir is outside the trusted store root: ${attemptDir}`);
  if (!existsSync(absReport)) fail('MISSING', `expected report does not exist: ${absReport}`);

  let real;
  try { real = realCanonical(absReport); } catch (error) { fail('PATH_INVALID', error.message); }
  if (!isWithin(attemptDir, real)) fail('OUTSIDE_WORKSPACE', `report resolves outside the attempt dir via a symlink/junction: ${absReport} -> ${real}`);

  let ls;
  try { ls = lstatSync(absReport); } catch (error) { fail('UNREADABLE', `lstat failed: ${error.message}`); }
  if (ls.isSymbolicLink()) fail('OUTSIDE_WORKSPACE', `the report path is a symlink: ${absReport}`);
  if (!ls.isFile()) fail('NONREGULAR', `the report path is not a regular file: ${absReport}`);
  return absReport;
}
