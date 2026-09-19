import { BACKEND_FAILURE_CLASSIFICATION } from './backend-health-registry.mjs';

function flattenError(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name} ${error.message} ${error.code ?? ''}`;
  if (typeof error === 'object') {
    const parts = [
      error.name,
      error.message,
      error.code,
      error.status,
      error.statusCode,
      error.cause?.name,
      error.cause?.message,
      error.cause?.code,
    ].filter((value) => value !== undefined && value !== null);
    try { parts.push(JSON.stringify(error)); } catch {}
    return parts.join(' ');
  }
  return String(error);
}

const RULES = Object.freeze([
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.AUTH,
    test: (text) => /\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|credential(?:s)?\s+(?:missing|invalid|expired)|invalid\s+(?:api[- ]?key|token)/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
    test: (text) => /\b429\b|rate[- ]?limit|too many requests|quota\s+(?:exceeded|throttl)|throttl(?:e|ed|ing)/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
    test: (text) => /\b50[0234]\b|service temporarily unavailable|service unavailable|upstream unavailable|bad gateway|gateway timeout/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
    test: (text) => /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed?\s*out|timeout(?:error)?/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
    test: (text) => /\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|socket hang up|network(?:ing)? error|connection reset|connection refused/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.CONFIG,
    test: (text) => /\bENOENT\b|executable\s+(?:not found|missing)|command not found|missing configuration|configuration missing|config(?:uration)? error|no api key|missing api key/i.test(text),
  },
  {
    classification: BACKEND_FAILURE_CLASSIFICATION.PROTOCOL,
    test: (text) => /protocol error|json[- ]?rpc|invalid (?:json|response|schema)|malformed (?:json|response)|framing error|unexpected protocol|schema validation/i.test(text),
  },
]);

export function classifyExecutionFailure(error) {
  const diagnostic = flattenError(error).slice(0, 500);
  for (const rule of RULES) {
    if (rule.test(diagnostic)) {
      return Object.freeze({
        classification: rule.classification,
        diagnostic,
        recognized: true,
      });
    }
  }
  return Object.freeze({ classification: null, diagnostic, recognized: false });
}
