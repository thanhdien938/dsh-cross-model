import { ANTIGRAVITY_DEFAULT_TIMEOUT_MS } from '../session/antigravity-cli-session-bridge.mjs';
import { GROK_CLI_DEFAULT_TIMEOUT_MS } from '../session/grok-cli-session-bridge.mjs';

// Explicit production authority for artifact report executions. Production
// timeout is a safety ceiling, not a target execution duration. P23.5 widens
// only the production ceilings for the three Council products; generic bridge
// defaults remain independently usable by tests and non-production callers.
export const PRODUCTION_REPORT_BACKEND_TIMEOUT_MS = Object.freeze({
  'claude-code': 360_000,
  codex: 540_000,
  opencode: 540_000,
  antigravity: ANTIGRAVITY_DEFAULT_TIMEOUT_MS,
  grok: GROK_CLI_DEFAULT_TIMEOUT_MS,
});

export function assertReportBackendTimeoutPolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('report backend timeout policy is required');
  for (const product of Object.keys(PRODUCTION_REPORT_BACKEND_TIMEOUT_MS)) {
    if (!Number.isInteger(policy[product]) || policy[product] <= 0) {
      throw new TypeError(`report backend timeout policy for ${product} must be a positive integer`);
    }
  }
  return policy;
}
