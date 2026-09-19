// Platform-neutral coverage for readExternalRunnerDiagnosticEvidence()
// (pure log-text parsing over a real temp directory) — this runs on every
// CI platform. The Windows-only RelayRunnerLifecycleManager coverage
// (health monitor, listener discovery, crash-loop recovery — all built on
// Windows-shaped fixtures and taskkill/PowerShell/cmd.exe production
// dependencies) lives in relayRunnerLifecycleManagerWindows.test.ts,
// which runs only in the Windows-only CI shard. See that file's header
// for why the split is a real platform boundary, not a test-organization
// convenience.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readExternalRunnerDiagnosticEvidence } from '../electron/main/services/relayRunnerLifecycleManager';

describe('PM24-RUNNER: readExternalRunnerDiagnosticEvidence (real filesystem)', () => {
  function makeRunnerDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-diag-'));
    fs.mkdirSync(path.join(dir, '_diag'));
    return dir;
  }
  function writeDiag(dir: string, name: string, content: string): void {
    fs.writeFileSync(path.join(dir, '_diag', name), content, 'utf8');
  }

  it('no _diag directory at all reports no evidence, never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-diag-'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('an empty _diag directory reports no evidence', () => {
    const dir = makeRunnerDir();
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('the real installed runner (2.337.0) startup banner — no "Connected to GitHub" line at all — is still recognized via "Current runner version:"', () => {
    // Live evidence: the owner's actual installed CLI never prints
    // "Connected to GitHub" in either the clean-connect or reconnect-after-
    // conflict case (see relayRunnerLifecycleManager.ts's CONNECTED_EVIDENCE_RE
    // docstring) — this is that exact real banner shape, byte-for-byte.
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      '2026-09-05 10:05:54Z: Listening for Jobs',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a "Running job:" line with no completion yet is reported busy', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: true });
  });

  it('a completed job returns to idle (busy:false) with connected/listening evidence intact', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
      'Job relay-v3 completed with result: Succeeded',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a disconnect/error line after prior evidence invalidates connected/listening back to false — never a stale positive', () => {
    // A job completes, then a connection-degraded line (the SAME regex
    // ingestLine() already uses) appears with no fresh "Listening for Jobs"
    // line afterward — must NOT be reported verified.
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260905-100518-utc.log', [
      "Current runner version: '2.337.0'",
      'Listening for Jobs',
      'Running job: relay-v3',
      'Job relay-v3 completed with result: Failed',
      'GitHub Actions service unreachable, retrying session.',
    ].join('\n'));
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });

  it('picks the lexicographically newest Runner_*.log — an older rotated log never overrides current evidence', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Runner_20260904-090000-utc.log', "Current runner version: '2.337.0'\nListening for Jobs\n");
    writeDiag(dir, 'Runner_20260905-100518-utc.log', "Current runner version: '2.337.0'\n"); // newer, no Listening yet
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: false, busy: false });
  });

  it('a bounded tail read still finds evidence near the end of an oversized log', () => {
    const dir = makeRunnerDir();
    const padding = `${'x'.repeat(1024)}\n`.repeat(600); // ~600KB of irrelevant filler
    writeDiag(dir, 'Runner_20260905-100518-utc.log', `${padding}Current runner version: '2.337.0'\nListening for Jobs\n`);
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: true, listening: true, busy: false });
  });

  it('a non-log file in _diag (e.g. a Worker_*.log) is never mistaken for the runner log', () => {
    const dir = makeRunnerDir();
    writeDiag(dir, 'Worker_20260905-100729-utc.log', "Current runner version: '2.337.0'\nListening for Jobs\n");
    expect(readExternalRunnerDiagnosticEvidence(dir)).toEqual({ connected: false, listening: false, busy: false });
  });
});
