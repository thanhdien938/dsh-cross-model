import { spawn } from 'node:child_process';

for (const args of [
  ['--test', 'tests/phase4-runtime.test.mjs', 'tests/phase4-r1-remediation.test.mjs'],
  ['scripts/p3-final-postgres-proof.mjs'],
  ['scripts/p3-gate4-postgres-proof.mjs']
]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, env: process.env });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) process.exit(code ?? 1);
}
console.log('P4 C9 REAL POSTGRESQL / OS PROCESS FAULT HARNESS: PASS');
