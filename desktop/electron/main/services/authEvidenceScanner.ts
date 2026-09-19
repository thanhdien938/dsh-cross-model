import { AuthEvidenceStore } from './authEvidenceStore';

export interface TerminalPmRunFact {
  pmProfileId: string | null;
  product: string;
  status: string; // 'completed' | 'failed' | ...
  error: unknown;
}

export type Classify = (error: unknown) => { classification: string | null };

// W2-O evidence rule, applied to already-terminal PM runs read from the
// canonical SQLite v6 projection (never invented, never inferred from a
// CLI probe):
//   - status === 'completed'                         -> PROVEN
//   - status === 'failed' AND classification === AUTH -> FAILED
//   - anything else (any other failure classification,
//     unclassified, non-terminal)                     -> no change
// `classify` is injected so this stays testable without a real backend and
// so the real caller can inject the actual production
// `classifyExecutionFailure` (src/orchestration/execution-failure-
// classifier.mjs) rather than a second, weaker reimplementation.
export function scanPmRunsForAuthEvidence(runs: TerminalPmRunFact[], classify: Classify, store: Pick<AuthEvidenceStore, 'recordProven' | 'recordFailed'>): void {
  for (const run of runs) {
    if (!run.pmProfileId) continue;
    if (run.status === 'completed') {
      store.recordProven(run.pmProfileId, run.product);
    } else if (run.status === 'failed') {
      const { classification } = classify(run.error);
      if (classification === 'AUTH') {
        store.recordFailed(run.pmProfileId, run.product, summarizeError(run.error));
      }
    }
  }
}

function summarizeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const anyError = error as Record<string, unknown>;
    return String(anyError.message ?? anyError.code ?? 'authentication failure');
  }
  return String(error ?? 'authentication failure');
}
