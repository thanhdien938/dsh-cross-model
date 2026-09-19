import { acquireRuntimeSingletonLease, buildRuntimeLockDomain } from '../../src/runtime/runtime-singleton-lease.mjs';

const launchShape = process.argv[2] ?? 'cli';
const lockRoot = process.argv[3];
const stateSuffix = process.argv[4] ?? 'shared';
const domain = buildRuntimeLockDomain({
  sqlitePath: `C:/dsh-test/${stateSuffix}/state.sqlite`,
  postgresConnectionString: `postgresql://test:test@127.0.0.1:5432/${stateSuffix}`,
  projects: [{ workspace_id: `workspace-${stateSuffix}`, workspace_verified: true }],
});

try {
  const lease = await acquireRuntimeSingletonLease({ domain, lockRoot });
  console.log(JSON.stringify({ event: 'READY', launch_shape: launchShape, pid: process.pid }));
  const release = async () => {
    await lease.release();
    process.exit(0);
  };
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
  setInterval(() => {}, 1000);
} catch (error) {
  console.error(JSON.stringify({ event: 'REFUSED', launch_shape: launchShape, code: error?.code ?? 'UNKNOWN' }));
  process.exitCode = 73;
}
