import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_PATH_CHARS, MAX_EVIDENCE_CLAIM_CHARS } from './workspace-evidence-contract.mjs';

const text = () => ({ type: 'string', minLength: 1, pattern: '\\S' });
// agy registers this as a model tool schema. Gemini rejects arrays without
// items (20260907-10 canary: uncertainties.items missing). Council prompts
// already request string lists; constrain native generation to that shape.
// The downstream validator remains unchanged and deliberately broader.
const array = () => ({ type: 'array', items: { type: 'string' } });

// Upstream shape constraint only. Manifest membership and frozen hashes remain
// the authority of validateEvidence; no packet-dependent data enters this schema.
export function buildParticipantJsonSchema(stepKind, { workspaceRequirement } = {}) {
  let properties;
  if (stepKind === 'participant_report') properties = { type: { const: 'council_report' }, analysis: text(), recommendation: text(), risks: array(), uncertainties: array() };
  else if (stepKind === 'participant_critique') properties = { type: { const: 'council_critique' }, criticisms: array(), agreements: array(), revised_recommendation: text(), remaining_disagreements: array() };
  else if (stepKind === 'debate_response') properties = { type: { const: 'debate_response' }, response: text() };
  else throw new TypeError(`unsupported participant schema step: ${stepKind}`);
  if (workspaceRequirement === 'READ' && stepKind !== 'participant_critique') {
    properties.evidence = { type: 'array', minItems: 1, maxItems: MAX_EVIDENCE_ENTRIES, items: {
      type: 'object', required: ['path', 'sha256', 'claim'], properties: {
        // agy's Go regexp compiler rejects lookarounds. Native schema checks
        // shape only; validateEvidence remains authoritative for path safety.
        path: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE_PATH_CHARS },
        sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        claim: { ...text(), maxLength: MAX_EVIDENCE_CLAIM_CHARS },
        // Source accepts optional/null integers without range or positivity checks.
        line_start: { type: ['integer', 'null'] }, line_end: { type: ['integer', 'null'] },
      },
    } };
  }
  return { type: 'object', required: ['type', 'output', 'data'], properties: {
    type: { const: 'finish' }, output: text(), data: { type: 'object', required: Object.keys(properties), properties },
  } };
}

export function antigravityParticipantSchemaRequest(spec, profile) {
  if (profile.product !== 'antigravity' || spec.isImplementationParticipant === true || !['participant_report', 'participant_critique', 'debate_response'].includes(spec.stepKind)) return null;
  return { schema: buildParticipantJsonSchema(spec.stepKind, spec), kind: spec.stepKind, version: 1, provider: 'antigravity', mode: 'native_json_schema' };
}
