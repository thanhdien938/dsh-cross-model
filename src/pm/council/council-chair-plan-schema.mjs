/**
 * P10-R0.1.2 Part E — the exact JSON Schema for a council `chair_plan`
 * decision, dynamically derived from the OWNER-SELECTED participant set
 * (never hardcoded profile ids in production source — Part E).
 *
 * This schema is sent to Claude Code's native `--json-schema` structured-
 * output transport (Part B/C: live-proven on the owner's installed CLI,
 * 2.1.235) for the chair_plan step ONLY (Part L). It mirrors, field for
 * field, the SAME shape `validateStepData()`
 * (council-step-workflow-runner.mjs) already enforces after parsing — the
 * schema is an additional TRANSPORT guarantee, never a replacement for that
 * validator (Part I): `validateStepData()` still runs, unconditionally, on
 * every chair_plan decision regardless of how its text was produced.
 */

const NON_EMPTY_STRING = Object.freeze({ type: 'string', minLength: 1 });

export const CHAIR_PLAN_SCHEMA_KIND = 'council_chair_plan';
export const CHAIR_PLAN_SCHEMA_VERSION = 1;

/**
 * @param {string[]} participantProfileIds - the owner-selected, already-
 *   normalized participant set (council-contracts.mjs's `normalizeCouncilSpec`
 *   is the single upstream authority for what this list may contain).
 */
export function buildChairPlanJsonSchema(participantProfileIds) {
  const ids = Array.isArray(participantProfileIds) ? participantProfileIds : [];
  const participantInstructionProperties = {};
  for (const id of ids) participantInstructionProperties[id] = NON_EMPTY_STRING;

  return Object.freeze({
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['finish'] },
      output: NON_EMPTY_STRING,
      data: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['council_plan'] },
          // Part E: EXACTLY the owner-selected ids — required (no fewer)
          // and additionalProperties:false (no more, no `_note`-suffixed or
          // otherwise invented keys) — schema-level enforcement of the
          // SAME copy-exact-verbatim contract council-prompts.mjs's prompt
          // rules already state in words.
          participant_instructions: {
            type: 'object',
            properties: participantInstructionProperties,
            required: [...ids],
            additionalProperties: false,
          },
          critique_focus: NON_EMPTY_STRING,
          synthesis_focus: NON_EMPTY_STRING,
        },
        required: ['type', 'participant_instructions', 'critique_focus', 'synthesis_focus'],
        additionalProperties: false,
      },
    },
    required: ['type', 'output', 'data'],
    additionalProperties: false,
  });
}
