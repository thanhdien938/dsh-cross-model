// P11-R0 — the `openai-chat` protocol adapter. This is the ONE seam that
// knows the OpenAI-compatible `/chat/completions` request/response shape;
// every provider (openrouter, deepseek, xcode-best) that declares
// `protocol: openai-chat` shares this exact code path (spec: "Provider !=
// protocol"). Nothing outside this file — not the PM parser, not the
// backend registry, not the adapter glue — ever parses a provider response
// body directly.
//
// NO SDK LOCK-IN (spec): built on Node's native `fetch`/`AbortController`,
// deliberately not an OpenAI SDK — gives DSH explicit request control, real
// AbortSignal cancellation, no hidden SDK-level retries that would distort
// DSH's own bounded "one request, one result" policy for R0, and trivial
// testing against a local fake HTTP server (no SDK transport to mock).
import { ApiBackendError, API_ERROR_CODES, mapHttpStatusToApiErrorCode } from './api-backend-errors.mjs';
import { redactHeaders, safeProviderDetail } from './api-redaction.mjs';
// PARSER-0 Goal F: safe request-phase facts — an additive diagnostic enum
// (FETCH / RESPONSE_BODY_READ / HTTP_STATUS / RESPONSE_JSON_DECODE /
// ASSISTANT_EXTRACTION) carried beside the UNCHANGED public error codes so a
// response-body abort is never indistinguishable from a connect/fetch
// failure. Never adds a timeout, never touches AbortSignal ownership, retry
// policy or request semantics.
import { PARSER_0_REQUEST_PHASES } from '../parser-0-diagnostics.mjs';

const CHAT_COMPLETIONS_PATH = '/chat/completions';
const PHASE = Object.freeze({
  FETCH: PARSER_0_REQUEST_PHASES[0],
  RESPONSE_BODY_READ: PARSER_0_REQUEST_PHASES[1],
  HTTP_STATUS: PARSER_0_REQUEST_PHASES[2],
  RESPONSE_JSON_DECODE: PARSER_0_REQUEST_PHASES[3],
  ASSISTANT_EXTRACTION: PARSER_0_REQUEST_PHASES[4],
});

function buildRequestBody({ model, messages, extra }) {
  return { model, messages, stream: false, ...(extra && typeof extra === 'object' ? extra : {}) };
}

// Extracts the normalized assistant text + safe provenance from a parsed
// OpenAI-compatible chat-completion response body. Throws typed
// RESPONSE_INVALID/EMPTY_RESPONSE — never returns an ambiguous shape for a
// caller to misinterpret.
export function normalizeChatCompletionResponse(body) {
  if (!body || typeof body !== 'object') throw new ApiBackendError('provider response was not a JSON object', API_ERROR_CODES.RESPONSE_INVALID, { requestPhase: PHASE.ASSISTANT_EXTRACTION });
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const text = choice?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') throw new ApiBackendError('provider returned no usable assistant content', API_ERROR_CODES.EMPTY_RESPONSE, { finishReason: choice?.finish_reason ?? null, requestPhase: PHASE.ASSISTANT_EXTRACTION });
  const usageRaw = body.usage && typeof body.usage === 'object' ? body.usage : null;
  const usage = usageRaw
    ? Object.freeze({
        input_tokens: numberOrUnknown(usageRaw.prompt_tokens),
        output_tokens: numberOrUnknown(usageRaw.completion_tokens),
        cached_tokens: numberOrUnknown(usageRaw.prompt_tokens_details?.cached_tokens),
        total_tokens: numberOrUnknown(usageRaw.total_tokens),
      })
    : Object.freeze({ input_tokens: 'UNKNOWN', output_tokens: 'UNKNOWN', cached_tokens: 'UNKNOWN', total_tokens: 'UNKNOWN' });
  return Object.freeze({
    text,
    // Provenance only — never rewrites the PM profile's own canonical
    // model identity (spec "MODEL SECURITY": "If actual returned model
    // metadata differs materially from configured model: record it. Do
    // not silently rewrite canonical PM identity.").
    returnedModel: typeof body.model === 'string' ? body.model : null,
    requestId: typeof body.id === 'string' ? body.id : null,
    finishReason: choice?.finish_reason ?? null,
    usage,
  });
}
function numberOrUnknown(value) {
  return Number.isFinite(value) ? value : 'UNKNOWN';
}

// Sends one non-streaming chat-completion request and returns the
// normalized result, or throws a typed ApiBackendError. `signal` (an
// AbortSignal) is the caller's ONE cancellation/timeout seam — this
// function never starts its own timer (that lives in api-backend-adapter.mjs,
// tied to the existing executionOptions.timeoutMs — spec "SECOND TIMEOUT
// ARCHITECTURE: NO").
export async function sendOpenAiChatCompletion({ baseUrl, apiKey, model, messages, headers = {}, extra, fetchImpl = fetch, signal }) {
  const url = `${baseUrl}${CHAT_COMPLETIONS_PATH}`;
  const requestHeaders = { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const requestBody = buildRequestBody({ model, messages, extra });
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(requestBody), signal });
  } catch (cause) {
    // Fetch-level truth only: "this request was aborted". WHY it was
    // aborted (owner cancel vs the adapter's own executionOptions.timeoutMs
    // firing) is known one layer up, in api-backend-adapter.mjs, which
    // re-labels this to API_TIMEOUT when its own timeout timer fired —
    // never guessed here from the AbortSignal alone.
    if (cause?.name === 'AbortError') throw new ApiBackendError('API request was aborted', API_ERROR_CODES.CANCELLED, { requestPhase: PHASE.FETCH });
    // Any other fetch-level throw is DNS/TLS/connection-reset/refused —
    // never surfaced with the raw cause (which can carry the request URL
    // including query strings; the base_url itself is not secret, but we
    // never assume a fetch implementation's error text is safe).
    throw new ApiBackendError('network error contacting API provider', API_ERROR_CODES.NETWORK_ERROR, { providerDetail: safeProviderDetail(String(cause?.message ?? cause), { secrets: [apiKey] }), requestPhase: PHASE.FETCH });
  }
  // PARSER-0 Goal F: the body read is its OWN phase. Before this wrap, a
  // read/abort failure here escaped as a generic transport failure one layer
  // up — diagnostically indistinguishable from the initial connect. The
  // public error code is deliberately UNCHANGED (the historical body-abort
  // corpus class surfaced as API_NETWORK_ERROR and still does); only the
  // additive typed phase fact is new. No new timeout, no AbortSignal change.
  let rawBody;
  try {
    rawBody = await response.text();
  } catch (cause) {
    throw new ApiBackendError('network error reading API provider response body', API_ERROR_CODES.NETWORK_ERROR, { requestPhase: PHASE.RESPONSE_BODY_READ, aborted: cause?.name === 'AbortError', providerDetail: safeProviderDetail(String(cause?.message ?? cause), { secrets: [apiKey] }) });
  }
  if (!response.ok) {
    const detail = safeProviderDetail(extractErrorMessage(rawBody) ?? rawBody, { secrets: [apiKey] });
    throw new ApiBackendError(`API provider returned HTTP ${response.status}`, mapHttpStatusToApiErrorCode(response.status), { httpStatus: response.status, providerDetail: detail, requestHeaders: redactHeaders(requestHeaders), requestPhase: PHASE.HTTP_STATUS });
  }
  let parsed;
  try {
    parsed = rawBody.trim() === '' ? null : JSON.parse(rawBody);
  } catch {
    throw new ApiBackendError('provider response was not valid JSON', API_ERROR_CODES.RESPONSE_INVALID, { providerDetail: safeProviderDetail(rawBody, { secrets: [apiKey], maxLength: 200 }), requestPhase: PHASE.RESPONSE_JSON_DECODE });
  }
  if (parsed === null) throw new ApiBackendError('provider returned an empty response body', API_ERROR_CODES.EMPTY_RESPONSE, { requestPhase: PHASE.RESPONSE_JSON_DECODE });
  return Object.freeze({ ...normalizeChatCompletionResponse(parsed), httpStatus: response.status, requestFields: Object.freeze(Object.keys(requestBody).sort()) });
}

function extractErrorMessage(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    return typeof parsed?.error?.message === 'string' ? parsed.error.message : typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
}
