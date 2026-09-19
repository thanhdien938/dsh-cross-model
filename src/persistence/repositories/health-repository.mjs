/**
 * The sole SQL owner for backend-health durable evidence.
 *
 * This repository stores and returns raw observations. Freshness and cooldown
 * materialization belong to the durable health facade, so reads never rewrite
 * historical evidence or increment revision.
 */

const STORE_SEAM_METHODS = Object.freeze(['get', 'all', 'transactionSync']);

function rowToObservation(row) {
  if (!row) return undefined;
  return Object.freeze({
    backend: row.backend,
    status: row.status,
    classification: row.classification ?? null,
    retryable: row.retryable === 1,
    observedAt: row.observed_at ?? null,
    cooldownUntil: row.cooldown_until === null ? null : Date.parse(row.cooldown_until),
    diagnostic: row.diagnostic ?? null,
    revision: row.revision,
  });
}

export class HealthRepository {
  constructor({ store } = {}) {
    if (store === null || typeof store !== 'object') {
      throw new TypeError('HealthRepository requires a persistence store');
    }
    const missing = STORE_SEAM_METHODS.filter((name) => typeof store[name] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(`HealthRepository requires a store with repository seams; missing: ${missing.join(', ')}`);
    }
    this.store = store;
  }

  getRaw(backend) {
    return rowToObservation(this.store.get(
      'SELECT backend, status, classification, retryable, observed_at, cooldown_until, diagnostic, revision FROM backend_health WHERE backend = ?',
      [backend],
    ));
  }

  listRaw() {
    return this.store
      .all('SELECT backend, status, classification, retryable, observed_at, cooldown_until, diagnostic, revision FROM backend_health ORDER BY backend')
      .map(rowToObservation);
  }

  count() {
    return this.store.get('SELECT COUNT(*) AS count FROM backend_health').count;
  }

  commitObservation(observation) {
    return this.store.transactionSync(({ get, run }) => {
      const current = get('SELECT revision FROM backend_health WHERE backend = ?', [observation.backend]);
      const revision = (current?.revision ?? 0) + 1;
      run(
        `INSERT INTO backend_health
          (backend, record_version, status, classification, retryable, observed_at, cooldown_until, diagnostic, revision, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(backend) DO UPDATE SET
          status = excluded.status,
          classification = excluded.classification,
          retryable = excluded.retryable,
          observed_at = excluded.observed_at,
          cooldown_until = excluded.cooldown_until,
          diagnostic = excluded.diagnostic,
          revision = excluded.revision,
          updated_at = excluded.updated_at`,
        [
          observation.backend,
          observation.status,
          observation.classification,
          observation.retryable ? 1 : 0,
          observation.observedAt,
          observation.cooldownUntil === null ? null : new Date(observation.cooldownUntil).toISOString(),
          observation.diagnostic,
          revision,
          observation.observedAt,
        ],
      );
      return Object.freeze({ ...observation, revision });
    });
  }
}
