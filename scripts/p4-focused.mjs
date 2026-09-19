import { spawn } from 'node:child_process';
const gate = process.argv[2];
const pattern = gate === 'c0' ? 'P4_C0' : gate === 'c6' ? 'P4_C0_C6' : `P4_${gate.toUpperCase()}`;
const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, 'tests/phase4-runtime.test.mjs', 'tests/phase4-r1-remediation.test.mjs'], { stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve) => child.once('exit', resolve)); if (code) process.exit(code); console.log(`P4 ${gate.toUpperCase()} CHECKPOINT: PASS`);
