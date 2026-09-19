// DSH_RECONCILIATION_MODE safety gate: production auto-reconciliation is
// DEFAULT OFF. The mode is ONE explicit, bounded configuration setting —
// the exact environment variable `DSH_RECONCILIATION_MODE` with the exact
// values `disabled|dry-run|enabled` — never inferred from any other env
// var, truthiness, or presence check. Any other value fails closed
// (config load refuses to start the runtime).
export const DSH_RECONCILIATION_MODE_ENV = 'DSH_RECONCILIATION_MODE';

export const RECONCILIATION_MODE = Object.freeze({
  DISABLED: 'disabled',
  DRY_RUN: 'dry-run',
  ENABLED: 'enabled',
});

const MODES = new Set(Object.values(RECONCILIATION_MODE));

/**
 * Resolves the single reconciliation mode setting. Missing/empty resolves to
 * DISABLED (default off); anything else outside the exact bounded vocabulary
 * throws — never silently coerced, never case-insensitive, never inferred.
 */
export function resolveReconciliationMode(value) {
  if (value == null || value === '') return RECONCILIATION_MODE.DISABLED;
  if (!MODES.has(value)) throw new TypeError(`reconciliation mode is invalid (expected ${DSH_RECONCILIATION_MODE_ENV}=${[...MODES].join('|')}, got ${JSON.stringify(value)})`);
  return value;
}
