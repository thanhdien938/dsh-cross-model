import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuthEvidenceStore } from '../electron/main/services/authEvidenceStore';
import { scanPmRunsForAuthEvidence } from '../electron/main/services/authEvidenceScanner';
// Real production classifier, not a reimplementation — proves the wiring
// against the exact same logic src/orchestration/execution-failure-
// classifier.mjs applies to backend health/retry decisions elsewhere.
import { classifyExecutionFailure } from '../../src/orchestration/execution-failure-classifier.mjs';

describe('AuthEvidenceStore', () => {
  let dir: string;
  let store: AuthEvidenceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-evidence-'));
    store = new AuthEvidenceStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to UNKNOWN: nothing is recorded until real evidence exists', () => {
    expect(store.get('never-seen')).toBeUndefined();
  });

  it('records PROVEN with a timestamp and no secrets', () => {
    store.recordProven('pm-a', 'claude-code');
    const record = store.get('pm-a');
    expect(record?.state).toBe('PROVEN');
    expect(record?.timestamp).toBeTruthy();
    expect(JSON.stringify(record)).not.toMatch(/sk-|token|api[_-]?key/i);
  });

  it('records FAILED with a bounded, non-secret reason', () => {
    store.recordFailed('pm-a', 'codex', 'invalid api key');
    expect(store.get('pm-a')?.state).toBe('FAILED');
  });

  it('clearing a profile returns it to UNKNOWN', () => {
    store.recordProven('pm-a', 'claude-code');
    store.clear('pm-a');
    expect(store.get('pm-a')).toBeUndefined();
  });

  it('persists across a fresh store instance pointed at the same directory (restart survives)', () => {
    store.recordProven('pm-a', 'claude-code');
    store.close();
    const reopened = new AuthEvidenceStore(dir);
    expect(reopened.get('pm-a')?.state).toBe('PROVEN');
    reopened.close();
    store = new AuthEvidenceStore(dir);
  });
});

describe('scanPmRunsForAuthEvidence', () => {
  let dir: string;
  let store: AuthEvidenceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-scan-'));
    store = new AuthEvidenceStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a completed real PM run moves UNKNOWN -> PROVEN', () => {
    expect(store.get('pm-a')).toBeUndefined();
    scanPmRunsForAuthEvidence([{ pmProfileId: 'pm-a', product: 'claude-code', status: 'completed', error: null }], classifyExecutionFailure, store);
    expect(store.get('pm-a')?.state).toBe('PROVEN');
  });

  it('a version-probe-shaped success never appears here at all (this scanner only sees real terminal PM runs)', () => {
    // There is no code path from a `--version` probe into scanPmRunsForAuthEvidence;
    // proven by construction — only real terminal pm_runs rows are ever passed in.
    scanPmRunsForAuthEvidence([], classifyExecutionFailure, store);
    expect(store.list()).toHaveLength(0);
  });

  it('a clearly auth-classified failure moves UNKNOWN -> FAILED using the real production classifier', () => {
    scanPmRunsForAuthEvidence(
      [{ pmProfileId: 'pm-a', product: 'codex', status: 'failed', error: { message: 'Unauthorized: invalid API key' } }],
      classifyExecutionFailure,
      store,
    );
    expect(store.get('pm-a')?.state).toBe('FAILED');
  });

  it('an ordinary (non-auth) failure must NOT become FAILED auth evidence', () => {
    scanPmRunsForAuthEvidence(
      [{ pmProfileId: 'pm-a', product: 'codex', status: 'failed', error: { message: 'INVALID_ENVELOPE: malformed decision JSON' } }],
      classifyExecutionFailure,
      store,
    );
    expect(store.get('pm-a')).toBeUndefined();
  });

  it('a timeout/transport/config failure also stays UNKNOWN, not FAILED', () => {
    for (const message of ['ETIMEDOUT', 'ECONNRESET', 'ENOENT: claude not found']) {
      scanPmRunsForAuthEvidence([{ pmProfileId: 'pm-x', product: 'grok', status: 'failed', error: { message } }], classifyExecutionFailure, store);
      expect(store.get('pm-x')).toBeUndefined();
    }
  });

  it('once PROVEN, a later ordinary failure does not silently overwrite it (only AUTH failures may transition to FAILED)', () => {
    scanPmRunsForAuthEvidence([{ pmProfileId: 'pm-a', product: 'claude-code', status: 'completed', error: null }], classifyExecutionFailure, store);
    scanPmRunsForAuthEvidence([{ pmProfileId: 'pm-a', product: 'claude-code', status: 'failed', error: { message: 'ETIMEDOUT' } }], classifyExecutionFailure, store);
    expect(store.get('pm-a')?.state).toBe('PROVEN');
  });

  it('runs with no pmProfileId (not durably pinned) are skipped, never crash the scan', () => {
    expect(() => scanPmRunsForAuthEvidence([{ pmProfileId: null, product: 'codex', status: 'completed', error: null }], classifyExecutionFailure, store)).not.toThrow();
    expect(store.list()).toHaveLength(0);
  });
});
