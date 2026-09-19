#!/usr/bin/env node
// P9-R0.2 Part M — developer-only, read-only probe tool for Antigravity CLI
// --model/--effort semantics. Never a production runtime dependency: this
// script is not imported by any registry/driver/service code, it only
// reuses the same pure session-bridge functions (binary resolution, argv
// construction, NDJSON summarization) production code already uses, so its
// findings are guaranteed to reflect the real DSH invocation shape.
//
// Read-only / non-mutating: every prompt below explicitly says "do not use
// tools" and every run executes with --mode plan (never
// --dangerously-skip-permissions). cwd is a throwaway temp directory, never
// a real project repo, so this can never touch tracked source.
//
// Usage: node scripts/p9-antigravity-model-effort-probe.mjs
// Bounded: 10 sequential probes, each with a 30s CLI --print-timeout plus a
// generous Node-level backstop. No secrets are logged — only status/model/
// effort/token-counts/sanitized error text (already redacted by the shared
// bridge's safe() stderr sanitizer).

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAntigravityCliProcess, resolveAntigravityBinary } from '../src/session/antigravity-cli-session-bridge.mjs';

const NO_TOOL_PROMPT = 'Do not use tools. Reply with exactly MODEL_EFFORT_OK';

// Each entry: [label, model|null, effort|null]. Kept small deliberately
// (Part C: "do NOT run a huge Cartesian product; quota discipline
// matters") — one representative probe per question this wave needed
// answered, not an exhaustive grid.
const MATRIX = [
  ['M1  matching (flash-low + low)', 'gemini-3.5-flash-low', 'low'],
  ['M2  CONTRADICTORY (flash-low + high)', 'gemini-3.5-flash-low', 'high'],
  ['M3  CONTRADICTORY (flash-high + low)', 'gemini-3.5-flash-high', 'low'],
  ['M5  matching (flash-medium + medium, the live profile combo)', 'gemini-3.5-flash-medium', 'medium'],
  ['M6  CONTRADICTORY (pro-high + low)', 'gemini-3.1-pro-high', 'low'],
  ['F1  omitted --effort (flash-low)', 'gemini-3.5-flash-low', null],
  ['F2  omitted --effort (flash-high)', 'gemini-3.5-flash-high', null],
  ['G1  omitted --model (effort medium only, diagnostic)', null, 'medium'],
  ['M8  Claude, --effort low (no tier suffix in slug)', 'claude-sonnet-4-6', 'low'],
  ['M10 GPT-OSS, CONTRADICTORY (oss-120b-medium + low)', 'gpt-oss-120b-medium', 'low'],
];

async function main() {
  const binary = resolveAntigravityBinary();
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-p9-r02-probe-'));
  console.log(`# Antigravity model/effort probe — binary=${binary} cwd=${cwd}`);
  try {
    for (const [label, model, effort] of MATRIX) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential (Part M: sequential runs, quota discipline)
      const summary = await runAntigravityCliProcess({ binary, cwd, prompt: NO_TOOL_PROMPT, model: model ?? undefined, reasoning: effort ?? undefined, timeoutMs: 30000 }).catch((error) => ({ result: null, error }));
      const r = summary?.result;
      const usage = r?.usage ?? {};
      const initModel = summary?.events?.find((e) => e?.event === 'init')?.init?.model ?? null;
      console.log(JSON.stringify({
        label,
        requestedModel: model,
        requestedEffort: effort,
        status: r?.status ?? (summary?.error ? `SPAWN_ERROR:${summary.error.code}` : 'NO_RESULT'),
        initModel,
        response: (r?.response ?? '').trim().slice(0, 80),
        tokens: { input: usage.input_tokens ?? null, output: usage.output_tokens ?? null, thinking: usage.thinking_tokens ?? null },
        error: (r?.error ?? '').slice(0, 300),
      }));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('probe failed:', error?.message ?? error); process.exitCode = 1; });
