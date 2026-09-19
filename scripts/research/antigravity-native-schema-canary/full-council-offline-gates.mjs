import { acceptanceTestedTree, acceptanceCheckoutClean } from './acceptance-source-snapshot.mjs';
// Offline only. Runs an explicit list of stub/fixture-based tests, never prepare/live.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { atomicJson } from './acceptance-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const files = [
  'scripts/research/antigravity-native-schema-canary/acceptance-source-snapshot.test.mjs',
  'tests/canonicalizer-prompt-isolation.test.mjs',
  'tests/pm-output-canonicalization.test.mjs',
  'tests/parser-0-corpus-replay.test.mjs',
  'tests/parser-0-layered-diagnostics.test.mjs',
  'scripts/research/antigravity-native-schema-canary/acceptance-evidence.test.mjs',
  'scripts/research/antigravity-native-schema-canary/full-council-e2e.test.mjs',
  'scripts/research/antigravity-native-schema-canary/report-read-canary.test.mjs',
  'scripts/research/antigravity-native-schema-canary/debate-response-canary.test.mjs',
  'scripts/research/antigravity-native-schema-canary/g7-structure.test.mjs',
  ...[
    'durable-pm-runtime','durable-pm-runtime-r1','sqlite-persistence-store',
    'council-runtime','council-durable-diagnostics','council-chair-plan-contract',
    // DSH-CHAIR-PLAN-JSON-INVALID: the chair_plan terminal output-contract fix
    // and the structural reproduction of the canonical PM_DECISION_JSON_INVALID
    // failure it prevents.
    'chair-plan-json-invalid-contract','council-participant-contract-hardening',
    'p15-rem-r2-terminalization-council-recovery','backend-execution-observer',
    'parser-0-layered-diagnostics','parser-0-corpus-replay',
    'council-workspace-read-integration','council-workspace-read-stabilization',
    'council-workspace-read-security-edge','council-workspace-read-timeout-policy',
    'council-workspace-capability','antigravity-context-fed','antigravity-schema-compatibility',
    'antigravity-participant-schema','antigravity-native-output-boundary',
    'antigravity-native-model-identity','antigravity-model-effort-semantics',
    'production-antigravity-backend','p11-production-pm-backend-registry-api',
  ].map(name => `tests/${name}.test.mjs`),
];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const testedTree=acceptanceTestedTree(git);
const testedHead = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
// Existing report canary prepare() rewrites this synthetic fixture (including
// Windows line endings). Restore its exact pre-test bytes, never corpus files.
const fixturePath = join(root,'research/antigravity-native-schema-canary/report-read-workspace/CANARY_EVIDENCE.md');
const fixtureBefore = readFileSync(fixturePath);
let result;
try { result = spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}); }
finally { writeFileSync(fixturePath,fixtureBefore); }
const count = name => Number(result.stdout?.match(new RegExp(`^# ${name} (\\d+)$`,'m'))?.[1] ?? -1);
const passed = acceptanceCheckoutClean(git) && acceptanceTestedTree(git)===testedTree && result.status === 0 && count('fail') === 0 && count('skipped') === 0 && count('tests') > 0;
const gates = { tested_head:testedHead, tested_tree:testedTree, passed, tests:count('tests'), pass:count('pass'), failures:count('fail'), skipped:count('skipped'),
  completed_at:new Date().toISOString(), model_provider_calls:0,
  corpus: passed ? {rows:154,pass:114,fail:22,not_attempted:18,acceptance_delta:0} : null, test_files:files };
mkdirSync(join(root,'.test-results'),{recursive:true});
atomicJson(join(root,'.test-results/full-council-offline-gates.json'),gates);
console.log(JSON.stringify(gates,null,2));
// Keep any diagnostic output in memory; never write raw assertion/provider values.
if(!passed) {
  const failures=(result.stdout??'').split('\n').filter(l=>/^not ok \d+ - [a-zA-Z0-9]/.test(l)).map(l=>l.slice(0,180));
  console.log(JSON.stringify({failed_test_names:failures,exit_code:result.status,signal:result.signal}));
  process.exitCode=1;
}
