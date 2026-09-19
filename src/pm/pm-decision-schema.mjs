const NON_EMPTY_STRING = Object.freeze({ type: 'string', minLength: 1 });

export const PM_DECISION_SCHEMA_KIND = 'pm_decision';
export const PM_DECISION_SCHEMA_VERSION = 1;

/** Native Claude transport schema; normalizePmDecision remains authoritative. */
export function buildPmDecisionJsonSchema(capabilities) {
  const allowed = new Set(Array.isArray(capabilities) && capabilities.length
    ? capabilities
    : ['workflow', 'peer_exchange', 'finish', 'await_owner']);
  const variants = [];
  if (allowed.has('finish')) variants.push({
    type: 'object', properties: { type: { type: 'string', enum: ['finish'] }, output: NON_EMPTY_STRING, data: { type: 'object' } }, required: ['type', 'output'],
  });
  if (allowed.has('workflow')) variants.push({
    type: 'object', properties: { type: { type: 'string', enum: ['workflow'] }, spec: { type: 'object' } }, required: ['type', 'spec'],
  });
  if (allowed.has('peer_exchange')) variants.push({
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['peer_exchange'] },
      routes: { type: 'array', minItems: 1, items: { type: 'object', properties: { from: NON_EMPTY_STRING, to: NON_EMPTY_STRING }, required: ['from', 'to'] } },
      body: NON_EMPTY_STRING,
    },
    required: ['type', 'routes', 'body'],
  });
  if (allowed.has('await_owner')) variants.push({
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['await_owner'] }, kind: { type: 'string', enum: ['QUESTION', 'APPROVAL'] }, title: NON_EMPTY_STRING, prompt: NON_EMPTY_STRING,
      allowedResponses: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' } },
    },
    required: ['type', 'kind', 'title', 'prompt', 'allowedResponses'],
  });
  return Object.freeze({ oneOf: variants });
}
