import crypto from 'node:crypto';
import { startLocalRuntimeControl } from '../../src/runtime/local-runtime-control.mjs';

const pipeName = process.argv[2];
const authCapability = process.argv[3];
if (!pipeName || !authCapability) process.exit(2);

let releaseShutdown;
const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
const control = await startLocalRuntimeControl({
  pipeName,
  authCapability,
  readiness: () => ({ ready: true }),
  runtimeTaskStatus: () => ({ running: 0, queued: 0 }),
  onShutdown: releaseShutdown,
});

process.stdout.write(`${JSON.stringify({ event: 'READY' })}\n`);
await shutdown;
await control.close();
process.stdout.write(`${JSON.stringify({
  event: 'CLOSED',
  activeHandleClasses: process._getActiveHandles()
    .map((handle) => handle?.constructor?.name ?? 'Unknown')
    .sort(),
  activeRequestClasses: process._getActiveRequests()
    .map((request) => request?.constructor?.name ?? 'Unknown')
    .sort(),
})}\n`);
