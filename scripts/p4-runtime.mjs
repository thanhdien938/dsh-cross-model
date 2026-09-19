import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadProductionConfig } from '../src/runtime/production-config.mjs';

const role = process.argv[2];
const configIndex = process.argv.indexOf('--config');
const compositionIndex = process.argv.indexOf('--composition');
if (!['coordinator', 'worker'].includes(role) || configIndex < 0 || compositionIndex < 0 || !process.argv[configIndex + 1] || !process.argv[compositionIndex + 1]) {
  console.error('usage: node scripts/p4-runtime.mjs <coordinator|worker> --config <path> --composition <path>'); process.exit(2);
}

try {
  const raw = JSON.parse(await readFile(resolve(process.argv[configIndex + 1]), 'utf8'));
  const config = loadProductionConfig(raw);
  const composition = await import(pathToFileURL(resolve(process.argv[compositionIndex + 1])).href);
  const factory = role === 'coordinator' ? composition.buildCoordinatorRuntime : composition.buildWorkerRuntime;
  if (typeof factory !== 'function') throw new TypeError(`composition does not export ${role === 'coordinator' ? 'buildCoordinatorRuntime' : 'buildWorkerRuntime'}`);
  const runtime = await factory(config);
  if (!runtime || typeof runtime.run !== 'function' || typeof runtime.requestDrain !== 'function') throw new TypeError('composition returned an invalid runtime');
  let signalCount = 0;
  const drain = () => { signalCount += 1; runtime.requestDrain(); if (signalCount > 1) process.exitCode = 130; };
  process.on('SIGTERM', drain); process.on('SIGINT', drain);
  console.log(JSON.stringify({ event: 'runtime.started', role, mode: config.mode }));
  await runtime.run();
  console.log(JSON.stringify({ event: 'runtime.stopped', role }));
} catch (error) {
  console.error(JSON.stringify({ event: 'runtime.failed', role, code: error?.code ?? 'CONFIGURATION_ERROR' })); process.exitCode = 1;
}
