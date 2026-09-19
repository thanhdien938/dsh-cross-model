/**
 * P13-R5 — resource pressure governor.
 *
 * Mission (docs/p13/13_P13_R5_RESOURCE_PRESSURE_GOVERNOR_OPUS5.md):
 * prevent NEW admission when the local machine is under unsafe resource
 * pressure. Never kill/interrupt an already-active task merely because a
 * threshold was crossed — this module is consulted ONLY by the admission
 * path (production-pm-worker.mjs), never anywhere near a running slot's
 * lifecycle.
 *
 * Deliberately simple, per the brief's own instruction ("keep policy
 * simple... do not add fragile high-frequency instrumentation"): the one
 * signal implemented here is system RAM pressure via `node:os`'s
 * `freemem()`/`totalmem()` — always available, synchronous, no sampling
 * window, no native dependency, and (unlike `os.loadavg()`, which is
 * always `[0,0,0]` on Windows) meaningful on every platform DSH runs on.
 * CPU utilization and child-process-count are surveyed and deliberately
 * NOT implemented here — see this file's own docstring below for why —
 * and are recorded as an explicit, honest gap for a later gate.
 */
import { freemem, totalmem } from 'node:os';

/**
 * The one resource signal this gate implements. Synchronous, side-effect
 * free, effectively infallible (a plain read of two OS-reported numbers)
 * — but `readMetrics` is always called through a try/catch (see
 * `createResourcePressureGovernor`) so a caller-supplied REPLACEMENT
 * reader (e.g. a future WMI-based CPU sampler) that genuinely can fail
 * is still handled safely.
 *
 * CPU utilization was surveyed and deliberately NOT implemented: Node has
 * no built-in "current CPU %" primitive — `os.cpus()` returns a snapshot
 * of cumulative per-core tick counts that requires taking TWO samples
 * across a real time interval and computing a delta, which is exactly
 * the "fragile high-frequency instrumentation" the brief warns against
 * for a first gate. Child-process count was also surveyed: DSH does not
 * currently track a live registry of its own spawned provider children
 * anywhere the governor could cheaply read from (each backend bridge
 * owns its own child reference locally — production-pm-backend-
 * registry.mjs) — building one would be new plumbing beyond this gate's
 * "governor architecture" scope. Both are recorded as an explicit,
 * un-guessed gap, not implemented as a guess.
 *
 * @returns {{usedFraction:number, freeBytes:number, totalBytes:number}}
 */
export function readSystemMemoryPressure() {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedFraction = totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : 0;
  return { usedFraction, freeBytes, totalBytes };
}

const DEFAULT_HIGH_WATERMARK = 0.9; // provisional/test threshold -- see docs/p13/13_*.md
const DEFAULT_RECOVERY_WATERMARK = 0.8; // must be strictly below the high watermark

/**
 * Creates a stateful governor with hysteresis: pressure turns ON at
 * `highWatermark` and stays on until the metric falls to
 * `recoveryWatermark` or below — never oscillating admit/deny on every
 * tick around one boundary value.
 *
 * Failure mode (the brief's own explicit requirement — "do not crash the
 * runtime; choose and document a conservative fallback"): if
 * `readMetrics()` throws, this gate FAILS CLOSED for that ONE tick only
 * (denies new admission, reports `RESOURCE_PRESSURE` with `metrics:null`
 * and the sanitized error) — consistent with every other P13 admission
 * gate's own "fail conservative when uncertain" discipline (D2's
 * workspace-identity fallback is the same shape: refuse rather than
 * guess). This is NOT sticky: metrics are re-read fresh on the very next
 * tick (the same "never cache across ticks" discipline R3/R4 already
 * established for workspace/backend occupancy), so a transient read
 * failure can never permanently block admission — it can only ever pause
 * it for as long as reads keep failing, exactly the same shape as a
 * genuine resource-pressure episode.
 *
 * @param {{readMetrics?:Function, highWatermark?:number, recoveryWatermark?:number}} [options]
 * @returns {{checkAdmission: () => {allowed:boolean, pressureActive:boolean, metrics:object|null, error:object|null}}}
 */
export function createResourcePressureGovernor({ readMetrics = readSystemMemoryPressure, highWatermark = DEFAULT_HIGH_WATERMARK, recoveryWatermark = DEFAULT_RECOVERY_WATERMARK } = {}) {
  if (!(recoveryWatermark < highWatermark)) throw new TypeError('recoveryWatermark must be strictly below highWatermark');
  let pressureActive = false;
  return Object.freeze({
    checkAdmission() {
      let metrics;
      try {
        metrics = readMetrics();
      } catch (cause) {
        // Fail closed for this tick only -- never sticky, never a crash.
        return Object.freeze({ allowed: false, pressureActive, metrics: null, error: { name: cause?.name ?? 'Error', message: String(cause?.message ?? cause) } });
      }
      const fraction = typeof metrics?.usedFraction === 'number' ? metrics.usedFraction : null;
      if (fraction === null) {
        // A caller-supplied reader returned a shape this governor cannot
        // interpret -- same conservative treatment as a thrown error.
        return Object.freeze({ allowed: false, pressureActive, metrics, error: { name: 'InvalidMetricsShape', message: 'readMetrics() did not return a numeric usedFraction' } });
      }
      if (!pressureActive && fraction >= highWatermark) pressureActive = true;
      else if (pressureActive && fraction <= recoveryWatermark) pressureActive = false;
      // else: unchanged -- this is the hysteresis band itself.
      return Object.freeze({ allowed: !pressureActive, pressureActive, metrics, error: null });
    },
  });
}
