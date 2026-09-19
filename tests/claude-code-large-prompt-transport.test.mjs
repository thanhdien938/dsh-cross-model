import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { runClaudeProcess } from '../src/session/claude-code-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';

function nodeStdinClaudeFixture({ structuredOutput = null, capture = {} } = {}) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args: [...args], options });
    const envelope = {
      session_id: 'fixture-session',
      result: structuredOutput ? JSON.stringify(structuredOutput) : 'ok',
      ...(structuredOutput ? { structured_output: structuredOutput } : {}),
    };
    const fixture = [
      "let input='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>input+=chunk);",
      `const envelope=${JSON.stringify(envelope)};`,
      "process.stdin.on('end',()=>{envelope.input_chars=input.length;envelope.input_bytes=Buffer.byteLength(input);process.stdout.write(JSON.stringify(envelope));});",
    ].join('');
    return spawn(process.execPath, ['-e', fixture], { ...options, shell: false });
  };
}

test('Claude small prompt still works through stdin with bounded argv', async () => {
  const capture = {};
  const out = await runClaudeProcess({
    binary: 'claude-fixture', prompt: 'small prompt',
    spawnImpl: nodeStdinClaudeFixture({ capture }), timeoutMs: 5_000,
  });
  assert.equal(out.result, 'ok');
  assert.equal(out.raw.input_chars, 'small prompt'.length);
  assert.equal(out.raw.input_bytes, Buffer.byteLength('small prompt'));
  assert.equal(capture.args.includes('small prompt'), false);
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(Math.max(...capture.args.map((arg) => arg.length)) < 2_000);
});

test('Claude T5-sized prompt crosses the real OS pipe without ENAMETOOLONG or argv/path explosion', async () => {
  const capture = {};
  const prompt = 'T5-evidence\n'.repeat(21_000); // 252,000 chars: slightly larger than the captured failing bridge prompt.
  const out = await runClaudeProcess({
    binary: 'claude-fixture', prompt,
    spawnImpl: nodeStdinClaudeFixture({ capture }), timeoutMs: 5_000,
  });
  assert.equal(out.result, 'ok');
  assert.equal(out.raw.input_chars, prompt.length);
  assert.equal(out.raw.input_bytes, Buffer.byteLength(prompt));
  assert.equal(capture.args.some((arg) => arg.includes('T5-evidence')), false);
  assert.equal(capture.binary, 'claude-fixture');
  assert.equal(capture.options.cwd, process.cwd());
  assert.ok(capture.args.join(' ').length < 2_000);
});

test('large multi-file WORKSPACE_READ packet reaches Claude chair_plan through CouncilChairDriver and CouncilStepWorkflowRunner', async () => {
  const participants = ['participant-a', 'participant-b', 'participant-c', 'participant-d'];
  const plan = {
    type: 'finish', output: 'council plan ready', data: {
      type: 'council_plan',
      participant_instructions: Object.fromEntries(participants.map((id) => [id, `focus for ${id}`])),
      critique_focus: 'cross-check the supplied files', synthesis_focus: 'ground the verdict in packet evidence',
    },
  };
  const files = Array.from({ length: 8 }, (_, index) => [
    `src/evidence-${index}.mjs`, 'a'.repeat(30_000), String(index).repeat(64).slice(0, 64),
  ]);
  const evidenceText = [
    'project_id: fixture', 'head_commit_sha: 8319850e8258b9704567e26a164d8f09dad9641d',
    ...files.flatMap(([path, content, hash]) => [
      `### ${path}`, `sha256: ${hash}`, `bytes: ${content.length}`, 'FULL_FILE_VISIBLE: YES',
      '--- CHUNK 1/1 ---', '```', content, '```',
    ]),
  ].join('\n');
  const capture = {};
  let bridgePrompt = null;
  const registry = new ProductionPmBackendRegistry({
    claudeBinary: 'claude-fixture', openCodeBinary: 'unused', codexBinary: 'unused', grokBinary: 'unused', antigravityBinary: 'unused',
    probe: () => true,
    observer: null,
    claudeRunner: async (options) => {
      bridgePrompt = options.prompt;
      const value = await runClaudeProcess({ ...options, spawnImpl: nodeStdinClaudeFixture({ structuredOutput: plan, capture }) });
      capture.inputChars = value.raw.input_chars;
      capture.inputBytes = value.raw.input_bytes;
      return value;
    },
  });
  const chairProfile = { id: 'chair', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' };
  const council = {
    kind: 'COUNCIL', chair_profile_id: chairProfile.id, participant_profile_ids: participants,
    rounds: 2, strategy: 'independent_then_critique_then_synthesis', implementation_participant_id: null,
    debate: { enabled: false, max_rounds: 2 }, workspace_requirement: 'READ',
    workspace_evidence_paths: files.map(([path]) => path),
  };
  const chair = new CouncilChairDriver({
    council, ownerTask: 'Audit every supplied file.',
    loadEvidencePacket: async () => ({ evidenceText, text: evidenceText, hashesByPath: Object.fromEntries(files.map(([path, , hash]) => [path, hash])) }),
  });
  const decision = await chair.decide({ turn: 0, history: [] });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: (profile, context) => registry.resolve(profile, context),
    profileRegistry: { get: (id) => { assert.equal(id, chairProfile.id); return chairProfile; } },
    project: { id: 'fixture-project', repo_path: process.cwd() },
  });
  const outcome = await runner.run(decision.spec);

  assert.equal(outcome.finalResult.status, 'completed');
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.ok(decision.spec.prompt.length > 240_000);
  assert.ok(bridgePrompt.length > 240_000);
  assert.equal(bridgePrompt.includes(evidenceText), true);
  assert.equal(files.every(([path]) => bridgePrompt.includes(path)), true);
  assert.equal(capture.inputChars, bridgePrompt.length);
  assert.equal(capture.inputBytes, Buffer.byteLength(bridgePrompt));
  assert.equal(capture.args.some((arg) => arg.includes('Audit every supplied file.')), false);
  assert.equal(capture.args.some((arg) => arg.length > 2_000), false);
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
});
