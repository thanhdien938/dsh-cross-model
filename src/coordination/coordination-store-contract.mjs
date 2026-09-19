import { CoordinationError } from './coordination-errors.mjs';

export const COORDINATION_STORE_METHODS = Object.freeze([
  'open', 'close', 'migrate', 'assertReady', 'readSchemaVersion',
  'transaction', 'serverNow', 'registerWorkerIncarnation',
  'readWorkerIncarnation', 'listWorkerIncarnations',
  'heartbeatWorkerIncarnation', 'setWorkerLifecycle',
  'registerCoordinatorIncarnation', 'readCoordinatorIncarnation',
  'listCoordinatorIncarnations', 'setCoordinatorLifecycle',
  'registerWorkIdentity', 'readWorkItem', 'readClaim', 'acquireClaim',
  'listTaskDispatchCandidates', 'listActivePmActionWork',
  'renewClaim', 'releaseClaim', 'completeClaim', 'fencedTouch', 'parkClaimForOwner', 'restoreOwnerDecisionEligibility',
  'withClaimAuthority',
  'acquireLeadership', 'renewLeadership', 'readLeadership',
  'withLeadershipAuthority', 'fencedPolicyTouch',
  'requestCancellation', 'readCancellation', 'startCancellation', 'completeCancellation', 'cancelUnclaimedWork',
]);

export function assertCoordinationStore(store) {
  const missing = COORDINATION_STORE_METHODS.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) {
    throw new CoordinationError(`coordination store missing required members: ${missing.join(', ')}`, {
      code: 'INVALID_COORDINATION_STORE', missing,
    });
  }
  return true;
}
