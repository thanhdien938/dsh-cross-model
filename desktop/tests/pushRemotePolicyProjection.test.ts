import { describe, it, expect } from 'vitest';
import { mapPushRemoteEffectToPolicy } from '../electron/main/services/readProjection';

// P12-R5A Part P — the pure half of the PUSH_REMOTE safe projection.
// buildProjectList() derives `effects` via the real normalizeAutonomyEnvelope()
// (dynamically imported, untestable directly under this project's vitest
// sandbox — see readProjection.ts's own comment); this function is the
// deterministic mapping from already-normalized effects to the owner-facing
// label, and is fully covered here without touching dynamic import at all.

describe('mapPushRemoteEffectToPolicy', () => {
  it('projects FORBID as FORBID', () => {
    expect(mapPushRemoteEffectToPolicy({ PUSH_REMOTE: 'FORBID' })).toBe('FORBID');
  });

  it('projects APPROVAL as APPROVAL', () => {
    expect(mapPushRemoteEffectToPolicy({ PUSH_REMOTE: 'APPROVAL' })).toBe('APPROVAL');
  });

  it('projects ALLOW as ALLOW (even though the real normalizeAutonomyEnvelope() never actually produces this for PUSH_REMOTE — this function trusts whatever it is handed, it does not re-derive)', () => {
    expect(mapPushRemoteEffectToPolicy({ PUSH_REMOTE: 'ALLOW' })).toBe('ALLOW');
  });

  it('defaults an absent PUSH_REMOTE entry to FORBID — matches isPushAuthorized()\'s own default exactly, never a permissive default', () => {
    expect(mapPushRemoteEffectToPolicy({})).toBe('FORBID');
    expect(mapPushRemoteEffectToPolicy(undefined)).toBe('FORBID');
    expect(mapPushRemoteEffectToPolicy(null)).toBe('FORBID');
  });

  it('an unrecognized value projects as UNKNOWN, never a guessed specific level', () => {
    expect(mapPushRemoteEffectToPolicy({ PUSH_REMOTE: 'not-a-real-level' })).toBe('UNKNOWN');
  });
});
