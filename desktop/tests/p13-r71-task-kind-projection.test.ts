import {describe,expect,it} from 'vitest';
import {projectTaskKind} from '../electron/main/services/readProjection';

// P13-R7.1 (docs/p13/15A_*.md): real R7 live defects -- LONG tasks
// displayed NORMAL, and a Council outer task displayed SINGLE. Root
// cause: the projection read `envelope.council`/`envelope.runtime_class`
// (top-level, wrong-cased, never-existing keys) instead of the canonical
// `envelope.context.council`/`envelope.context.runtimeClass` the runtime
// layer itself durably writes and reads (createPmRequest()'s own
// `{id,objective,context,createdAt}` shape -- src/pm/pm-contracts.mjs;
// `context` populated by owner-task-controller.mjs's SUBMIT_TASK handler
// with `{ownerCommandId,council,channel,runtimeClass,durability,...}`).
// These are deterministic fixtures against the REAL parsed-envelope
// shape -- no live DB required.

function envelope(context: any) {
  return { id: 'pmreq-1', objective: 'do work', context, createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('P13-R7.1 canonical task-kind projection', () => {
  it('LONG + SINGLE: runtimeClass and mode are independently correct', () => {
    const result = projectTaskKind(envelope({ runtimeClass: 'LONG', durability: 'DURABLE_LOCAL' }));
    expect(result).toEqual({ mode: 'SINGLE', runtimeClass: 'LONG', durability: 'DURABLE_LOCAL' });
  });

  it('NORMAL + SINGLE: runtimeClass and mode are independently correct', () => {
    const result = projectTaskKind(envelope({ runtimeClass: 'NORMAL', durability: 'DIRECT' }));
    expect(result).toEqual({ mode: 'SINGLE', runtimeClass: 'NORMAL', durability: 'DIRECT' });
  });

  it('NORMAL + COUNCIL: mode is COUNCIL from a real council context, runtimeClass stays NORMAL -- never conflated', () => {
    const result = projectTaskKind(envelope({ runtimeClass: 'NORMAL', durability: 'DIRECT', council: { chair_profile_id: 'p1', participant_profile_ids: ['p2', 'p3'], rounds: 1 } }));
    expect(result).toEqual({ mode: 'COUNCIL', runtimeClass: 'NORMAL', durability: 'DIRECT' });
  });

  it('LONG + COUNCIL: both independently correct at once (architecture allows this combination)', () => {
    const result = projectTaskKind(envelope({ runtimeClass: 'LONG', durability: 'DURABLE_LOCAL', council: { chair_profile_id: 'p1', participant_profile_ids: ['p2'], rounds: 2 } }));
    expect(result).toEqual({ mode: 'COUNCIL', runtimeClass: 'LONG', durability: 'DURABLE_LOCAL' });
  });

  it('a pre-P12 durable task with no context.runtimeClass at all projects runtimeClass:null, never a guessed NORMAL', () => {
    const result = projectTaskKind(envelope({}));
    expect(result.runtimeClass).toBeNull();
    expect(result.mode).toBe('SINGLE');
    expect(result.durability).toBe('DIRECT');
  });

  it('a malformed/missing envelope never throws -- degrades to the same safe SINGLE/null/DIRECT defaults', () => {
    expect(projectTaskKind(null)).toEqual({ mode: 'SINGLE', runtimeClass: null, durability: 'DIRECT' });
    expect(projectTaskKind({})).toEqual({ mode: 'SINGLE', runtimeClass: null, durability: 'DIRECT' });
    expect(projectTaskKind({ context: null })).toEqual({ mode: 'SINGLE', runtimeClass: null, durability: 'DIRECT' });
  });

  it('the old wrong top-level/wrong-cased fields (envelope.council, envelope.runtime_class, envelope.lifecycle) are never read', () => {
    // A pathological envelope carrying the OLD (wrong) shape at the top
    // level, with the correct shape ABSENT under .context, must still
    // project the safe SINGLE/null/DIRECT defaults -- proving the fix
    // reads the real nested path, not the old stale one.
    const result = projectTaskKind({ id: 'pmreq-1', objective: 'x', council: { chair_profile_id: 'p1' }, runtime_class: 'LONG', lifecycle: { durability: 'DURABLE_LOCAL' }, context: {} });
    expect(result).toEqual({ mode: 'SINGLE', runtimeClass: null, durability: 'DIRECT' });
  });

  it('Council internal participants remain one outer task row -- getMultiTaskStatus queries pm_runs only, never a per-participant row', () => {
    const fs = require('fs'); const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../electron/main/services/readProjection.ts'), 'utf8');
    const queryMatch = source.match(/const runs = this\.sqliteDb\.prepare\(`([^`]+)`\)/);
    expect(queryMatch).toBeTruthy();
    expect(queryMatch![1]).toContain('FROM pm_runs r JOIN pm_requests q');
    expect(queryMatch![1]).not.toMatch(/participant/i);
  });
});
