import { describe, it, expect } from 'vitest';
import { deriveAntigravityReasoningTier } from '../src/components/PmProfileCreateDialog';

// P9-R0.3 Part E/Q: this is the SUPPLEMENTAL renderer-side copy of
// src/session/antigravity-cli-session-bridge.mjs's
// deriveAntigravityReasoningFromModel() — the real, trusted guard is
// server-side (pmProfileConfigService.test.ts). This only proves the two
// stay in agreement for every live-known model slug.
describe('deriveAntigravityReasoningTier', () => {
  it('extracts low/medium/high from Gemini tier-suffixed slugs', () => {
    expect(deriveAntigravityReasoningTier('gemini-3.5-flash-low')).toBe('low');
    expect(deriveAntigravityReasoningTier('gemini-3.7-flash-medium')).toBe('medium');
    expect(deriveAntigravityReasoningTier('gemini-3.1-pro-high')).toBe('high');
  });
  it('extracts medium from the GPT-OSS slug', () => {
    expect(deriveAntigravityReasoningTier('gpt-oss-120b-medium')).toBe('medium');
  });
  it('never invents a tier for Claude slugs with no recognized suffix', () => {
    expect(deriveAntigravityReasoningTier('claude-sonnet-4-6')).toBe(null);
    expect(deriveAntigravityReasoningTier('claude-opus-4-6-thinking')).toBe(null);
  });
  it('returns null for an empty/unrecognized slug', () => {
    expect(deriveAntigravityReasoningTier('')).toBe(null);
    expect(deriveAntigravityReasoningTier('some-custom-model')).toBe(null);
  });
});
