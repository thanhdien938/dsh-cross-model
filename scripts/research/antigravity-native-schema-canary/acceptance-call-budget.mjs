// Fixed two-participant, one-debate-round READ Council. Production policy
// council-step-workflow-runner: MAX_PARSE_ATTEMPTS=2; one chair-plan
// participant-key repair; one semantic repair per read-only participant stage.
export const BASELINE_CALLS = 1 + 2 + 2 + 1 + 1 + 2 + 1;
export const MAX_PARSE_ATTEMPTS = 2;
export const REPAIR_ELIGIBLE_STAGES = 1 + 2 * 3;
export const MAX_ALLOWED_RETRY_RESERVE = BASELINE_CALLS * (MAX_PARSE_ATTEMPTS - 1)
  + REPAIR_ELIGIBLE_STAGES * MAX_PARSE_ATTEMPTS;
export const MAX_ORIGINAL_GENERATIONS = BASELINE_CALLS + MAX_ALLOWED_RETRY_RESERVE;
// Every original attempt (including a repair generation) can need one format
// call. Successful canonicalization suppresses parse retry; the ceiling is
// reachable when first attempts fail normalization and second attempts pass.
export const MAX_CANONICALIZER_CALLS = MAX_ORIGINAL_GENERATIONS;
export const ACCEPTANCE_CALL_BUDGET = MAX_ORIGINAL_GENERATIONS + MAX_CANONICALIZER_CALLS;
