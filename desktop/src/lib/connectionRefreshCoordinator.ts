// P6-W3-R4.1/R4.2 Part R41-1/R41-3/R42-1/R42-2: the one refresh coordinator
// for Connection Center's native CLI probing. Framework-free (no React
// dependency) so it is directly unit-testable and so App.tsx stays a thin
// wiring layer around it — see connectionRefreshCoordinator.test.ts.
//
// Invariants this class exists to guarantee:
//   - AT MOST ONE 'ALL' (full four-backend) probe is ever in flight.
//   - AT MOST ONE per-product probe (for a given product) is ever in
//     flight for that product.
//   - A manual action (Refresh All / a card's Refresh / a Login-Logout-
//     triggered refresh / the Desktop app's own one startup refresh)
//     reuses an already-in-flight call for the same key rather than
//     starting a second probe set.
//
// P6-W3-R4.2 (owner product decision, R4-M02): periodic background
// polling caused visible packaged-app sluggishness even after R4.1's
// single-flight fix reduced its severity. This class deliberately has
// NO scheduling capability at all — no timer, no recurring loop, no
// scheduling method of any kind. App.tsx calls `refreshAll('full')` exactly
// once at Desktop app startup and otherwise only ever in direct response
// to an explicit owner action (Refresh, Refresh All, a scoped Login/
// Logout refresh). If a future wave needs scheduling again, that is a
// deliberate, disclosed product decision to re-add — not something this
// class should silently regrow.

export type RefreshMode = 'full' | 'auto';

export interface ConnectionRefreshCoordinatorDeps {
  refreshAll: (mode: RefreshMode) => Promise<void>;
  refreshOne: (product: string, mode: RefreshMode) => Promise<void>;
  /** Fired synchronously whenever the busy-key set changes — wire this to a React state setter. */
  onBusyChange?: (busyKeys: ReadonlySet<string>) => void;
}

const ALL_KEY = 'ALL';

export class ConnectionRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly busyKeys = new Set<string>();
  // R41-10 performance proof: the highest number of keys ever busy at the
  // same instant, and how many times the underlying refreshAll task
  // actually ran vs. how many times it was requested — the gap between
  // those two numbers is the direct proof that overlapping requests
  // collapse into one real probe set instead of stacking.
  private maxObservedConcurrency = 0;
  private refreshAllRequestCount = 0;
  private refreshAllRunCount = 0;

  constructor(private readonly deps: ConnectionRefreshCoordinatorDeps) {}

  getBusyKeys(): ReadonlySet<string> {
    return new Set(this.busyKeys);
  }

  isBusy(key: string): boolean {
    return this.busyKeys.has(key);
  }

  getMaxObservedConcurrency(): number {
    return this.maxObservedConcurrency;
  }

  getRefreshAllStats(): { requested: number; ran: number } {
    return { requested: this.refreshAllRequestCount, ran: this.refreshAllRunCount };
  }

  private async run(key: string, task: () => Promise<void>): Promise<void> {
    this.busyKeys.add(key);
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.busyKeys.size);
    this.deps.onBusyChange?.(new Set(this.busyKeys));
    try {
      await task();
    } finally {
      // R41-6: busy state always clears, on success or failure — never a
      // permanent "Refreshing…" after an exception/timeout.
      this.busyKeys.delete(key);
      this.deps.onBusyChange?.(new Set(this.busyKeys));
    }
  }

  private singleFlight(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) return existing; // R41-1: reuse, never spawn a second probe set
    const promise = this.run(key, task).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Refresh All / the header button — and, per R42-1/R42-3, the Desktop
   * app's own single startup refresh (App.tsx calls this exactly once on
   * mount, with no recurrence). Single-flight also protects this startup
   * call against React StrictMode's dev-only double-invoke: a second call
   * while the first is still in flight reuses it rather than starting a
   * second probe set.
   */
  refreshAll(mode: RefreshMode = 'full'): Promise<void> {
    this.refreshAllRequestCount += 1;
    return this.singleFlight(ALL_KEY, async () => {
      this.refreshAllRunCount += 1;
      await this.deps.refreshAll(mode);
    });
  }

  /** A single backend card's Refresh, or a Login/Logout-triggered refresh scoped to one product. */
  refreshOne(product: string, mode: RefreshMode = 'full'): Promise<void> {
    return this.singleFlight(product, () => this.deps.refreshOne(product, mode));
  }
}
