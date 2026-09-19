// DSH Antigravity native-JSON-schema acceptance canary — research harness.
//
// ONE production-path Antigravity invocation, exactly: the real
// CouncilStepWorkflowRunner drives the real ProductionPmBackendRegistry /
// antigravity bridge / --json-schema path / PARSER-0 diagnostics, and a
// budget guard converts any would-be second provider call (parse retry or
// semantic repair) into a typed LOCAL error with no provider invocation.
// Offline preflight mode: `node run-canary.mjs --preflight-only`.
// No production source is modified by this harness.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import assert from 'node:assert/strict';

import { PmProfileRegistry } from '../../../src/pm/pm-profile-registry.mjs';
import { ProductionPmBackendRegistry } from '../../../src/pm/production-pm-backend-registry.mjs';
import { antigravityParticipantSchemaRequest, buildParticipantJsonSchema } from '../../../src/pm/council/participant-json-schema.mjs';
import { CouncilStepWorkflowRunner } from '../../../src/pm/council/council-step-workflow-runner.mjs';
import { normalizePmDecision } from '../../../src/pm/pm-contracts.mjs';
import { createPmRequest } from '../../../src/pm/pm-contracts.mjs';
import { resolveExecutionOptions, executionStageForCouncilStep, EXECUTION_STAGE } from '../../../src/pm/pm-execution-timeout-policy.mjs';
import { resolveAntigravityExecutable } from '../../../src/session/antigravity-cli-session-bridge.mjs';
import { createBackendExecutionObserver } from '../../../src/runtime/backend-execution-observer.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CANARY_PROFILE_ID = 'live1-antigravity-gemini-3-8-flash-high';
export const TARGET_STEP = 'participant_critique';
const LIVE_RUNTIME_DIR = process.env.DSH_CANARY_RUNTIME_DIR ?? join(process.cwd(), '.runtime', 'live1');

export const CANARY_PROMPT = [
  'Council critique step (read-only, no tools required).',
  'The plan under critique is: "Adopt a single shared markdown checklist as the team status-tracking artifact for the next two weeks."',
  'Provide your critique of this plan: list criticisms, agreements, one revised recommendation, and any remaining disagreements.',
].join(' ');

// Preflight items 1-12: static, content-free, provider-free.
export function preflight({ runtimeDir = LIVE_RUNTIME_DIR } = {}) {
  const record = { checks: {}, canary_profile_id: CANARY_PROFILE_ID, target_step: TARGET_STEP };
  // 1. target profile resolves to Antigravity from the LIVE registry.
  const doc = parse(readFileSync(join(runtimeDir, 'pm-profiles.yaml'), 'utf8'));
  const registry = new PmProfileRegistry(doc.pm_profiles);
  const profile = registry.get(CANARY_PROFILE_ID);
  record.checks.profile_resolves = profile.product === 'antigravity' && profile.status === 'ACTIVE';
  record.profile = { product: profile.product, transport: profile.transport, session_kind: profile.session_kind, model: profile.model, reasoning: profile.reasoning, status: profile.status };
  // 2-6. production structured-output policy selects native schema.
  const spec = canarySpec();
  const structuredOutputRequest = antigravityParticipantSchemaRequest(spec, profile);
  record.checks.participant_critique_schema_eligible = structuredOutputRequest !== null;
  record.checks.is_implementation_participant = spec.isImplementationParticipant;
  record.checks.structured_output_request_non_null = structuredOutputRequest != null;
  record.checks.schema_provider = structuredOutputRequest?.provider ?? null;
  record.checks.schema_mode = structuredOutputRequest?.mode ?? null;
  record.structured_output_kind = structuredOutputRequest?.kind ?? null;
  record.structured_output_version = structuredOutputRequest?.version ?? null;
  // 7-10. schema shape proof.
  const schema = structuredOutputRequest?.schema ?? null;
  if (schema) {
    const schemaJson = JSON.stringify(schema);
    record.checks.schema_outer_required_type_output_data = Array.isArray(schema.required) && ['type', 'output', 'data'].every((k) => schema.required.includes(k));
    const critiqueRequired = schema.properties?.data?.required ?? [];
    record.checks.schema_data_required_fields = ['type', 'criticisms', 'agreements', 'revised_recommendation', 'remaining_disagreements'].every((k) => critiqueRequired.includes(k));
    record.checks.schema_data_type_const = schema.properties?.data?.properties?.type?.const ?? null;
    const arrayFields = ['criticisms', 'agreements', 'remaining_disagreements'];
    record.checks.all_array_fields_have_string_items = arrayFields.every((f) => schema.properties?.data?.properties?.[f]?.type === 'array' && schema.properties?.data?.properties?.[f]?.items?.type === 'string');
    record.checks.no_lookaround_regexp = !/\(\?[=!<>]/.test(schemaJson);
    record.schema_bytes = Buffer.byteLength(schemaJson, 'utf8');
    record.schema_serializable_within_cli_bound = record.schema_bytes <= 16384;
    record.schema_native_evidence_array_absent = schema.properties?.data?.properties?.evidence === undefined;
    assert.equal(record.checks.schema_outer_required_type_output_data, true);
    assert.equal(record.checks.schema_data_required_fields, true);
    assert.equal(record.checks.all_array_fields_have_string_items, true);
    assert.equal(record.checks.no_lookaround_regexp, true);
  }
  // 11. the bridge really forwards the schema through --json-schema.
  const bridgeSource = readFileSync(join(ROOT, 'src/session/antigravity-cli-session-bridge.mjs'), 'utf8');
  record.checks.bridge_forwards_json_schema_flag = bridgeSource.includes(`'--json-schema',schemaPath`) && bridgeSource.includes('structuredOutputSchema');
  const registrySource = readFileSync(join(ROOT, 'src/pm/production-pm-backend-registry.mjs'), 'utf8');
  record.checks.registry_passes_schema_to_antigravity_runner = registrySource.includes('...(structuredOutputSchema?{structuredOutputSchema}:{})');
  // 12. exactly one live provider invocation:
  //     - createCliPmDriver performs exactly ONE run() per decide();
  //     - the only in-driver re-invocation (await_owner repair) is gated to
  //       the OWNER_SINGLE stage, which a council critique step never has;
  //     - the runner's parse retry (MAX_PARSE_ATTEMPTS=2) and semantic
  //       repair would call decide() again — the canary budget guard
  //       intercepts any second call locally with zero provider invocation.
  record.checks.await_owner_repair_absent_for_council_stage = executionStageForCouncilStep(TARGET_STEP, { longWorkspaceRead: false }) !== EXECUTION_STAGE.OWNER_SINGLE;
  record.checks.single_invocation_guard = 'BUDGET_WRAPPER_SECOND_CALL_THROWS_LOCAL_TYPED_ERROR';
  record.execution_stage = executionStageForCouncilStep(TARGET_STEP, { longWorkspaceRead: false });
  record.execution_options_timeout_ms = resolveExecutionOptions(record.execution_stage, { executionCapable: false })?.timeoutMs ?? null;
  record.binary_resolution = resolveAntigravityExecutable().available === true ? { available: true, source: 'LOCAL_VERSION_PROBE_ONLY' } : { available: false };
  const allPass = Object.values(record.checks).every((v) => v === true || v === false || typeof v === 'string');
  record.preflight_pass = Object.entries(record.checks).every(([k, v]) => (typeof v === 'boolean' ? v === expectedTrue(k) : true));
  return record;
}
const EXPECTED_TRUE = new Set(['profile_resolves', 'participant_critique_schema_eligible', 'structured_output_request_non_null', 'schema_outer_required_type_output_data', 'schema_data_required_fields', 'all_array_fields_have_string_items', 'no_lookaround_regexp', 'bridge_forwards_json_schema_flag', 'registry_passes_schema_to_antigravity_runner', 'await_owner_repair_absent_for_council_stage']);
const expectedTrue = (key) => EXPECTED_TRUE.has(key);

export function canarySpec() {
  return {
    id: 'canary:participant_critique:0',
    kind: 'council_step',
    stepKind: TARGET_STEP,
    round: 1,
    profileId: CANARY_PROFILE_ID,
    prompt: CANARY_PROMPT,
    participantProfileIds: [CANARY_PROFILE_ID],
    isImplementationParticipant: false,
  };
}

// ONE live provider invocation, guarded. Returns a sanitized record.
export async function runCanary({ runtimeDir = LIVE_RUNTIME_DIR, artifactPath = null, antigravityRunner, onDiagnostic = () => {} } = {}) {
  const preflightRecord = preflight({ runtimeDir });
  if (!preflightRecord.preflight_pass || preflightRecord.binary_resolution.available !== true) {
    return { preflight: preflightRecord, invoked: false, stop_reason: 'ANTIGRAVITY_NATIVE_SCHEMA_PREFLIGHT_FAILED' };
  }
  const doc = parse(readFileSync(join(runtimeDir, 'pm-profiles.yaml'), 'utf8'));
  const profileRegistry = new PmProfileRegistry(doc.pm_profiles);
  const profile = profileRegistry.get(CANARY_PROFILE_ID);

  const backendEvents = [];
  const observer = createBackendExecutionObserver({ emit: (event) => backendEvents.push(event) });
  const backendRegistry = new ProductionPmBackendRegistry({
    observer,
    ...(antigravityRunner ? { antigravityRunner } : {}),
    antigravityBinary: resolveAntigravityExecutable().path ?? '',
    claudeBinary: '', openCodeBinary: '', codexBinary: '', grokBinary: '',
  });

  // Single-invocation budget guard (research seam): the FIRST decide() is the
  // real production driver; ANY further decide() is a typed LOCAL error with
  // zero provider invocation (parse retry / semantic repair can never spend
  // quota). Only calls that actually reach the real driver count as provider
  // invocations.
  let liveCalls = 0;
  let blockedCalls = 0;
  let decision = null;
  let decisionError = null;
  const resolveDriverBudgeted = (p, context) => {
    const real = backendRegistry.resolve(p, context);
    return {
      name: real.name,
      async decide(input) {
        if (liveCalls > 0) {
          blockedCalls += 1;
          const error = new Error('canary single-invocation budget exhausted; no further provider call permitted');
          error.code = 'CANARY_SINGLE_INVOCATION_BUDGET_EXHAUSTED';
          decisionError = error;
          throw error;
        }
        liveCalls += 1;
        try {
          decision = await real.decide(input);
          return decision;
        } catch (cause) {
          decisionError = cause;
          throw cause;
        }
      },
    };
  };

  const events = [];
  const taskLog = { event: (eventType, payload) => { events.push({ eventType, payload }); return true; } };
  const project = { id: 'antigravity-native-schema-canary', repo_path: ROOT };
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: resolveDriverBudgeted,
    profileRegistry,
    project,
    extraCtx: () => ({ councilId: 'antigravity-native-schema-canary-20260908', phase: TARGET_STEP, round: 1, role: 'critic' }),
    taskLog,
  });
  const spec = canarySpec();
  const outcome = await runner.run(spec);

  // PM contract verdict from the REAL production normalizer on the real
  // decision (the council runner never claims it itself).
  let pmContractState = 'NOT_ATTEMPTED';
  if (decision) {
    try { normalizePmDecision(decision); pmContractState = 'PASS'; } catch { pmContractState = 'FAIL'; }
  }

  const attempts = outcome?.finalResult?.handoff?.attempts ?? [];
  const firstAttempt = attempts[0] ?? null;
  const layered = firstAttempt?.parser_state != null ? firstAttempt : null;
  const terminalEvent = backendEvents.find((e) => e.eventKind === 'TERMINAL');
  const timeoutEvents = backendEvents.filter((e) => e.eventKind === 'TIMEOUT');
  const diagnostic = (backendEvents.find((e) => e.eventKind === 'LAYERED_DIAGNOSTIC')?.diagnostic) ?? null;
  onDiagnostic(diagnostic);
  const parserResultEvents = events.filter((e) => e.eventType === 'PARSER_RESULT');
  const parserResultAttempt0 = parserResultEvents[0]?.payload ?? null;
  const terminalFailed = outcome?.finalResult?.handoff?.ok === false || decisionError != null;

  const record = {
    canary: 'antigravity-native-schema-acceptance',
    target_profile: CANARY_PROFILE_ID,
    target_step: TARGET_STEP,
    is_implementation_participant: false,
    preflight: preflightRecord,
    invoked: liveCalls >= 1,
    live_provider_invocations: liveCalls,
    budget_guard_blocked_decide_calls: blockedCalls,
    attempt_ordinal: 0,
    assistant_output_present: firstAttempt?.output_bytes != null ? firstAttempt.output_bytes > 0 : null,
    assistant_output_bytes: firstAttempt?.output_bytes ?? null,
    first_non_whitespace_char: parserResultAttempt0?.first_non_whitespace_char ?? null,
    last_non_whitespace_char: parserResultAttempt0?.last_non_whitespace_char ?? null,
    looks_like_json_object: parserResultAttempt0?.looks_like_json_object ?? null,
    contains_markdown_fence: parserResultAttempt0?.contains_markdown_fence ?? null,
    execution_state: layered?.execution_state ?? null,
    terminal_status: terminalEvent?.status ?? null,
    public_error_code: firstAttempt?.error_code ?? null,
    structured_output_requested: preflightRecord.checks.structured_output_request_non_null,
    structured_output_mode: preflightRecord.checks.schema_mode,
    structured_output_present: decision != null && preflightRecord.checks.structured_output_request_non_null ? true : null,
    parser_attempted: layered?.parser_attempted ?? null,
    parser_state: layered?.parser_state ?? null,
    parse_error_code: layered?.parser_attempted === true ? firstAttempt.error_code : null,
    parse_subreason: firstAttempt?.parse_subreason ?? null,
    pm_contract_state: pmContractState,
    step_validation_state: outcome?.finalResult?.handoff?.ok === true ? 'PASS' : (pmContractState === 'PASS' || decision ? 'FAIL' : 'NOT_ATTEMPTED'),
    step_validation_reason: outcome?.finalResult?.handoff?.ok === true ? null : (outcome?.finalResult?.handoff?.reason ?? null),
    semantic_repair_used: outcome?.finalResult?.handoff?.semantic_repair_used === true,
    original_failure_reason: outcome?.finalResult?.handoff?.original_failure?.reason ?? null,
    budget_guard_triggered: blockedCalls > 0 || attempts.some((a) => a.error_code === 'CANARY_SINGLE_INVOCATION_BUDGET_EXHAUSTED'),
    handoff_ok: outcome?.finalResult?.handoff?.ok === true,
    timeout_events: timeoutEvents.length,
    observer_terminal_events: backendEvents.filter((e) => e.eventKind === 'TERMINAL').map((e) => ({ status: e.status, message: e.message?.slice(0, 200) ?? null })),
    task_log_event_types: events.map((e) => e.eventType),
    diagnostic_version: diagnostic?.diagnostic_version ?? null,
  };

  if (artifactPath) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preflightOnly = process.argv.includes('--preflight-only');
  const record = preflightOnly ? preflight() : await runCanary({
    artifactPath: join(ROOT, 'research/antigravity-native-schema-canary/participant-critique-canary.json'),
  });
  console.log(JSON.stringify(record, null, 2));
}
