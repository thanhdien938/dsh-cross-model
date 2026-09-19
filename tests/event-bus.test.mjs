import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus/event-bus.mjs';

test('event bus: emit is synchronous and ordered', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('a', () => seen.push('a1'));
  bus.on('a', () => seen.push('a2'));
  bus.on('b', () => seen.push('b1'));
  bus.emit('a', {});
  bus.emit('b', {});
  assert.deepEqual(seen, ['a1', 'a2', 'b1']);
});

test('event bus: off and once work', () => {
  const bus = new EventBus();
  let count = 0;
  const handler = () => count += 1;
  bus.on('x', handler);
  bus.emit('x');
  bus.off('x', handler);
  bus.emit('x');
  let once = 0;
  bus.once('y', () => once += 1);
  bus.emit('y');
  bus.emit('y');
  assert.equal(count, 1);
  assert.equal(once, 1);
});

test('event bus: faulty listener does not corrupt state or stop others', () => {
  const failures = [];
  const bus = new EventBus({ onListenerError: (error, event) => failures.push(`${event}:${error.message}`) });
  const seen = [];
  bus.on('x', () => { throw new Error('listener boom'); });
  bus.on('x', () => seen.push('ok'));
  bus.emit('x', {});
  assert.deepEqual(seen, ['ok']);
  assert.equal(failures.length, 1);
});

test('event bus: wildcard/all subscription receives every event', () => {
  const bus = new EventBus();
  const events = [];
  bus.all((event) => events.push(event));
  bus.emit('task.created', {});
  bus.emit('agent.completed', {});
  assert.deepEqual(events, ['task.created', 'agent.completed']);
});
