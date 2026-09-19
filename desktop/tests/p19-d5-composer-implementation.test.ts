import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Desktop suite intentionally has no DOM renderer. Pin the security-
// relevant source shape in the same manner as the existing D4 panel tests;
// payload behavior itself is covered in submitTaskPayload.test.ts.
const source = readFileSync(join(__dirname, '../src/components/Composer.tsx'), 'utf8');

describe('P19-D5 Composer implementation participant selection', () => {
  it('renders a single-select optional implementation participant control only inside the Debate-enabled block', () => {
    expect(source).toMatch(/Implementation participant \(optional\)/);
    expect(source).toMatch(/None — all participants read-only/);
    expect(source).toMatch(/value=\{implementationParticipantId\}/);
  });

  it('builds implementation choices only from the selected Council participant set', () => {
    expect(source).toMatch(/\[\.\.\.participants\]\.map/);
  });

  it('clears a stale selection when Debate is disabled or the participant leaves the Council set', () => {
    expect(source).toMatch(/!debateEnabled \|\| !participants\.has\(implementationParticipantId\)/);
    expect(source).toMatch(/setImplementationParticipantId\(''\)/);
  });

  it('states that Debate-round turns remain read-only', () => {
    expect(source).toMatch(/All Debate briefs, responses, and syntheses remain read-only/);
  });
});
