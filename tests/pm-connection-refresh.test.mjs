import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

// P6-W3-R4.1/P6.5 Part R41-3/R41-4/R41-5: registry-level proof for true
// per-backend refresh, unknown-product fail-closed, timeout safety, and
// the static-fact cache — all driven by an injected connectionProbe/
// installedProbe so this suite is deterministic, fast, and never touches
// real CLIs or spawns a real child process (capabilities()/capability()
// are now async — see docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md).

const alwaysInstalled = async () => ({ installed: true, version: '1.0.0' });

function registryWithProbeCalls({ connectionProbe } = {}) {
  const calls = [];
  const registry = new ProductionPmBackendRegistry({
    installedProbe: alwaysInstalled,
    claudeBinary: 'claude',
    openCodeBinary: 'opencode',
    codexBinary: 'codex',
    grokBinary: 'grok',
    antigravityBinary: 'agy',
    connectionProbe: connectionProbe ?? (async (product, binary, opts) => {
      calls.push({ product, mode: opts?.mode ?? 'full' });
      return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } };
    }),
  });
  return { registry, calls };
}

test('R41-3: capability(product) probes exactly that one product, never the other three', async () => {
  const { registry, calls } = registryWithProbeCalls();
  await registry.capability('codex');
  assert.deepEqual(calls.map((c) => c.product), ['codex']);
});

test('R41-3: capability("grok") only probes grok', async () => {
  const { registry, calls } = registryWithProbeCalls();
  await registry.capability('grok');
  assert.deepEqual(calls.map((c) => c.product), ['grok']);
});

test('R41-3: capabilities() probes exactly all five products, once each', async () => {
  const { registry, calls } = registryWithProbeCalls();
  await registry.capabilities();
  assert.deepEqual(calls.map((c) => c.product).sort(), ['antigravity', 'claude-code', 'codex', 'grok', 'opencode'].sort());
});

test('R41-3: unknown product fails closed — no probe attempted, typed UNSUPPORTED/UNKNOWN shape', async () => {
  const { registry, calls } = registryWithProbeCalls();
  const result = await registry.capability('not-a-real-product');
  assert.equal(calls.length, 0);
  assert.equal(result.authProbe, 'UNSUPPORTED');
  assert.equal(result.authState, 'UNKNOWN');
  assert.equal(result.product, 'not-a-real-product');
});

test("R41-5: mode:'auto' reuses the static-fact cache instead of re-probing model discovery", async () => {
  let calls = 0;
  const { registry } = registryWithProbeCalls({
    connectionProbe: async (product, binary, opts) => {
      calls += 1;
      if (opts?.mode === 'full') {
        return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: 'grok-4.6', modelDiscovery: { supported: true, models: ['grok-4.6', 'grok-4.5'], source: 'grok models' } };
      }
      // 'auto' mode: the real probe module returns no fresh model info.
      return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'unavailable' } };
    },
  });
  const full = await registry.capability('grok', { mode: 'full' });
  assert.deepEqual(full.modelDiscovery.models, ['grok-4.6', 'grok-4.5']);
  assert.equal(full.nativeDefaultModel, 'grok-4.6');

  const auto = await registry.capability('grok', { mode: 'auto' });
  // The cached static facts survive into the 'auto' result even though
  // the fresh probe itself returned nothing for them this time.
  assert.deepEqual(auto.modelDiscovery.models, ['grok-4.6', 'grok-4.5']);
  assert.equal(auto.nativeDefaultModel, 'grok-4.6');
  assert.equal(calls, 2);
});

test("R41-5/P6.5: mode:'auto' skips re-probing cliInstalled/cliVersion once cached (manual mode:'full' still re-checks)", async () => {
  let installedProbeCalls = 0;
  const registry = new ProductionPmBackendRegistry({
    installedProbe: async () => { installedProbeCalls += 1; return { installed: true, version: '1.0.0' }; },
    claudeBinary: 'claude',
    openCodeBinary: 'opencode',
    codexBinary: 'codex',
    grokBinary: 'grok',
    antigravityBinary: 'agy',
    connectionProbe: async () => ({ authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } }),
  });
  await registry.capability('grok', { mode: 'full' });
  const afterFull = installedProbeCalls;
  await registry.capability('grok', { mode: 'auto' });
  assert.equal(installedProbeCalls, afterFull); // no new install/version probe on 'auto'
  await registry.capability('grok', { mode: 'full' });
  assert.ok(installedProbeCalls > afterFull); // a manual 'full' re-checks
});

test('R41-4: a probe that always times out degrades that one backend to UNKNOWN, never throws', async () => {
  const { registry } = registryWithProbeCalls({
    connectionProbe: async () => ({ authProbe: 'SUPPORTED', authState: 'UNKNOWN', authDetail: 'auth probe timed out', nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'unavailable' } }),
  });
  const result = await registry.capability('codex');
  assert.equal(result.authState, 'UNKNOWN');
  assert.match(result.authDetail, /timed out/);
});

test('R41-4/R41-9(9): one backend erroring does not block or corrupt any other backend in the same capabilities() call', async () => {
  const registry = new ProductionPmBackendRegistry({
    installedProbe: alwaysInstalled,
    claudeBinary: 'claude',
    openCodeBinary: 'opencode',
    codexBinary: 'codex',
    grokBinary: 'grok',
    antigravityBinary: 'agy',
    connectionProbe: (product) => {
      if (product === 'codex') throw new Error('codex probe hung/crashed');
      return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } };
    },
  });
  const list = await registry.capabilities();
  const byProduct = Object.fromEntries(list.map((c) => [c.product, c]));
  assert.equal(byProduct.codex.authState, 'ERROR');
  assert.equal(byProduct['claude-code'].authState, 'LOGGED_IN');
  assert.equal(byProduct.opencode.authState, 'LOGGED_IN');
  assert.equal(byProduct.grok.authState, 'LOGGED_IN');
  assert.equal(byProduct.antigravity.authState, 'LOGGED_IN');
});

test('R41-9(17): existing auth/model/reasoning semantics are preserved by the mode-aware capability builder', async () => {
  const { registry } = registryWithProbeCalls({
    connectionProbe: async (product, binary, opts) => ({ authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: 'ok', nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' }, __mode: opts?.mode }),
  });
  const claude = await registry.capability('claude-code');
  assert.equal(claude.reasoning.selection, 'SUPPORTED');
  assert.deepEqual(claude.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(claude.authState, 'LOGGED_IN');
  assert.equal('authReady' in claude, false);
});

// P6.5 Part L/Q: capabilities() now probes all five backends in parallel
// (Promise.all) rather than sequentially — this proves it directly, not
// just that the five calls happen (already proven above).
test('P6.5: capabilities() probes all five backends concurrently, not sequentially', async () => {
  const order = [];
  const { registry } = registryWithProbeCalls({
    connectionProbe: async (product) => {
      order.push(`${product}:start`);
      await new Promise((resolve) => setTimeout(resolve, product === 'grok' ? 30 : 5));
      order.push(`${product}:end`);
      return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } };
    },
  });
  await registry.capabilities();
  // All five starts happen before grok (the slowest) ends — proof they
  // ran concurrently rather than one-at-a-time.
  const grokEndIndex = order.indexOf('grok:end');
  const starts = order.filter((e) => e.endsWith(':start'));
  assert.equal(starts.length, 5);
  assert.ok(starts.every((s) => order.indexOf(s) < grokEndIndex));
});
