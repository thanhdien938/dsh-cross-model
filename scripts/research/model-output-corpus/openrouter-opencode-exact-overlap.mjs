// DSH MODEL OUTPUT CORPUS — OpenRouter × OpenCode EXACT overlap matcher.
//
// RESEARCH-ONLY tooling (closure PHASE 8). Deterministic, offline except the
// optional live OpenRouter catalogue snapshot (read-only GET, no invocation).
//
// EXACT OVERLAP RULE (closure task, PHASE 8):
//   A cross-connector overlap candidate requires evidence for
//     same provider/vendor identity
//     AND same model family
//     AND same explicit model/version.
//   Do not pair models solely because marketing names look similar.
//   If exact equivalence is unresolved: OVERLAP_IDENTITY_UNRESOLVED.
//
// Implementation: a name/version match alone is NEVER sufficient. The
// OpenCode catalogue record must carry explicit upstream vendor identity
// evidence naming the same vendor as the OpenRouter catalogue slug's vendor
// family. The current `opencode models --verbose` catalogue (models.dev
// cache) exposes NO upstream vendor field for the first-party `opencode-go`
// provider, so every name-level candidate is reported
// OVERLAP_IDENTITY_UNRESOLVED and no pair is invoked.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const OPENCODE_INVENTORY_PATH = join(CORPUS_ROOT, 'connector-inventory', 'opencode.json');
const OPENROUTER_INVENTORY_PATH = join(CORPUS_ROOT, 'connector-inventory', 'api-openrouter.json');
const REPORT_PATH = join(CORPUS_ROOT, 'reports', 'api-openrouter-opencode-overlap-supplement-report.md');
const JSON_PATH = join(CORPUS_ROOT, 'reports', 'api-openrouter-opencode-overlap-candidates.json');

const OPENROUTER_CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

// ---------------------------------------------------------------------------
// Deterministic matcher
// ---------------------------------------------------------------------------

/**
 * OpenRouter catalogue id -> { vendor, explicitModel } split at the FIRST '/'.
 * Route variants (":batch", ":free", ...) are stripped from the version part
 * and reported separately as route_variant.
 */
export function parseOpenRouterSlug(id) {
  const value = String(id ?? '');
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const vendor = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const colon = rest.indexOf(':');
  const explicitModel = colon === -1 ? rest : rest.slice(0, colon);
  const routeVariant = colon === -1 ? null : rest.slice(colon + 1);
  return { vendor, explicitModel, routeVariant };
}

/**
 * Exact-overlap evaluation for ONE opencode model against the OpenRouter
 * catalogue. Returns a decision record; never invents vendor identity.
 */
export function evaluateOverlapCandidate(opencodeModel, openrouterCatalogue, { coreVendorSlugs = [] } = {}) {
  const record = {
    opencode_slug: opencodeModel?.slug ?? null,
    opencode_model: opencodeModel?.id ?? null,
    opencode_provider_id: opencodeModel?.provider_id ?? null,
    opencode_invocation_eligible: Boolean(opencodeModel?.invocation_eligible),
    decision: null,
    reason: null,
    name_identity_matches: [],
  };

  if (!opencodeModel?.id || !opencodeModel?.provider_id) {
    return { ...record, decision: 'OVERLAP_SKIPPED_NO_OPENCODE_IDENTITY', reason: 'opencode catalogue record lacks model id / provider id' };
  }
  if (opencodeModel.cost_classification !== 'PAID_OR_STANDARD' || !opencodeModel.invocation_eligible) {
    return { ...record, decision: 'OVERLAP_SKIPPED_NOT_ELIGIBLE_OPENCODE', reason: `cost_classification=${opencodeModel.cost_classification} eligible=${opencodeModel.invocation_eligible}` };
  }

  // Name-level candidates: EXACT explicit model/version string equality with
  // a standard (non route-variant) OpenRouter text/chat slug.
  const candidates = [];
  for (const entry of openrouterCatalogue) {
    const parsed = parseOpenRouterSlug(entry?.id);
    if (!parsed || parsed.routeVariant) continue;
    if (parsed.explicitModel !== opencodeModel.id) continue;
    candidates.push({ id: entry.id, vendor: parsed.vendor, entry });
  }
  record.name_identity_matches = candidates.map((c) => c.id);

  if (candidates.length === 0) {
    return { ...record, decision: 'NO_NAME_IDENTITY_MATCH_ON_OPENROUTER', reason: 'no OpenRouter catalogue slug with the same explicit model/version string' };
  }

  // VENDOR IDENTITY EVIDENCE GATE — the rule's decisive leg. The OpenCode
  // catalogue record must explicitly name the upstream vendor, and it must
  // equal the OpenRouter vendor family. The current catalogue exposes no such
  // field, so name identity alone can never pass this gate.
  const opencodeVendorEvidence = opencodeModel.upstream_vendor_identity_evidence ?? null;
  const exact = opencodeVendorEvidence
    ? candidates.filter((c) => c.vendor === opencodeVendorEvidence.vendor)
    : [];
  if (!opencodeVendorEvidence) {
    return {
      ...record,
      decision: 'OVERLAP_IDENTITY_UNRESOLVED',
      reason: 'opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced)',
    };
  }
  if (exact.length === 0) {
    return { ...record, decision: 'OVERLAP_IDENTITY_UNRESOLVED', reason: `opencode vendor evidence '${opencodeVendorEvidence.vendor}' matches no OpenRouter vendor for this model` };
  }

  // CORE_VENDOR dedup: already sampled under the exact same model identity.
  const notInCoreVendor = exact.filter((c) => !coreVendorSlugs.includes(c.id));
  if (notInCoreVendor.length === 0) {
    return { ...record, decision: 'OVERLAP_SKIPPED_ALREADY_IN_CORE_VENDOR_BASELINE', reason: `exact identity ${exact.map((c) => c.id).join(', ')} already sampled in the OpenRouter CORE_VENDOR baseline` };
  }
  return {
    ...record,
    decision: 'OVERLAP_EXACT_IDENTITY_CONFIRMED',
    reason: `vendor evidence matches ${notInCoreVendor.map((c) => c.id).join(', ')}`,
    openrouter_exact_slugs: notInCoreVendor.map((c) => c.id),
  };
}

export function evaluateOverlapSet(opencodeInventory, openrouterCatalogue, { coreVendorSlugs = [] } = {}) {
  const decisions = (opencodeInventory?.models ?? []).map((model) => evaluateOverlapCandidate(model, openrouterCatalogue, { coreVendorSlugs }));
  const counts = {};
  for (const decision of decisions) counts[decision.decision] = (counts[decision.decision] ?? 0) + 1;
  return { decisions, counts };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function fetchCatalogue() {
  const response = await fetch(OPENROUTER_CATALOGUE_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`catalogue GET failed: HTTP ${response.status}`);
  const payload = await response.json();
  return payload.data ?? [];
}

async function main() {
  if (!existsSync(OPENCODE_INVENTORY_PATH)) throw new Error('opencode inventory missing');
  if (!existsSync(OPENROUTER_INVENTORY_PATH)) throw new Error('openrouter inventory missing');
  const opencodeInventory = JSON.parse(readFileSync(OPENCODE_INVENTORY_PATH, 'utf8'));
  const openrouterInventory = JSON.parse(readFileSync(OPENROUTER_INVENTORY_PATH, 'utf8'));
  const catalogue = await fetchCatalogue();
  const coreVendorSlugs = openrouterInventory.selected_models.map((m) => m.model_slug);

  const { decisions, counts } = evaluateOverlapSet(opencodeInventory, catalogue, { coreVendorSlugs });

  const exactConfirmed = decisions.filter((d) => d.decision === 'OVERLAP_EXACT_IDENTITY_CONFIRMED');
  const unresolved = decisions.filter((d) => d.decision === 'OVERLAP_IDENTITY_UNRESOLVED');
  const invocationsPlanned = exactConfirmed.length; // 1 baseline sample per configuration level would be derived later; identity count reported here

  const summary = {
    generated_utc: new Date().toISOString(),
    rule: 'same provider/vendor identity AND same model family AND same explicit model/version; name similarity alone is never sufficient',
    vendor_identity_gate: 'opencode catalogue record must carry explicit upstream_vendor_identity_evidence matching the OpenRouter vendor family; the current opencode-go catalogue exposes no such evidence',
    evaluated_opencode_models: decisions.length,
    counts,
    exact_overlap_models: exactConfirmed.map((d) => ({ opencode_slug: d.opencode_slug, openrouter_exact_slugs: d.openrouter_exact_slugs })),
    overlap_configurations: 0,
    overlap_invocations_planned: 0,
    note: 'no overlap invocation is performed while identity remains unresolved; OPENROUTER_EXACT_OVERLAP_MODELS counts only OVERLAP_EXACT_IDENTITY_CONFIRMED models',
    decisions,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const rows = decisions
    .filter((d) => d.decision !== 'OVERLAP_SKIPPED_NOT_ELIGIBLE_OPENCODE')
    .map((d) => `| ${d.opencode_slug} | ${d.name_identity_matches.join(', ') || 'none'} | ${d.decision} | ${d.reason} |`)
    .join('\n');

  const report = `# API/OpenRouter × OpenCode — EXACT OVERLAP SUPPLEMENT REPORT (closure PHASE 8)

- Generated: ${summary.generated_utc}
- Exact-overlap rule: same provider/vendor identity AND same model family AND same explicit model/version.
- Vendor-identity gate: the OpenCode catalogue record must carry explicit upstream vendor identity evidence naming the same vendor as the OpenRouter slug's vendor family.
- Decisions: \`${JSON.stringify(counts)}\`
- EXACT_OVERLAP_MODELS: ${exactConfirmed.length}
- OVERLAP_CONFIGURATIONS PLANNED: ${summary.overlap_configurations}
- OVERLAP_INVOCATIONS PERFORMED: 0

## Decision

NO pair was invoked. Every name-level candidate fails the vendor-identity
evidence gate: the first-party \`opencode-go\` catalogue (\`opencode models
--verbose\`, models.dev cache) exposes NO upstream vendor identity field, and
OpenRouter exposes no \`opencode\` vendor slug. Pairing on the model/version
name string alone would violate the exact-overlap rule ("do not pair models
solely because marketing names look similar"), so every such pair is recorded
as OVERLAP_IDENTITY_UNRESOLVED rather than invoked.

## Candidate decisions (eligible OpenCode models with any OpenRouter relevance)

| opencode slug | OpenRouter name-identity matches | decision | reason |
| --- | --- | --- | --- |
${rows}

## Policy attestations

- OVERLAP_IDENTITY_UNRESOLVED_PAIRS_INVOKED: 0
- PROVIDERS_INVOKED_FOR_OVERLAP: 0
- RAW_EVIDENCE_MODIFIED: NO
- CROSS_CONNECTOR_OUTPUT_COMPARISON_PERFORMED: NO (explicitly deferred to the matrix-analysis phase)
`;

  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`EXACT_OVERLAP_MODELS=${exactConfirmed.length}`);
  console.log(`OVERLAP_INVOCATIONS_PLANNED=${summary.overlap_invocations_planned}`);
  console.log(`DECISION_COUNTS=${JSON.stringify(counts)}`);
  console.log(`REPORT=${REPORT_PATH}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
