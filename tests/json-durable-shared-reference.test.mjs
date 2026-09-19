import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeDurable } from '../src/persistence/repositories/json-durable.mjs';
import { dataShapeSummary } from '../src/pm/council/council-step-workflow-runner.mjs';

test('durable JSON duplicates shared sibling records and arrays faithfully', () => {
  const child = { count: 2, values: [null, true, 'safe'] };
  const value = { a: child, b: child, c: child.values };
  assert.equal(serializeDurable(value), JSON.stringify(value));
});

test('durable JSON accepts normal content-free data diagnostics', () => {
  const data = dataShapeSummary({ type: 'council_report', analysis: 'private sentinel' });
  const json = serializeDurable({ data_diagnostics: data });
  assert.ok(!json.includes('private sentinel'));
  assert.deepEqual(JSON.parse(json).data_diagnostics, data);
});

for (const kind of ['self', 'mutual', 'array', 'shared-then-cycle']) {
  test(`durable JSON still rejects ${kind} cycles at the back-edge`, () => {
    const a = {}; const b = { a }; const shared = {};
    let root; let path;
    if (kind === 'self') { a.self = a; root = a; path = '$.self'; }
    if (kind === 'mutual') { a.b = b; root = a; path = '$.b.a'; }
    if (kind === 'array') { root = []; root.push(root); path = '$[0]'; }
    if (kind === 'shared-then-cycle') { root = { x: shared, y: shared, a }; a.self = a; path = '$.a.self'; }
    assert.throws(() => serializeDurable(root), (e) => e.code === 'NOT_JSON_FAITHFUL' && e.message.includes(`at ${path}: cyclic reference`));
  });
}

test('non-JSON values remain rejected even after a shared sibling', () => {
  for (const bad of [undefined, () => {}, Symbol('x'), 1n, NaN, Infinity, new Date(), new Map(), new Set(), new Error('x'), new AbortController().signal]) {
    const shared = {};
    assert.throws(() => serializeDurable({ a: shared, b: shared, bad }), { code: 'NOT_JSON_FAITHFUL' });
  }
});
