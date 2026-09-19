/**
 * Shared offline helpers for the P20.4 artifact-Council suites. Not a
 * *.test.mjs file, so it is never discovered as a test.
 */
import { fakeReportBackend } from './p20-report-helpers.mjs';
import { normalizeCouncilSpec } from '../../src/pm/council/council-contracts.mjs';
import { buildActorAliasRegistry } from '../../src/artifacts/artifact-paths.mjs';

export { withTempRoot, makeStore } from './p20-report-helpers.mjs';

export const COUNCIL_CREATED_AT = '2026-09-10T12:00:00Z';

/**
 * A per-profile deterministic report backend that echoes request identity
 * (so `assertReportBackendResultBinding` passes) and returns the configured
 * Markdown body. `plan` maps profileId -> { text | terminalState | ... } or a
 * `(ctx) => override` function; a `default` entry covers the rest.
 */
export function councilBackends({ product = 'fake', plan = {}, onPrompt = null } = {}) {
  const seen = [];
  const resolve = (profileId) => {
    const entry = typeof plan[profileId] === 'function'
      ? plan[profileId]
      : (plan[profileId] ?? plan.default ?? {});
    return {
      backend: product,
      async runReport(args) {
        const stage = args?.request?.stage ?? null;
        const cfg = typeof entry === 'function' ? (entry({ profileId, stage, request: args?.request }) ?? {}) : entry;
        seen.push({ profileId, stage, prompt: args?.prompt ?? null });
        if (onPrompt) onPrompt({ profileId, stage, prompt: args?.prompt ?? null });
        const text = cfg.text ?? `# ${stage} by ${profileId}\n\nDeterministic offline body for ${profileId}.\n`;
        const inner = fakeReportBackend({
          text,
          terminalState: cfg.terminalState,
          finishReason: cfg.finishReason,
          timedOut: cfg.timedOut,
          cancelled: cfg.cancelled,
          model: cfg.model ?? `${product}-1`,
          overrideBinding: cfg.overrideBinding ?? null,
        });
        return inner.runReport(args);
      },
    };
  };
  resolve.seen = seen;
  return resolve;
}

/** Normalize a Council spec for the offline suites (no knownProfileIds check). */
export function council(overrides = {}) {
  return normalizeCouncilSpec({
    chair_profile_id: 'live1-chair',
    participant_profile_ids: ['live1-alpha', 'live1-beta'],
    rounds: 1,
    ...overrides,
  });
}

/** Build the actor-alias registry for a Council spec's chair + participants. */
export function aliasRegistryFor(spec) {
  return buildActorAliasRegistry([spec.chair_profile_id, ...spec.participant_profile_ids]);
}
