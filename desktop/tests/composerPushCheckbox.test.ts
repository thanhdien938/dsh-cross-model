import { describe, it, expect } from 'vitest';
import { isPushCheckboxEnabled } from '../src/components/Composer';

// P12-R5A Part F/Q (items 4/5/8) — the pure UI-gating half of the push
// control. This is intent-capture ONLY: the real, authoritative decision
// is production-pm-worker.mjs's isPushAuthorized() (proven independently
// in tests/p12-r4-review-and-remediation.test.mjs — FORBID always blocks,
// APPROVAL only from a LOCAL channel, TELEGRAM never authorizes at any
// level), which never trusts anything this function or the renderer
// computes. This function only decides whether the *checkbox* should be
// interactive at all.

describe('isPushCheckboxEnabled', () => {
  it('4. FORBID -> disabled (the control must not even offer a request)', () => {
    expect(isPushCheckboxEnabled('FORBID')).toBe(false);
  });

  it('5. APPROVAL -> enabled (the owner may explicitly request it)', () => {
    expect(isPushCheckboxEnabled('APPROVAL')).toBe(true);
  });

  it('ALLOW -> enabled', () => {
    expect(isPushCheckboxEnabled('ALLOW')).toBe(true);
  });

  it('8. UNKNOWN -> disabled — never guessed permissive when the real policy could not be determined', () => {
    expect(isPushCheckboxEnabled('UNKNOWN')).toBe(false);
  });

  it('undefined (no project selected / policy not yet loaded) -> disabled, the safe default', () => {
    expect(isPushCheckboxEnabled(undefined)).toBe(false);
  });
});
