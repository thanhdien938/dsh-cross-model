import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCanary, ROOT } from './run-canary.mjs';
import { runAntigravityCliProcess, extractAntigravityAssistantText } from '../../../src/session/antigravity-cli-session-bridge.mjs';
import { inspectStructure } from './g7-structure.mjs';

// Explicit opt-in; durable reservation prevents accidentally rerunning CALL #1.
const ordinal = process.argv.includes('--call-2') ? 2 : process.argv.includes('--call-1') ? 1 : null;
if (!ordinal) throw new Error('EXPLICIT_CALL_ORDINAL_REQUIRED');
const path = join(ROOT,`research/antigravity-native-schema-canary/${ordinal===1?'g7-ambiguous-structural-diagnostic':'g7-post-fix-verification'}.json`);
if (existsSync(path)) throw new Error('CALL_ALREADY_RESERVED');
writeFileSync(path, JSON.stringify({ call_ordinal: ordinal, state: 'RESERVED' }) + '\n', { flag: 'wx' });
let structure = null, diagnostic = null, boundary = null, invocations = 0;
try {
  const result = await runCanary({
    onDiagnostic: d => { diagnostic = d; },
    antigravityRunner: async options => {
      if (invocations++) throw new Error('RESEARCH_PROVIDER_BUDGET_EXHAUSTED');
      const summary = await runAntigravityCliProcess(options);
      structure = inspectStructure(summary, options.structuredOutputSchema);
      if (ordinal === 2) {
        const response = extractAntigravityAssistantText(summary, {structuredOutputSchema:options.structuredOutputSchema});
        const result = {status:'SUCCESS',response};
        boundary = inspectStructure({events:[{event:'result',result}],result},options.structuredOutputSchema);
      }
      return summary; // Exact same object; no extraction, normalization, or salvage.
    },
  });
  const safe = { call_ordinal: ordinal, live_provider_invocations: invocations,
    budget_guard_blocked_decide_calls: result.budget_guard_blocked_decide_calls ?? 0,
    parser_0: diagnostic, structure, ...(ordinal===2?{native_boundary:boundary}:{}), pm_contract_state: result.pm_contract_state ?? 'NOT_ATTEMPTED',
    council_validation_state: result.step_validation_state ?? 'NOT_ATTEMPTED',
    end_to_end_accepted: result.handoff_ok === true };
  writeFileSync(path, JSON.stringify(safe,null,2) + '\n');
  console.log(JSON.stringify(safe,null,2));
} catch {
  const safe = { call_ordinal: ordinal, live_provider_invocations: invocations, state: 'HARNESS_FAILED', structure, parser_0: diagnostic };
  writeFileSync(path,JSON.stringify(safe,null,2)+'\n');
  console.log(JSON.stringify(safe)); process.exitCode = 1;
}
