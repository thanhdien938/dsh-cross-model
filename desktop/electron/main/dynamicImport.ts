import { pathToFileURL } from 'url';

// TypeScript's CommonJS module emit (tsconfig.electron.json: module:
// CommonJS, which this whole Electron main process compiles to) downlevels
// a literal `await import(...)` expression into
// `Promise.resolve().then(() => require(...))` — a *synchronous* CJS
// require wrapped to look async, not a real dynamic import. That cannot
// load the handful of pure-ESM (.mjs) modules this process needs to reuse
// from the root workspace's src/ tree (the production execution-failure
// classifier, PM backend registry, session-bridge binary resolvers, and
// operator-output sanitizer) and throws ERR_REQUIRE_ESM at actual runtime
// — a failure `tsc --noEmit` type-checking does not surface, since it only
// checks types, not the emitted require() rewrite.
//
// `new Function` constructs the import() call from a string, which the
// TypeScript compiler cannot see (and therefore cannot rewrite) as an
// import expression, so it survives as Node's real, ESM-capable dynamic
// import at runtime. Always pass an absolute path (via REPO_ROOT, see
// repoRoot.ts) converted to a file:// URL — dynamic import's relative-
// specifier resolution is referrer-based and not reliably defined for
// code constructed this way, so relying on a relative specifier here
// would reintroduce the exact class of bug this file exists to avoid.
const realDynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

export function importEsmModule<T = any>(absolutePath: string): Promise<T> {
  return realDynamicImport(pathToFileURL(absolutePath).href);
}
