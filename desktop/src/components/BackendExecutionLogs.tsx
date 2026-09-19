import React, { useEffect, useRef, useState } from 'react';
import './BackendExecutionLogs.css';

// R31-4: fallback shown only until window.desktop.backends.capabilities()
// (the real production registry's product catalogue — the same source
// Connection Center already uses, never a second hardcoded frontend
// list) resolves at least once. Kept in sync with the registry's default
// set today; the registry, not this array, is authoritative.
const FALLBACK_PRODUCTS = ['claude-code', 'opencode', 'codex', 'grok', 'antigravity'];

const KNOWN_PRODUCT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
};

function labelFor(product: string): string {
  return KNOWN_PRODUCT_LABELS[product] ?? product.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const POLL_MS = 1000;
const MAX_RENDERED_LINES = 2000;

interface BackendExecutionLogsProps {
  runtimeRunning: boolean;
}

function emptyRecord<T>(products: string[], value: T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const product of products) out[product] = value;
  return out;
}

// P6-W3-R3 Part B — a READ-ONLY, per-backend execution-log dock panel.
// There is no stdin field, no shell prompt, and no way to send anything
// to the backend process from here: every value this component reads
// comes from window.desktop.execLogs (list/statuses only — see
// preload.ts). This is deliberately not the Login Terminal — that remains
// the one interactive CLI-auth surface (LoginTerminal.tsx).
function BackendExecutionLogs({ runtimeRunning }: BackendExecutionLogsProps) {
  const [expanded, setExpanded] = useState(false);
  const [products, setProducts] = useState<string[]>(FALLBACK_PRODUCTS);
  const [activeProduct, setActiveProduct] = useState<string>(FALLBACK_PRODUCTS[0]);
  const [entriesByProduct, setEntriesByProduct] = useState<Record<string, BackendExecutionLogEntry[]>>(() => emptyRecord(FALLBACK_PRODUCTS, []));
  const [truncatedByProduct, setTruncatedByProduct] = useState<Record<string, boolean>>(() => emptyRecord(FALLBACK_PRODUCTS, false));
  const [statuses, setStatuses] = useState<Record<string, BackendRunState>>({});
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const cursorsRef = useRef<Record<string, number>>(emptyRecord(FALLBACK_PRODUCTS, 0));
  const bodyRef = useRef<HTMLDivElement>(null);

  // R31-4/P6.5 Part I: derive tabs/buffers from the real production
  // registry's product catalogue instead of a hardcoded enum. A future
  // fifth backend appears here without editing this component. Never
  // authoritative for the Desktop-side buffers themselves (main.ts wires
  // the same source into BackendExecutionLogService independently) —
  // this only decides what the renderer *displays* tabs for.
  //
  // P6.5: this previously polled `backends.capabilities()` (a real,
  // multi-second, all-four-backend native CLI probe) every 15s purely to
  // read `capabilities.map(c => c.product)` — an unrelated static value
  // that never changes for the app's lifetime, and a periodic-refresh
  // source docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md's audit found that
  // directly contradicted R4.2's "no periodic backend refresh" decision.
  // Fixed to fetch the static product list (`backends:products` — zero
  // CLI probing) exactly once, on mount, with no recurrence.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const discovered = await window.desktop.backends.products();
        if (cancelled || discovered.length === 0) return;
        setProducts((prev) => (sameSet(prev, discovered) ? prev : discovered));
      } catch {
        // Keep whatever product set is already known (fallback).
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep all per-product records/tabs in sync whenever the discovered
  // product set changes (adds coverage for a new product; never drops an
  // already-active tab's accumulated view).
  useEffect(() => {
    setEntriesByProduct((prev) => mergeMissing(prev, products, []));
    setTruncatedByProduct((prev) => mergeMissing(prev, products, false));
    cursorsRef.current = mergeMissing(cursorsRef.current, products, 0);
    setActiveProduct((prev) => (products.includes(prev) ? prev : products[0]));
  }, [products]);

  // R31-9: a fresh transition into RUNNING — whether the very first
  // start or a restart after STOPPED — starts every product's local view
  // clean. This is purely a rendering-freshness choice, not a
  // correctness requirement: BackendExecutionRingBuffer.clear() never
  // resets sequence numbers (see its docstring), so even a *stale*
  // cursor from before a restart would still correctly pick up the new
  // session's events on the very next poll — this just avoids visually
  // mixing a new session's lines with a stale previous one.
  useEffect(() => {
    if (!runtimeRunning) return;
    cursorsRef.current = emptyRecord(products, 0);
    setEntriesByProduct(emptyRecord(products, []));
    setTruncatedByProduct(emptyRecord(products, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on the RUNNING transition, not on every `products` change
  }, [runtimeRunning]);

  useEffect(() => {
    if (!runtimeRunning) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const nextStatuses = await window.desktop.execLogs.statuses();
        if (!cancelled) setStatuses(nextStatuses);
      } catch {
        // Non-authoritative view — a failed poll just tries again next tick.
      }
      for (const product of products) {
        try {
          const result = await window.desktop.execLogs.list(product, { afterSeq: cursorsRef.current[product] ?? 0 });
          if (cancelled) return;
          if (result.entries.length === 0 && !result.truncated) continue;
          cursorsRef.current[product] = result.latestSeq;
          setTruncatedByProduct((prev) => (prev[product] === result.truncated ? prev : { ...prev, [product]: result.truncated }));
          if (result.entries.length === 0) continue;
          setEntriesByProduct((prev) => {
            const merged = [...(prev[product] ?? []), ...result.entries];
            const bounded = merged.length > MAX_RENDERED_LINES ? merged.slice(merged.length - MAX_RENDERED_LINES) : merged;
            return { ...prev, [product]: bounded };
          });
        } catch {
          // Ephemeral view — a dropped poll during a GUI disconnect is
          // acceptable (Part B5); it just resumes on the next tick.
        }
      }
    };

    void poll();
    const interval = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [runtimeRunning, products]);

  useEffect(() => {
    if (!pinnedToBottom || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [entriesByProduct, activeProduct, pinnedToBottom]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPinnedToBottom(atBottom);
  };

  const jumpToLatest = () => {
    setPinnedToBottom(true);
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  const badgeFor = (product: string) => statuses[product]?.badge ?? 'idle';
  const entries = entriesByProduct[activeProduct] ?? [];
  const truncated = truncatedByProduct[activeProduct] ?? false;
  const activeStatus = statuses[activeProduct];

  return (
    <div className={`exec-logs ${expanded ? 'exec-logs-expanded' : ''}`}>
      <button
        type="button"
        className="exec-logs-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="panel-header-label">Backend Execution (read-only)</span>
        <span className="exec-logs-toggle" aria-hidden="true">{expanded ? '▼' : '▲'}</span>
      </button>

      {expanded && (
        <div className="exec-logs-content">
          <div className="exec-logs-tabs">
            {products.map((product) => (
              <button
                key={product}
                className={`exec-logs-tab ${activeProduct === product ? 'exec-logs-tab-active' : ''}`}
                onClick={() => setActiveProduct(product)}
              >
                {labelFor(product)}
                {badgeFor(product) === 'running' && <span className="exec-logs-badge exec-logs-badge-running">●</span>}
                {badgeFor(product) === 'failed' && <span className="exec-logs-badge exec-logs-badge-failed">!</span>}
              </button>
            ))}
          </div>

          <div className="exec-logs-status-bar">
            <span>Project: {activeStatus?.projectId ?? '—'}</span>
            <span>Task: {activeStatus?.taskId ? activeStatus.taskId.slice(0, 16) : '—'}</span>
            <span>CWD: {activeStatus?.cwd ?? '—'}</span>
            <span>Status: {activeStatus?.badge ?? 'idle'}</span>
            {!pinnedToBottom && (
              <button className="exec-logs-jump" onClick={jumpToLatest}>Jump to latest</button>
            )}
          </div>

          {truncated && (
            <div className="exec-logs-truncated">[... older execution log lines discarded ...]</div>
          )}

          <div className="exec-logs-body" ref={bodyRef} onScroll={onScroll}>
            {entries.length === 0 && (
              <div className="exec-logs-empty">
                {runtimeRunning ? `No ${labelFor(activeProduct)} execution yet.` : 'Start runtime to see backend execution logs.'}
              </div>
            )}
            {entries.map((entry) => (
              <div key={entry.seq} className={`exec-logs-line exec-logs-line-${(entry.phase ?? 'other').toLowerCase()}`}>
                <span className="exec-logs-time">{formatTime(entry.timestamp)}</span>
                <span className="exec-logs-phase">{entry.phase ?? entry.eventKind ?? ''}</span>
                <span className="exec-logs-message">{entry.message}</span>
              </div>
            ))}
          </div>

          <p className="exec-logs-note">
            Read-only debug evidence. Not canonical truth — the durable Backend Runs record above remains the source of truth for task outcomes.
          </p>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((v) => setA.has(v));
}

function mergeMissing<T>(record: Record<string, T>, products: string[], defaultValue: T): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = { ...record };
  for (const product of products) {
    if (!(product in out)) {
      out[product] = defaultValue;
      changed = true;
    }
  }
  return changed ? out : record;
}

export default BackendExecutionLogs;
