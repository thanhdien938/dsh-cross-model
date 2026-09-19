// P11-R0 — the API backend's transport call. This is the ONE function the
// `api` product's registration in production-pm-backend-registry.mjs calls
// from inside its `run(prompt,{ctx,timeoutMs})` closure — the SAME
// `createCliPmDriver()` contract every existing CLI backend already uses.
// Nothing downstream of this file (parseDecision(), normalizePmDecision(),
// council/single workflow, Telegram/Desktop, materializer) is aware an
// HTTP call happened at all — it receives the exact same normalized
// assistant-text string a CLI backend's `run()` closure returns.
//
// Deliberately takes plain, explicit parameters (providerId/model/
// reasoning/prompt/...) rather than reading them off `ctx` — `ctx` is
// documented, in production-pm-backend-registry.mjs, as an observability-
// correlation object; every existing backend's run() closure instead reads
// `profile.*` directly from its own createCliPmDriver()-factory closure
// scope, and this mirrors that exactly (see the `api` registration block).
import { getProviderConfig, resolveApiKey } from './api-provider-config.mjs';
import { capabilitiesForProvider } from './api-provider-capabilities.mjs';
import { translateReasoningForProvider } from './api-reasoning-translation.mjs';
import { sendOpenAiChatCompletion } from './api-openai-chat-protocol.mjs';
import { ApiBackendError, API_ERROR_CODES } from './api-backend-errors.mjs';

// `providers`: the frozen `{[providerId]:entry}` map from
// api-provider-config.mjs (`{}` — no providers configured — is a common,
// valid default). `env`/`fetchImpl` are DI seams (production default:
// `process.env`/global `fetch`; tests inject fakes). `observe`, if given,
// is called as `observe(method, payload)` for additive, non-authoritative
// diagnostics — any throw from it is swallowed, never allowed to fail the
// real request (same B4 defense-in-depth convention as the rest of this
// registry).
export async function runApiBackendRequest({ providerId, model, reasoning, modelReasoningSupport = 'UNKNOWN', prompt, providers = {}, env = process.env, fetchImpl = fetch, timeoutMs, externalSignal, observe } = {}) {
  if (!providerId) throw new ApiBackendError('API PM profile is missing provider identity', API_ERROR_CODES.PROVIDER_CONFIG_INVALID);
  // Config/secret resolution happens BEFORE any network I/O — a missing
  // provider config or missing key fails closed here, never mid-request
  // (spec: "fail before HTTP request with API_SECRET_MISSING").
  const providerEntry = getProviderConfig(providers, providerId);
  const apiKey = resolveApiKey(providerEntry, env);
  const capabilities = modelReasoningSupport === 'SUPPORTED' ? { ...capabilitiesForProvider(providerId), supports_reasoning_effort: true } : capabilitiesForProvider(providerId);
  const extra = translateReasoningForProvider(providerId, capabilities, reasoning ?? null, model);
  const messages = [{ role: 'user', content: prompt }];

  // Local-transport-level cancellation/timeout ONLY — reuses the exact same
  // `timeoutMs` the existing executionOptions/runtime-class policy already
  // resolved (pm-execution-timeout-policy.mjs); never a second, independent
  // `apiTimeoutMs` deadline (spec "SECOND TIMEOUT ARCHITECTURE: NO"). An
  // externally supplied `externalSignal` (future owner-cancel wiring — no
  // existing backend's run() receives one today, so this is optional/
  // forward-compatible, not a regression) is forwarded into the same
  // controller so ONE abort reason wins.
  const controller = new AbortController();
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort);
  const startedAt = Date.now();
  try {
    const result = await sendOpenAiChatCompletion({ baseUrl: providerEntry.baseUrl, apiKey, model, messages, headers: providerEntry.headers, extra, fetchImpl, signal: controller.signal });
    safeObserve(observe, 'apiUsage', { provider: providerId, requestedModel: model, returnedModel: result.returnedModel, httpStatus: result.httpStatus, requestId: result.requestId, usage: result.usage, requestFields: result.requestFields, durationMs: Date.now() - startedAt, streaming: false });
    return result.text;
  } catch (error) {
    // Re-label a CANCELLED thrown by the protocol layer to TIMEOUT when OUR
    // OWN timer fired it — this is the only place that knows why the
    // controller aborted. A genuinely external cancel (owner-initiated,
    // once wired) keeps the honest API_CANCELLED code.
    if (error instanceof ApiBackendError && error.code === API_ERROR_CODES.CANCELLED && timedOut) {
      throw new ApiBackendError('API request exceeded the task execution deadline', API_ERROR_CODES.TIMEOUT, { provider: providerId, timeoutMs: timeoutMs ?? null, elapsedMs: Date.now() - startedAt, terminationRequestedByDsh: true, assistantOutputPresent: false, requestPhase: error.requestPhase ?? null });
    }
    if (error instanceof ApiBackendError) throw error;
    throw new ApiBackendError('unexpected API backend transport failure', API_ERROR_CODES.NETWORK_ERROR, { provider: providerId, cause: error?.message ?? String(error) });
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

function safeObserve(observe, method, payload) {
  try {
    observe?.(method, payload);
  } catch {
    /* non-authoritative diagnostics only — never fail the real request */
  }
}
