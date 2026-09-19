import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

function resolveClaude() {
  for (const candidate of ['claude', join(homedir(), '.local', 'bin', 'claude')]) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status === 0) return candidate;
  }
  return 'claude';
}

const commands = [
  ['node', ['--version']],
  ['node', ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--help']],
  ['codex', ['--version']],
  [resolveClaude(), ['--version']],
  ['grok', ['--version']],
];

let failed = false;
for (const [cmd, args] of commands) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${cmd}: ${(r.stdout || r.stderr || '').trim().split('\n')[0] || 'no output'}`);
  if (!ok) failed = true;
}
process.exitCode = failed ? 1 : 0;
