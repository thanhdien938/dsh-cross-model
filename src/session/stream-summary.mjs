// P23.3 bounded, content-free stream metadata. This accumulator retains no
// stream bodies and distinguishes an observed empty stream (zero/null
// timestamps) from instrumentation that never supplied a summary (absent).
export function createStreamSummaryAccumulator({ now = () => new Date().toISOString() } = {}) {
  const state = {
    stdout_chunk_count: 0, stdout_total_bytes: 0, stdout_first_event_at: null, stdout_last_event_at: null,
    stderr_chunk_count: 0, stderr_total_bytes: 0, stderr_first_event_at: null, stderr_last_event_at: null,
  };
  const observe = (stream, chunk) => {
    const at = String(now());
    const prefix = stream === 'stderr' ? 'stderr' : 'stdout';
    state[`${prefix}_chunk_count`] += 1;
    state[`${prefix}_total_bytes`] += Buffer.byteLength(String(chunk), 'utf8');
    state[`${prefix}_first_event_at`] ??= at;
    state[`${prefix}_last_event_at`] = at;
  };
  return Object.freeze({
    stdout: (chunk) => observe('stdout', chunk),
    stderr: (chunk) => observe('stderr', chunk),
    snapshot: () => Object.freeze({ ...state }),
  });
}
