import { describe, it, expect, vi } from 'vitest';
import { ConnectionRefreshCoordinator } from '../src/lib/connectionRefreshCoordinator';

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// A fake "probe" that tracks how many are concurrently running, so tests
// can assert the coordinator's single-flight guarantee directly against
// the underlying work, not just against the coordinator's own bookkeeping.
function concurrencyTrackingTask(delayMs: number) {
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const task = async () => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await delay(delayMs);
    concurrent -= 1;
  };
  return { task, getCalls: () => calls, getMaxConcurrent: () => maxConcurrent };
}

describe('ConnectionRefreshCoordinator — R41-1 single-flight', () => {
  it('two simultaneous Refresh All requests collapse into one native probe set', async () => {
    const probe = concurrencyTrackingTask(30);
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: probe.task, refreshOne: async () => {} });
    await Promise.all([coordinator.refreshAll('full'), coordinator.refreshAll('full')]);
    expect(probe.getCalls()).toBe(1);
    expect(probe.getMaxConcurrent()).toBe(1);
  });

  it('repeated 10 rapid Refresh-All clicks stay bounded to one in-flight probe set', async () => {
    const probe = concurrencyTrackingTask(20);
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: probe.task, refreshOne: async () => {} });
    const clicks = Array.from({ length: 10 }, () => coordinator.refreshAll('full'));
    await Promise.all(clicks);
    expect(probe.getMaxConcurrent()).toBe(1);
    expect(coordinator.getMaxObservedConcurrency()).toBe(1);
    // Requested 10 times but the real probe only ever ran once for the
    // overlapping window — the direct proof there is no probe storm.
    expect(probe.getCalls()).toBeLessThan(10);
  });

  it('a slow probe never runs concurrently with itself even under many overlapping manual requests', async () => {
    const probe = concurrencyTrackingTask(80);
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: probe.task, refreshOne: async () => {} });
    // Simulates several rapid owner clicks landing while a slow probe is
    // still in flight — every one of them must reuse it, never start a
    // second probe set.
    const first = coordinator.refreshAll('full');
    await delay(10);
    const second = coordinator.refreshAll('full');
    await delay(10);
    const third = coordinator.refreshAll('full');
    await Promise.all([first, second, third]);
    expect(probe.getCalls()).toBe(1);
    expect(probe.getMaxConcurrent()).toBe(1);
    expect(coordinator.getMaxObservedConcurrency()).toBe(1);
  });
});

// P6-W3-R4.2 Part R42-2/R42-10: periodic background polling caused visible
// packaged-app sluggishness even after R4.1's single-flight fix reduced
// its severity — the owner's product decision was to remove it entirely.
// This coordinator has no scheduling capability left at all: no timer, no
// recurring loop, no startAutoRefresh()/stop(). These tests are the
// direct regression guard against that silently regrowing.
describe('ConnectionRefreshCoordinator — R42-2 no periodic scheduler', () => {
  it('exposes no scheduling API', () => {
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => {}, refreshOne: async () => {} });
    expect(typeof (coordinator as any).startAutoRefresh).toBe('undefined');
    expect(typeof (coordinator as any).stop).toBe('undefined');
    expect(typeof (coordinator as any).stopAutoRefresh).toBe('undefined');
  });

  it('one refreshAll() call, then advancing fake timers by 5 minutes and 1 hour, triggers zero additional refreshes', () => {
    vi.useFakeTimers();
    const probe = concurrencyTrackingTask(0);
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: probe.task, refreshOne: async () => {} });
    void coordinator.refreshAll('full');
    expect(probe.getCalls()).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(probe.getCalls()).toBe(1);
    vi.advanceTimersByTime(60 * 60_000);
    expect(probe.getCalls()).toBe(1);
    vi.useRealTimers();
  });

  it('never schedules a setTimeout/setInterval internally', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => {}, refreshOne: async () => {} });
    void coordinator.refreshAll('full');
    void coordinator.refreshOne('grok', 'full');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });
});

describe('ConnectionRefreshCoordinator — R41-3 true per-backend refresh', () => {
  it('refreshing one product never invokes refreshAll or another product', async () => {
    const calls: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({
      refreshAll: async () => { calls.push('ALL'); },
      refreshOne: async (product) => { calls.push(product); await delay(10); },
    });
    await coordinator.refreshOne('claude-code', 'full');
    expect(calls).toEqual(['claude-code']);
  });

  it('Grok per-card refresh only probes Grok', async () => {
    const calls: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => { calls.push('ALL'); }, refreshOne: async (product) => { calls.push(product); } });
    await coordinator.refreshOne('grok', 'full');
    expect(calls).toEqual(['grok']);
  });

  it('Refresh All probes exactly once via refreshAll, not per-product', async () => {
    const calls: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => { calls.push('ALL'); }, refreshOne: async (product) => { calls.push(product); } });
    await coordinator.refreshAll('full');
    expect(calls).toEqual(['ALL']);
  });

  it('two different products refresh independently and concurrently (no cross-product blocking)', async () => {
    const order: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({
      refreshAll: async () => {},
      refreshOne: async (product) => {
        order.push(`${product}:start`);
        await delay(product === 'codex' ? 30 : 10);
        order.push(`${product}:end`);
      },
    });
    await Promise.all([coordinator.refreshOne('codex', 'full'), coordinator.refreshOne('grok', 'full')]);
    // grok (10ms) finishes before codex (30ms) despite starting after —
    // proof they ran concurrently, not serialized behind each other.
    expect(order.indexOf('grok:end')).toBeLessThan(order.indexOf('codex:end'));
  });
});

describe('ConnectionRefreshCoordinator — R41-6 busy state', () => {
  it('busy state clears after success', async () => {
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => {}, refreshOne: async () => {} });
    await coordinator.refreshAll('full');
    expect(coordinator.isBusy('ALL')).toBe(false);
  });

  it('busy state clears after failure — never a permanent "Refreshing…"', async () => {
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => { throw new Error('boom'); }, refreshOne: async () => {} });
    await expect(coordinator.refreshAll('full')).rejects.toThrow('boom');
    expect(coordinator.isBusy('ALL')).toBe(false);
  });

  it('only the requested key is busy — Refresh All does not mark a single product busy and vice versa', async () => {
    const seenBusy: Set<string>[] = [];
    const coordinator = new ConnectionRefreshCoordinator({
      refreshAll: async () => { await delay(20); },
      refreshOne: async () => { await delay(20); },
      onBusyChange: (keys) => seenBusy.push(new Set(keys)),
    });
    await coordinator.refreshOne('opencode', 'full');
    expect(seenBusy.some((s) => s.has('opencode') && !s.has('ALL'))).toBe(true);
    expect(seenBusy.every((s) => !s.has('claude-code') && !s.has('codex') && !s.has('grok'))).toBe(true);
  });
});

describe('ConnectionRefreshCoordinator — login/profile scoping (R41-7)', () => {
  it('a login-success refresh for one product never triggers a full refresh', async () => {
    const calls: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => { calls.push('ALL'); }, refreshOne: async (p) => { calls.push(p); } });
    // Simulates App.tsx's connections:changed handler for a scoped
    // Login/Logout event: exactly one refreshOne call, no refreshAll.
    await coordinator.refreshOne('claude-code', 'full');
    expect(calls).toEqual(['claude-code']);
  });

  it('a logout-success refresh for one product never triggers a full refresh', async () => {
    const calls: string[] = [];
    const coordinator = new ConnectionRefreshCoordinator({ refreshAll: async () => { calls.push('ALL'); }, refreshOne: async (p) => { calls.push(p); } });
    await coordinator.refreshOne('grok', 'full');
    expect(calls).toEqual(['grok']);
  });
});
