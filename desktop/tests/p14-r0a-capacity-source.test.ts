import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// P14-R0A Part C: prove the "Running X / Y" denominator the owner sees is
// a real round trip to the live runtime, not a renderer-side literal.
// This audits the actual chain end to end at the source level:
//   MultiTaskControl.tsx renders status.globalLimit
//     <- IPC 'tasks:runtimeStatus' handler (main.ts) calls
//        readProjection.getMultiTaskStatus(await pipe.runtimeTaskStatus())
//     <- namedPipeClient.runtimeTaskStatus() sends a live RUNTIME_TASK_STATUS
//        request over the runtime's own IPC pipe
//     <- the runtime composition's runtimeTaskStatus() (P13-R1,
//        p5-production-composition.mjs) reads the real worker's
//        ownerStatusSnapshot(), whose global_limit is `this.globalLimit`
//        (production-pm-worker.mjs) -- set from the composition's
//        `deps.pmConcurrencyLimit`, which scripts/p5-runtime.mjs wires from
//        `config.concurrency?.globalLimit` (real YAML config), falling
//        back to the documented PROOF value 2 only when the owner has not
//        opted into a different value (P13-R8's `??2` fallback).
// No layer in that chain contains a UI-side hardcoded denominator.

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');

function readText(relFromRepoRoot: string): string {
  return fs.readFileSync(path.resolve(repoRoot, relFromRepoRoot), 'utf8');
}

describe('P14-R0A: Running X / Y denominator is truthful runtime state, not a UI literal', () => {
  it('MultiTaskControl.tsx renders status.globalLimit, never a numeric literal after the slash', () => {
    const source = fs.readFileSync(path.resolve(root, 'src/components/MultiTaskControl.tsx'), 'utf8');
    expect(source).toContain('{status.activeCount} / {status.globalLimit}');
    // Guards against a regression reintroducing something like `/ 2` as a
    // literal anywhere in the summary markup.
    expect(source).not.toMatch(/\/\s*\d+\s*<\/span>/);
  });

  it("the desktop IPC handler sources globalLimit from a live pipe round trip, not a constant", () => {
    const source = fs.readFileSync(path.resolve(root, 'electron/main/main.ts'), 'utf8').replace(/\r\n/g, '\n');
    // P15-REM-R3-G (P15-D-015): the handler now returns a typed
    // ProjectionResult on the not-ready/not-reachable paths before ever
    // reaching the live pipe call — widened bound to cover that, still
    // anchored to the same handler block.
    expect(source).toMatch(/tasks:runtimeStatus[\s\S]{0,500}pipe\.runtimeTaskStatus\(\)/);
  });

  it('namedPipeClient sends a real RUNTIME_TASK_STATUS request over the runtime pipe', () => {
    const source = fs.readFileSync(path.resolve(root, 'electron/main/services/namedPipeClient.ts'), 'utf8');
    expect(source).toMatch(/runtimeTaskStatus[\s\S]{0,120}operation:\s*'RUNTIME_TASK_STATUS'/);
  });

  it('readProjection.getMultiTaskStatus derives globalLimit from the runtime snapshot argument, never a literal', () => {
    const source = readText('desktop/electron/main/services/readProjection.ts');
    expect(source).toContain('globalLimit:Number.isInteger(runtime?.global_limit)?runtime.global_limit:0');
  });

  it('the runtime composition wires global_limit from the real config seam (pmConcurrencyLimit), falling back to the documented PROOF value 2', () => {
    const source = readText('src/runtime/p5-production-composition.mjs');
    expect(source).toContain('deps.pmConcurrencyLimit??2');
  });

  it('the production entrypoint reads the global limit from real YAML config (config.concurrency.globalLimit), not a hardcoded value', () => {
    const source = readText('scripts/p5-runtime.mjs');
    expect(source).toContain('pmConcurrencyLimit: config.concurrency?.globalLimit');
  });
});
