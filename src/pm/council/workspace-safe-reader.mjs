/**
 * Council/Debate WORKSPACE_READ remediation — the ONE safe, bounded,
 * read-only, project-root-confined filesystem primitive used by
 * workspace-evidence-packet.mjs (packet construction) and
 * workspace-evidence-contract.mjs (participant-cited evidence hash
 * verification). See docs/evidence/DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_
 * 20260906.md §16 for the minimum safety bar this module exists to meet.
 *
 * Hard safety invariants (never relaxed by a caller):
 *  - every path is resolved against, and MUST remain under, the project
 *    root — `..`, an absolute path, a drive-letter path, or a symlink/
 *    junction that resolves outside the root are all refused;
 *  - read-only: this module has no write/mkdir/rm/rename export, ever;
 *  - deny-listed paths (secrets/credentials/tokens/session state) are
 *    refused before any read;
 *  - every read/list is bounded: byte size, entry count, and recursion
 *    depth are all explicit, caller-overridable-only-downward constants;
 *  - zero shell/process spawning — plain node:fs calls only.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Final owner-review micro-patch, Blocker B: the real, bounded fs primitive
// set readFileBounded() uses — a DI seam ONLY so a test can prove the bound
// is enforced BEFORE any read happens (a stubbed statSync reporting a huge
// fake size, with a spy readSync asserting it is never asked to read more
// than maxBytes) without needing a real multi-GB fixture. Every production
// call site uses the real node:fs defaults below, unchanged.
const REAL_FS_IMPL = Object.freeze({ statSync, openSync, readSync, closeSync });

export class WorkspaceSafeReadError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WorkspaceSafeReadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- Explicit, documented bounds (Part 16/19 — every bound is a named,
// exported constant, never a magic number a caller has to rediscover). ----
export const MAX_LIST_ENTRIES = 500;
export const MAX_LIST_DEPTH = 4;
export const MAX_FILE_BYTES = 200_000; // per-file read ceiling (full-file hash still computed up to this ceiling)
// Final stabilization patch (§3-6 of the brief): MAX_EXCERPT_CHARS is now the
// per-CHUNK bound, not a hard "only the first N chars are ever visible"
// ceiling — the OLD defect. The full bounded, redacted text is now split
// into as many deterministic chunks as needed (bounded by
// MAX_CHUNKS_PER_FILE) instead of being truncated to one chunk. Kept under
// its original name (no export removed) since nothing outside this module
// ever imported it — see readFileBounded()'s docstring for the full
// before/after contract.
export const MAX_EXCERPT_CHARS = 4000;
// ceil(MAX_FILE_BYTES / MAX_EXCERPT_CHARS) = ceil(200_000 / 4_000) = 50 —
// chosen so a file at the MAX_FILE_BYTES ceiling can still have EVERY one
// of its bounded chars represented as a chunk (never silently cut short by
// the chunk-count bound alone; only MAX_FILE_BYTES itself ever bounds
// visibility for a file that large).
export const MAX_CHUNKS_PER_FILE = 50;
export const MAX_TOTAL_PACKET_BYTES = 1_000_000;

// Directories never descended into for a directory listing — noise, VCS
// internals, or dependency trees, never "secret" per se, but excluded so a
// bounded listing stays signal, not fill. (Deny-listed PATHS below are the
// actual secret/credential boundary.)
const EXCLUDED_LIST_DIRS = new Set(['.git', 'node_modules', '.tools']);

// Deny-listed path fragments (case-insensitive), matched against the
// project-relative POSIX-style path. Refuses the read/list of anything
// matching before touching the filesystem for that entry. Intentionally
// broad and conservative — a false positive here only means "DSH declines
// to read this one file", never a security gap.
const DENY_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.codex(-dsh)?(\/|$)/i,
  /credentials?\.(json|ya?ml|txt)$/i,
  /secrets?\.(json|ya?ml|env|txt)$/i,
  /\.(pem|pfx|p12|key)$/i,
  /(^|\/)\.dsh-runtime\.lock$/i,
  /(^|\/)\.runtime(\/|$)/i,
];

function toPosix(p) { return p.split(sep).join('/'); }

function isDenied(relPosixPath) {
  return DENY_PATTERNS.some((re) => re.test(relPosixPath));
}

// Final owner-review micro-patch, Blocker C ("secret-path/content deny" was
// only ever a PATH boundary — an ALLOWED file, e.g. `src/config.mjs`, can
// still contain secret-shaped CONTENT). This is the ONE canonical secret-
// CONTENT redaction authority for a workspace evidence excerpt, alongside
// DENY_PATTERNS (the path authority) in the same module, so a caller never
// has to reach for two different secret policies.
//
// Same token-shape family already established at
// src/pm/council/workspace-evidence-contract.mjs's (pre-patch)
// SECRET_PATTERN and src/runtime/repo-history-content.mjs's redactSecrets()
// — reused here as the ONE copy those callers now delegate to (never a
// third, diverging regex family). repo-history-content.mjs's own copy is
// left untouched (out of this micro-patch's scope; that module's
// bound()/truncation semantics are tuned for a different caller, per its
// own file-header comment) but is textually identical, so a future
// consolidation there is a pure no-op rename.
const TOKEN_SHAPE_SECRET_RE = /\b(?:sk|xai|ghp|github_pat|Bearer)[-_A-Za-z0-9.]{8,}\b/gi;

// Final security edge-case patch, Gap A: the token-shape pattern above only
// ever matched "Bearer" CONCATENATED directly onto a token (no whitespace)
// — real HTTP `Authorization: Bearer <token>` headers/config always have a
// space (or other whitespace) between the scheme and the credential, which
// that pattern never matched at all. This is a SEPARATE pattern, not a
// widened version of the one above (keeping the old one too costs nothing
// and still catches the rare no-space variant). Case-insensitive (matches
// `bearer`/`BEARER` too — test matrix #3). Captures the keyword and the
// whitespace separately so the replacement preserves them EXACTLY
// (original case, original whitespace) and only replaces the credential
// itself — "Preserve harmless surrounding text where practical."
//
// Deliberately does not try to distinguish "looks like a real token" from
// "happens to be an 8+ char word" beyond requiring the `Bearer` keyword
// itself immediately before it: `Bearer <credential>` is already a rare,
// specific, HTTP-auth-scoped signal in real source/config text. A false
// positive here (an ordinary word after the literal word "Bearer") is
// always the SAFE failure mode — an occasional harmless token-shaped word
// gets redacted — never the dangerous one (a real credential leaking
// through). Genuinely harmless prose ("the bearer of this note") almost
// never has an 8+ char token-shaped word immediately after "bearer" with
// only whitespace between, so this stays conservative in practice.
const BEARER_TOKEN_RE = /\b(Bearer)(\s+)([A-Za-z0-9\-_.+/=]{8,})\b/gi;

// Assignment-shape secrets (owner-review §4: "API_KEY=...", "TOKEN=...",
// "PASSWORD=...", "SECRET=..."): a KEY whose NAME is secret-shaped,
// assigned a value via `=` or `:`, optionally quoted. Redacts the VALUE
// only, preserving the key name/operator/quote style so the excerpt stays
// readable ("apiKey = "[REDACTED]"" rather than deleting the whole line).
// Conservative and bounded (a value must be at least 4 non-quote/space/
// comma chars to redact) — this is not a general secret-scanning product,
// only the minimum assignment shape the owner-review brief names.
const ASSIGNMENT_SECRET_RE = /\b((?:api[-_]?key|secret|token|password|passwd|access[-_]?key|private[-_]?key)\w*)(\s*[:=]\s*)(['"]?)([^\s'",;]{4,})\3/gi;

/**
 * Redact secret-shaped CONTENT (never a path — see DENY_PATTERNS for that
 * boundary) from a bounded text excerpt before it is ever rendered into an
 * evidence packet or persisted. Applied to the bytes already safely read
 * (readFileBounded()) — never changes what was hashed (§ Blocker C:
 * "sha256 represents the bytes actually supplied/read... redaction happens
 * only at the DISPLAY layer, after hashing").
 */
export function redactWorkspaceEvidenceContent(text) {
  const value = String(text ?? '');
  return value
    .replace(TOKEN_SHAPE_SECRET_RE, '[REDACTED]')
    .replace(BEARER_TOKEN_RE, (match, keyword, whitespace) => `${keyword}${whitespace}[REDACTED]`)
    .replace(ASSIGNMENT_SECRET_RE, (match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`);
}

/**
 * Final stabilization patch (§4/§5 of the brief) — deterministic bounded
 * chunking of an ALREADY-REDACTED text string. Called AFTER
 * redactWorkspaceEvidenceContent(), never before (§4: "Redacting BEFORE
 * chunking prevents a secret from escaping detection by being split across
 * a chunk boundary" — a secret spanning what would otherwise be a chunk
 * boundary is redacted as one contiguous match against the FULL text, long
 * before any split point exists).
 *
 * Surrogate-pair safe: a chunk boundary is never placed between a UTF-16
 * high surrogate and its low surrogate (e.g. inside an emoji) — the split
 * point backs off by one code unit rather than producing two chunks that,
 * concatenated with anything else, could contain an unpaired surrogate.
 * Never re-decodes bytes — operates purely on the JS string produced once
 * by readFileBounded()'s single `Buffer.toString('utf8')` call, so a
 * multi-byte UTF-8 sequence is never split at the chunk level (only,
 * unavoidably, at the raw MAX_FILE_BYTES read boundary itself, exactly as
 * before this patch — Node's own UTF-8 decoder handles that boundary by
 * substituting U+FFFD for an incomplete trailing sequence, never throwing
 * or corrupting the rest of the string).
 *
 * @returns {{ chunks: Array<{index:number, count:number, char_start:number, char_end:number, text:string}>, chunkLimited: boolean }}
 *   `chunkLimited` is true only if `text.length` needed more than
 *   `maxChunks` chunks to represent in full — given MAX_CHUNKS_PER_FILE's
 *   own sizing (see its definition), this should never happen for a file
 *   at or under MAX_FILE_BYTES in practice, but is handled honestly
 *   (trailing content is not chunked, `chunkLimited: true` is set) rather
 *   than assumed impossible.
 */
export function chunkText(text, { maxChunkChars = MAX_EXCERPT_CHARS, maxChunks = MAX_CHUNKS_PER_FILE } = {}) {
  const value = String(text ?? '');
  if (value.length === 0) return { chunks: [{ index: 1, count: 1, char_start: 0, char_end: 0, text: '' }], chunkLimited: false };
  const bounds = [];
  let pos = 0;
  while (pos < value.length && bounds.length < maxChunks) {
    let end = Math.min(pos + maxChunkChars, value.length);
    // Back off one code unit if `end` would split a surrogate pair.
    if (end < value.length) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
    }
    if (end <= pos) end = pos + 1; // pathological single-surrogate edge case — never loop forever
    bounds.push([pos, end]);
    pos = end;
  }
  const chunkLimited = pos < value.length;
  const count = bounds.length;
  return {
    chunks: bounds.map(([start, end], i) => ({ index: i + 1, count, char_start: start, char_end: end, text: value.slice(start, end) })),
    chunkLimited,
  };
}

/**
 * Final stabilization patch (§14 of the brief), corrected by the final
 * closure patch (Defect D) — a bounded, deterministic, conservative
 * binary-content heuristic: a NUL byte (0x00) anywhere in the bytes
 * actually read is treated as binary (real UTF-8 text never contains a
 * NUL byte; this is the same heuristic git itself uses for `is-binary`
 * detection). Never a semantic/format-aware detector — false positives
 * (an unusual-but-legitimate text file rejected) are the safe failure
 * mode, never the dangerous one (binary bytes dumped into a model prompt
 * as if they were text, which can corrupt rendering or masquerade as
 * arbitrary content).
 *
 * Defect D correction: the original implementation scanned only the
 * first ~8,192 bytes of `buffer` — but `buffer` here is ALREADY the
 * bounded read result (at most `MAX_FILE_BYTES` = 200,000 bytes, never
 * the whole underlying file), so a file whose first 8KB looked textual
 * but contained NUL bytes later in that SAME already-bounded region would
 * be misclassified as text. The scan now covers the ENTIRE `buffer`
 * passed in — still fully bounded by the caller's own `MAX_FILE_BYTES`
 * read ceiling (never the raw, potentially much larger, on-disk file),
 * so this remains a cheap, safe, single linear pass (at most 200,000
 * byte comparisons) with no new dependency and no read beyond what
 * `readFileBounded()` already performed.
 */
export function looksBinary(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Resolve `relativePath` against `repoRoot`, refusing anything that would
 * escape the project root — including via a symlink/junction whose real
 * target lies outside it (test matrix #8/#9) — and anything deny-listed
 * (test matrix #10/#11/#12).
 *
 * @returns {{ absPath: string, relPosixPath: string }}
 */
export function resolveSafeRepoPath(repoRoot, relativePath) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw new WorkspaceSafeReadError('repoRoot is required', 'WORKSPACE_READ_NO_ROOT');
  }
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new WorkspaceSafeReadError('relativePath is required', 'WORKSPACE_READ_NO_PATH');
  }
  // isAbsolute() alone is host-dependent: on a POSIX host it does not
  // recognize '\\host\share\...' (UNC) or 'C:\...' (drive-letter) syntax as
  // absolute, so those forms would otherwise fall through to be joined as a
  // literal-backslash "relative" segment instead of being refused. The
  // drive-letter regex and an explicit UNC pattern make this refusal
  // deterministic on every host, matching isUncPath() in artifact-store.mjs.
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || /^[\\/]{2}[^\\/]/.test(relativePath)) {
    throw new WorkspaceSafeReadError(`absolute paths are refused: ${relativePath}`, 'WORKSPACE_READ_PATH_ABSOLUTE', { relativePath });
  }
  const root = resolve(repoRoot);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '' ) throw new WorkspaceSafeReadError('refusing to read the project root itself as a file', 'WORKSPACE_READ_PATH_IS_ROOT', { relativePath });
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceSafeReadError(`path escapes the project root: ${relativePath}`, 'WORKSPACE_READ_PATH_ESCAPE', { relativePath });
  }
  const relPosixPath = toPosix(rel);
  if (isDenied(relPosixPath)) {
    throw new WorkspaceSafeReadError(`path is deny-listed (secret/credential-shaped): ${relPosixPath}`, 'WORKSPACE_READ_PATH_DENIED', { relativePath: relPosixPath });
  }
  // Symlink/junction escape check (Part 19 #9): resolve the REAL path (if it
  // exists) and re-verify it still lands under the root. A dangling/absent
  // path is left to the caller's own existsSync()/statSync() handling below
  // — realpathSync() would throw ENOENT for it, which is not itself an
  // escape.
  if (existsSync(candidate)) {
    let real;
    try { real = realpathSync(candidate); } catch { real = candidate; }
    const realRel = relative(root, real);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new WorkspaceSafeReadError(`path resolves outside the project root via a symlink/junction: ${relPosixPath}`, 'WORKSPACE_READ_SYMLINK_ESCAPE', { relativePath: relPosixPath });
    }
    // Final security edge-case patch, Gap B: the REAL target still lands
    // inside the project root — but an in-repo alias whose real target is
    // ITSELF deny-listed (e.g. `src/public-link -> .env`) must be refused
    // too, never treated as safe merely because the requested path string
    // did not itself match a deny pattern. Re-runs the SAME `isDenied()`
    // authority every direct path already goes through — never a second,
    // diverging deny-list. Only ever meaningful here: a directly-denied
    // `relPosixPath` already threw above, before symlink resolution was
    // even attempted, so reaching this point guarantees `relPosixPath`
    // itself was allowed — this check exists purely to catch the case
    // where the REAL target differs and IS denied.
    const realRelPosixPath = toPosix(realRel);
    if (isDenied(realRelPosixPath)) {
      throw new WorkspaceSafeReadError(
        `path resolves to a deny-listed real target via a symlink/junction: ${relPosixPath} -> ${realRelPosixPath}`,
        'WORKSPACE_READ_REALPATH_DENIED',
        { relativePath: relPosixPath, realRelativePath: realRelPosixPath },
      );
    }
  }
  return { absPath: candidate, relPosixPath };
}

/**
 * GAP: "one canonical secret/path policy" (owner-review remediation §6) —
 * the ONE boolean authority every caller that needs a non-throwing check
 * (the evidence manifest normalizer/admission gate, the evidence-packet
 * builder, the evidence-contract validator) must use instead of
 * hand-rolling its own escape/deny-list logic. Delegates to
 * resolveSafeRepoPath() — the exact same authority every throwing caller
 * already uses — so there is structurally only one deny/escape policy in
 * this codebase, never two that could drift apart.
 *
 * @returns {{ allowed: boolean, code: string|null, relPosixPath: string|null }}
 */
export function isWorkspacePathAllowed(repoRoot, relativePath) {
  try {
    const { relPosixPath } = resolveSafeRepoPath(repoRoot, relativePath);
    return Object.freeze({ allowed: true, code: null, relPosixPath });
  } catch (error) {
    if (error instanceof WorkspaceSafeReadError) return Object.freeze({ allowed: false, code: error.code, relPosixPath: null });
    throw error;
  }
}

/**
 * A deterministic, bounded, depth-limited directory listing rooted at
 * `repoRoot` (or `subdir` within it). Never follows a listing branch into
 * an excluded directory (EXCLUDED_LIST_DIRS) or a deny-listed path. Entries
 * are sorted for determinism (Part: "the SAME evidence packet ... so their
 * reasoning is independently comparable").
 */
export function listDirectoryBounded(repoRoot, {
  subdir = '.', maxEntries = MAX_LIST_ENTRIES, maxDepth = MAX_LIST_DEPTH,
} = {}) {
  const { absPath: startAbs } = subdir === '.' ? { absPath: resolve(repoRoot) } : resolveSafeRepoPath(repoRoot, subdir);
  const root = resolve(repoRoot);
  const entries = [];
  let truncated = false;
  let operations = 0;
  const MAX_OPERATIONS = maxEntries * 4 + 200; // bounded work even across many small directories

  function walk(dirAbs, depth) {
    if (entries.length >= maxEntries || truncated) { truncated = entries.length >= maxEntries; return; }
    if (depth > maxDepth) return;
    let names;
    try { names = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      operations += 1;
      if (operations > MAX_OPERATIONS) { truncated = true; return; }
      if (entries.length >= maxEntries) { truncated = true; return; }
      const entryAbs = join(dirAbs, entry.name);
      const relPosixPath = toPosix(relative(root, entryAbs));
      // Final security edge-case patch, §4: reuse the FULL canonical
      // authority (isWorkspacePathAllowed() -> resolveSafeRepoPath()) —
      // not just the direct-path isDenied() check this used to call —
      // so a symlink/junction entry whose REAL target is deny-listed
      // (Gap B) is omitted from the listing too, never merely left
      // unreadable-but-visible. One policy authority for direct paths,
      // manifest admission, packet selection, evidence validation, AND
      // directory listing — never a second, diverging deny mechanism.
      if (!isWorkspacePathAllowed(repoRoot, relPosixPath).allowed) continue;
      const isDir = entry.isDirectory();
      if (isDir && EXCLUDED_LIST_DIRS.has(entry.name)) continue;
      let bytes = null;
      if (!isDir) {
        try { bytes = statSync(entryAbs).size; } catch { bytes = null; }
      }
      entries.push({ path: relPosixPath, type: isDir ? 'dir' : 'file', bytes });
      if (isDir) walk(entryAbs, depth + 1);
    }
  }

  walk(startAbs, 1);
  return Object.freeze({ entries: Object.freeze(entries), truncated, bounds: Object.freeze({ maxEntries, maxDepth }) });
}

/**
 * Read at most `maxBytes` of a file's REAL bytes (never partial-UTF8-
 * mangled — reads as a Buffer, decodes the full bounded text once), and
 * hash EXACTLY the bytes actually read (never an implicit hash of bytes
 * DSH never touched). Never throws for "file does not exist" — returns
 * `{ exists:false }` so a caller (evidence-hash verification) can
 * distinguish "path is safe but absent" from a genuine safety refusal
 * (which still throws WorkspaceSafeReadError).
 *
 * Final owner-review micro-patch, Blocker B (unchanged by this patch): the
 * filesystem READ ITSELF is bounded to `maxBytes` — `stat` -> compute
 * `bytesToRead = min(fullBytes, maxBytes)` -> allocate a buffer of EXACTLY
 * that size -> `openSync`/`readSync` at most that many bytes -> `closeSync`
 * (always, including on a read failure).
 *
 * Final stabilization patch (§3-6/§14 of the brief) — the OBSERVABLE
 * contract for the DISPLAY content is now different, on purpose, fixing a
 * real functional defect: the file may be safely READ and HASHED up to
 * `maxBytes` (200,000 bytes), but the OLD `excerpt` field only ever showed
 * the caller the FIRST `maxExcerptChars` (~4,000) of that bounded read —
 * "READ SUCCESS != FULL BOUNDED CONTENT VISIBILITY". A repository-audit
 * participant reasoning about a file longer than ~4,000 chars could
 * previously see only its beginning.
 *
 * Pipeline (exact, security-critical order): RAW READ -> HASH (raw bytes)
 * -> binary check -> decode -> REDACT (the FULL bounded text) -> CHUNK
 * (the already-redacted text). Redacting before chunking means a secret
 * that would otherwise straddle a chunk boundary is still matched as one
 * contiguous string, before any split point exists (Blocker, §4 of the
 * brief) — chunking is a pure, later, cosmetic split of already-safe text.
 *
 * Binary files (§14): a NUL byte anywhere in the bytes read (looksBinary())
 * is treated as binary — no chunk/excerpt content is produced (`chunks`
 * is a single explanatory placeholder chunk, `binary: true`), since
 * dumping raw/garbled bytes into a model prompt is never safe or useful.
 * `sha256`/`bytes`/`bytesRead`/`truncated` remain accurate regardless —
 * a binary file can still be safely REFERENCED (e.g. rejected explicitly
 * by admission) without its content ever being rendered.
 *
 * New fields (additive — every pre-existing field keeps its exact prior
 * meaning, `excerpt` still equals the first chunk's text for any caller
 * that only reads `.excerpt`):
 *  - `chunks`: the full ordered array of `{index, count, char_start,
 *    char_end, text}` — ALL of the bounded, redacted text, not just the
 *    first ~4,000 chars.
 *  - `chunkCount`: `chunks.length`.
 *  - `fullyVisible`: true iff the file was NOT truncated by `maxBytes` AND
 *    every chunk needed to represent the bounded text was produced (never
 *    cut short by `MAX_CHUNKS_PER_FILE`) — i.e. every byte DSH read is
 *    represented in `chunks`. Never true merely because a `.excerpt`
 *    existed, per §6 of the brief: "Do not claim full source visibility
 *    when DSH did not read the whole file."
 *  - `chunkLimited`: true only if content had to be cut short by
 *    `MAX_CHUNKS_PER_FILE` specifically (distinct from `truncated`, which
 *    is the `maxBytes` read ceiling) — see chunkText()'s own docstring for
 *    why this should not occur in practice for a file at/under
 *    `MAX_FILE_BYTES`.
 *  - `sha256_scope`: `'FULL_FILE'` when `!truncated` (the hash covers the
 *    entire real file) or `'BOUNDED_PREFIX'` when `truncated` (the hash
 *    covers only the bytes DSH actually read) — §11 of the brief: "Do not
 *    ambiguously call a bounded-prefix hash 'file sha256' if it is not the
 *    full file hash." The underlying `sha256` VALUE and its raw-bytes
 *    semantics are completely unchanged from the prior patches.
 *  - `binary`: true when the bounded bytes look binary (see looksBinary()).
 */
export function readFileBounded(repoRoot, relativePath, {
  maxBytes = MAX_FILE_BYTES, maxExcerptChars = MAX_EXCERPT_CHARS, maxChunks = MAX_CHUNKS_PER_FILE, fsImpl = REAL_FS_IMPL,
} = {}) {
  const { absPath, relPosixPath } = resolveSafeRepoPath(repoRoot, relativePath);
  let stat;
  try { stat = fsImpl.statSync(absPath); } catch { return Object.freeze({ exists: false, path: relPosixPath }); }
  if (!stat.isFile()) return Object.freeze({ exists: false, path: relPosixPath, notAFile: true });
  const fullBytes = stat.size;
  // Bounded BEFORE any read happens — never `min` applied to an
  // already-fully-read buffer.
  const bytesToRead = Math.min(fullBytes, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  let fd;
  let bytesRead = 0;
  try {
    fd = fsImpl.openSync(absPath, 'r');
    if (bytesToRead > 0) bytesRead = fsImpl.readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    // Always closed, including when readSync throws — a leaked fd is never
    // an acceptable outcome of a safety-boundary primitive.
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best-effort — never masks the real read outcome/error */ } }
  }
  const readBytes = buffer.subarray(0, bytesRead);
  // Blocker C (unchanged): sha256 is the identity of the RAW bytes actually
  // read — computed here, BEFORE any content redaction/chunking, and never
  // affected by what happens to the DISPLAY content below.
  const sha256 = createHash('sha256').update(readBytes).digest('hex');
  const truncated = bytesRead < fullBytes;
  const binary = looksBinary(readBytes);

  let chunks; let chunkLimited;
  if (binary) {
    chunks = [{ index: 1, count: 1, char_start: 0, char_end: 0, text: '(binary file — content not represented in evidence; path/hash/size are still authoritative)' }];
    chunkLimited = false;
  } else {
    // Redact the FULL bounded decoded text BEFORE chunking (§4 — see this
    // function's own docstring for the exact security rationale).
    const fullText = redactWorkspaceEvidenceContent(readBytes.toString('utf8'));
    ({ chunks, chunkLimited } = chunkText(fullText, { maxChunkChars: maxExcerptChars, maxChunks }));
  }
  const fullyVisible = !truncated && !chunkLimited && !binary;

  return Object.freeze({
    exists: true,
    path: relPosixPath,
    bytes: fullBytes,
    bytesRead,
    truncated,
    sha256,
    sha256_scope: truncated ? 'BOUNDED_PREFIX' : 'FULL_FILE',
    binary,
    chunks: Object.freeze(chunks),
    chunkCount: chunks.length,
    chunkLimited,
    fullyVisible,
    // Backward compatibility: every pre-existing caller/test that reads
    // `.excerpt` alone still gets the first chunk's text — for a file
    // whose bounded text fits in one chunk (the overwhelmingly common
    // case pre-dating this patch), this is byte-for-byte identical to the
    // old single-excerpt behavior.
    excerpt: chunks[0]?.text ?? '',
  });
}

export { EXCLUDED_LIST_DIRS, DENY_PATTERNS };
