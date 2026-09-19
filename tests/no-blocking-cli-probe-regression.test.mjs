import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// P6.5 Part B/C/Q(6,16): source-policy regression guard. These are the
// exact files docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md's audit found
// blocking Electron's main event loop (Connection Center's native CLI
// probing) and converted to async. This test exists so a future edit
// can't silently reintroduce a synchronous spawnSync/execSync into any
// of them without a test failing here first.

function read(relPath) {
  return fs.readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8');
}

test('pm-connection-probe.mjs contains no spawnSync/execSync — every CLI probe is async', () => {
  const source = read('src/pm/pm-connection-probe.mjs');
  assert.doesNotMatch(source, /\bspawnSync\s*\(/);
  assert.doesNotMatch(source, /\bexecSync\s*\(/);
});

test('binary-resolution-async.mjs contains no spawnSync/execSync', () => {
  const source = read('src/session/binary-resolution-async.mjs');
  assert.doesNotMatch(source, /\bspawnSync\s*\(/);
  assert.doesNotMatch(source, /\bexecSync\s*\(/);
});

test('production-pm-backend-registry.mjs: the only remaining spawnSync call site is the documented probeBinary() — used only by inspect()/resolve() in the separate runtime child process, never by capabilities()/capability()', () => {
  const source = read('src/pm/production-pm-backend-registry.mjs');
  const spawnSyncCallSites = [...source.matchAll(/\bspawnSync\s*\(/g)];
  assert.equal(spawnSyncCallSites.length, 1, `expected exactly one spawnSync call site (probeBinary), found ${spawnSyncCallSites.length}`);
  const probeBinaryIndex = source.indexOf('function probeBinary(');
  const spawnSyncIndex = source.indexOf('spawnSync(');
  assert.ok(probeBinaryIndex >= 0, 'probeBinary() must still exist');
  assert.ok(spawnSyncIndex > probeBinaryIndex, 'the one remaining spawnSync call must live inside probeBinary()');
  // capabilities()/capability() must never call probeBinary/safeProbe.
  const capabilitiesBlock = source.match(/async capabilities\([\s\S]*?(?=\n  async capability\()/)?.[0] ?? '';
  const capabilityBlock = source.match(/async capability\(product[\s\S]*?(?=\n  async #buildCapability)/)?.[0] ?? '';
  const buildCapabilityBlock = source.match(/async #buildCapability\([\s\S]*?\n  \}/)?.[0] ?? '';
  for (const block of [capabilitiesBlock, capabilityBlock, buildCapabilityBlock]) {
    assert.doesNotMatch(block, /\bsafeProbe\s*\(/);
    assert.doesNotMatch(block, /\bprobeVersion\s*\(/);
  }
});

test('production-pm-backend-registry.mjs: capabilities()/capability() are async methods returning Promises', () => {
  const source = read('src/pm/production-pm-backend-registry.mjs');
  assert.match(source, /async capabilities\(/);
  assert.match(source, /async capability\(/);
});

test("desktop main.ts's getPmBackendRegistry resolves binaries via the async resolvers, never the synchronous eager constructor defaults", () => {
  const source = read('desktop/electron/main/main.ts');
  const fnBlock = source.match(/async function getPmBackendRegistry\(\)[\s\S]*$/)?.[0] ?? '';
  assert.match(fnBlock, /resolveClaudeBinaryAsync/);
  assert.match(fnBlock, /resolveOpenCodeBinaryAsync/);
  assert.match(fnBlock, /resolveCodexCliBinaryAsync/);
  assert.match(fnBlock, /resolveGrokBinaryAsync/);
  // Must construct with explicit binaries — never rely on the
  // registry's own synchronous default-resolution constructor params.
  assert.match(fnBlock, /new ProductionPmBackendRegistry\(\{\s*claudeBinary/);
});

test("desktop's loginTerminalService.ts resolves binaries via the async resolvers, never the synchronous ones", () => {
  const source = read('desktop/electron/main/services/loginTerminalService.ts');
  const productsBlock = source.match(/const PRODUCTS: Record<LoginTerminalProduct, ProductCommand> = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.match(productsBlock, /resolveClaudeBinaryAsync/);
  assert.match(productsBlock, /resolveOpenCodeBinaryAsync/);
  assert.match(productsBlock, /resolveCodexCliBinaryAsync/);
  assert.match(productsBlock, /resolveGrokBinaryAsync/);
  assert.doesNotMatch(productsBlock, /\)\.resolveClaudeBinary\(\)/);
  assert.doesNotMatch(productsBlock, /\)\.resolveOpenCodeBinary\(\)/);
  assert.doesNotMatch(productsBlock, /\)\.resolveCodexCliBinary\(\)/);
  assert.doesNotMatch(productsBlock, /\)\.resolveGrokBinary\(\)/);
});

test('BackendExecutionLogs.tsx no longer polls backends.capabilities() (a real CLI probe) on a timer just for the static product list', () => {
  const source = read('desktop/src/components/BackendExecutionLogs.tsx');
  assert.doesNotMatch(source, /setInterval\([^)]*[Cc]apabilit/);
  assert.match(source, /window\.desktop\.backends\.products\(\)/);
});
