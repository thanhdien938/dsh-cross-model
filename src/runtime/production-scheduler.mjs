import { selectEligibleWorkers } from '../coordination/worker-eligibility.mjs';

export class ProductionScheduler {
  constructor({ scanLimit = 64 } = {}) {
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 1_000) throw new TypeError('scanLimit is invalid');
    this.scanLimit = scanLimit;
  }

  candidates({ workers = [], requirement, providerHealth = 'UNKNOWN' } = {}) {
    return selectEligibleWorkers({ workers: workers.slice(0, this.scanLimit), requirement, providerHealth });
  }
}
