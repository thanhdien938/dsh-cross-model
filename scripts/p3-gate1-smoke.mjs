import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['scripts/p3-gate1-postgres-proof.mjs'], { stdio: 'inherit', windowsHide: true, env: process.env });
const code = await new Promise((resolve) => child.once('exit', resolve));
if (code !== 0) process.exit(code ?? 1);
console.log('P3-GATE1 COORDINATION CONTRACT + IDENTITIES SMOKE: PASS');

