/**
 * P20.2 — API report transport (report CONTENT plane, not the control plane).
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §9, §10, §16, §23.
 *
 * This is a NEW function beside `runApiBackendRequest` — it does not change
 * legacy API decision behaviour. `runApiBackendRequest` returns only the
 * assistant text string; the report path needs the FULL envelope:
 *   - `choice.message.content` VERBATIM (normalizeChatCompletionResponse
 *     never trims it — it only checks emptiness);
 *   - `finish_reason` preserved (a `length`/`max_tokens` finish is
 *     TRUNCATED_OR_INCOMPLETE, never a complete report success);
 *   - safe usage metadata.
 * No hidden reasoning, no tool-call JSON, no protocol wrappers reach the
 * report bytes (§11). Fully exercisable offline with a fake `fetchImpl`.
 */

import { getProviderConfig, resolveApiKey } from './api-provider-config.mjs';
import { capabilitiesForProvider } from './api-provider-capabilities.mjs';
import { translateReasoningForProvider } from './api-reasoning-translation.mjs';
import { sendOpenAiChatCompletion } from './api-openai-chat-protocol.mjs';
import { ApiBackendError, API_ERROR_CODES } from './api-backend-errors.mjs';
import {
  buildReportBackendResult,
  mapChatCompletionFinishReason,
  VISIBLE_OUTPUT_SOURCE,
  TERMINAL_STATE,
} from '../report-backend-result.mjs';

/**
 * @param {object} input
 * @param {string} input.providerId
 * @param {string} [input.model]
 * @param {string} [input.reasoning]
 * @param {string} [input.modelReasoningSupport]
 * @param {string} input.prompt
 * @param {string} input.profileId
 * @param {string} input.executionId
 * @param {object} [input.providers]
 * @param {object} [input.env]
 * @param {Function} [input.fetchImpl]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.externalSignal]
 * @returns {Promise<import('../report-backend-result.mjs').ReportBackendResult>}
 */
export async function runApiReportRequest({
  providerId, model, reasoning, modelReasoningSupport = 'UNKNOWN',
  prompt, profileId, executionId,
  providers = {}, env = process.env, fetchImpl = fetch,
  timeoutMs, externalSignal,
} = {}) {
  if (!providerId) throw new ApiBackendError('API report profile is missing provider identity', API_ERROR_CODES.PROVIDER_CONFIG_INVALID);
  const providerEntry = getProviderConfig(providers, providerId);
  const apiKey = resolveApiKey(providerEntry, env);
  const capabilities = modelReasoningSupport === 'SUPPORTED'
    ? { ...capabilitiesForProvider(providerId), supports_reasoning_effort: true }
    : capabilitiesForProvider(providerId);
  const extra = translateReasoningForProvider(providerId, capabilities, reasoning ?? null, model);
  const messages = [{ role: 'user', content: prompt }];

  const controller = new AbortController();
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort);

  const startedAt = Date.now();
  const common = { backend: 'api', profileId, model: model ?? null, executionId };

  try {
    const res = await sendOpenAiChatCompletion({
      baseUrl: providerEntry.baseUrl, apiKey, model, messages,
      headers: providerEntry.headers, extra, fetchImpl, signal: controller.signal,
    });
    const terminalState = mapChatCompletionFinishReason(res.finishReason);
    return buildReportBackendResult({
      ...common,
      terminalState,
      providerFinishReason: res.finishReason ?? null,
      durationMs: Date.now() - startedAt,
      // VERBATIM: the exact bytes the provider marked as visible assistant content.
      acceptedVisibleText: terminalState === TERMINAL_STATE.SUCCESS || terminalState === TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE ? res.text : null,
      visibleOutputSource: VISIBLE_OUTPUT_SOURCE.API_CHAT_CONTENT,
      usage: res.usage ?? null,
      safeDiagnostics: { returned_model: res.returnedModel ?? null, http_status: res.httpStatus ?? null, request_fields: res.requestFields ?? null },
    });
  } catch (error) {
    let terminalState = TERMINAL_STATE.PROVIDER_ERROR;
    let cancelled = false;
    if (error instanceof ApiBackendError) {
      if (error.code === API_ERROR_CODES.CANCELLED) {
        terminalState = timedOut ? TERMINAL_STATE.TIMEOUT : TERMINAL_STATE.CANCELLED;
        cancelled = !timedOut;
      } else if (error.code === API_ERROR_CODES.TIMEOUT) {
        terminalState = TERMINAL_STATE.TIMEOUT;
      } else if (error.code === API_ERROR_CODES.EMPTY_RESPONSE) {
        terminalState = TERMINAL_STATE.UNKNOWN_OUTCOME;
      } else {
        terminalState = TERMINAL_STATE.PROVIDER_ERROR;
      }
    } else {
      terminalState = TERMINAL_STATE.PROCESS_ERROR;
    }
    return buildReportBackendResult({
      ...common,
      terminalState,
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      providerFinishReason: error?.finishReason ?? null,
      acceptedVisibleText: null,
      visibleOutputSource: VISIBLE_OUTPUT_SOURCE.API_CHAT_CONTENT,
      safeDiagnostics: { error_code: error?.code ?? null },
    });
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

/**
 * A `reportBackend` adapter usable by ReportInvoker for the `api` product.
 *
 * P22.4 §D: `api` has no local filesystem, so its production route
 * (production-backend-capabilities.mjs) is VERBATIM_MATERIALIZATION only —
 * `directWriter`/DIRECT_WRITE are never set here, and council-chair-
 * driver.mjs/council-artifact-orchestrator.mjs's `reportBackend.
 * deliveryMechanism ?? 'VERBATIM_MATERIALIZATION'` fallback already treats
 * an object without this field as VERBATIM_MATERIALIZATION — this explicit
 * field is documentation, not new behavior.
 *
 * `supportsDebateTypedControl` is deliberately left unset: `api` is
 * SUPPORTED_SINGLE_ONLY by permanent product policy (P22.5 — see
 * production-backend-capabilities.mjs's API_MULTI_AGENT_POLICY_GUIDANCE),
 * not a backend with an unbuilt control channel awaiting a future adapter.
 * `resolveDebateTypedControlStatus()` (debate-backend-capability.mjs)
 * correctly reports UNPROVEN here (no channel exists, and none is
 * planned); `assertBackendTaskModeSupported('api', TASK_MODE.DEBATE_CHAIR)`
 * additionally rejects `api` at Council/Debate admission before this is
 * ever reached, with a clear product-policy explanation rather than a
 * PROVEN/UNPROVEN one.
 */
export function createApiReportBackend(opts = {}) {
  return {
    backend: 'api',
    deliveryMechanism: 'VERBATIM_MATERIALIZATION',
    async runReport({ prompt, request }) {
      return runApiReportRequest({
        providerId: opts.providerId ?? request.providerId,
        model: opts.model ?? request.model,
        reasoning: opts.reasoning ?? request.reasoning,
        modelReasoningSupport: opts.modelReasoningSupport,
        prompt,
        profileId: request.profileId,
        executionId: request.executionId,
        providers: opts.providers,
        env: opts.env,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs ?? request.timeoutMs,
        externalSignal: opts.externalSignal ?? request.signal,
      });
    },
  };
}
