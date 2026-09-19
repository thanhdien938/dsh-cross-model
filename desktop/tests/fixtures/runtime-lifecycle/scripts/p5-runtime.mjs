// P7-R0.4 Part R fixture runtime child. NOT the real scripts/p5-runtime.mjs
// — a small, controllable stand-in RuntimeSupervisor spawns exactly the
// same way (`node <this> all --config <path> --control-pipe <pipe>`) so
// runtimeRestartLifecycle.test.ts can exercise real child-process behavior
// (real spawn, real exit codes, real named pipes) without depending on
// Postgres/SQLite/real CLI PM backends. Behavior is selected by the
// DSH_TEST_FIXTURE_MODE env var RuntimeSupervisor's spawn() inherits from
// the test process.
import net from 'node:net';

const mode = process.env.DSH_TEST_FIXTURE_MODE || 'becomes-ready-fast';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const controlPipe = argValue('--control-pipe');

// P13-R7.1 Part D: how many milliseconds AFTER the SHUTDOWN ack this
// fixture waits before actually calling process.exit(0) -- simulates the
// real runtime's own drain-grace-period-then-teardown latency (the exact
// gap RuntimeSupervisor's `waitForExit()` races against) without needing
// the real composition/drainActive() machinery. 0 (default) reproduces
// every pre-R7.1 fixture mode's existing instant-exit behavior exactly.
const shutdownDelayMs = Number(process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS || 0);

function startPipeServer(handleReadiness) {
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let nl;
      while ((nl = buffered.indexOf(0x0a)) !== -1) {
        const frame = buffered.subarray(0, nl);
        buffered = buffered.subarray(nl + 1);
        let req;
        try {
          req = JSON.parse(frame.toString('utf8'));
        } catch {
          continue;
        }
        if (req.operation === 'READINESS') {
          socket.write(JSON.stringify({ id: req.id, success: true, result: handleReadiness() }) + '\n');
        } else if (req.operation === 'SHUTDOWN') {
          // Flush the response and end THIS socket before exiting — do not
          // wait on server.close()'s callback, which only fires after
          // every existing connection (including this very response
          // socket) has ended, and would otherwise deadlock the fixture.
          socket.end(JSON.stringify({ id: req.id, success: true, result: 'DRAINING' }) + '\n', () => {
            if (shutdownDelayMs > 0) setTimeout(() => process.exit(0), shutdownDelayMs);
            else process.exit(0);
          });
        } else if (req.operation === 'PING') {
          socket.write(JSON.stringify({ id: req.id, success: true, result: 'PONG' }) + '\n');
        } else {
          socket.write(JSON.stringify({ id: req.id, success: false, error: 'UNSUPPORTED_IN_FIXTURE' }) + '\n');
        }
      }
    });
  });
  server.listen(controlPipe);
  return server;
}

if (mode === 'exit-immediately-pm-unavailable') {
  console.error(JSON.stringify({ event: 'p5.runtime.failed', role: 'all', code: 'PM_BACKEND_UNAVAILABLE' }));
  process.exitCode = 1;
} else if (mode === 'exit-immediately-database-open-failed') {
  console.error(JSON.stringify({ event: 'p5.runtime.failed', role: 'all', code: 'DATABASE_OPEN_FAILED' }));
  process.exitCode = 1;
} else if (mode === 'alive-no-pipe') {
  console.log(JSON.stringify({ event: 'p5.runtime.started', role: 'all' }));
  setInterval(() => {}, 1000); // alive, but deliberately never opens --control-pipe
} else if (mode === 'alive-pipe-never-ready') {
  console.log(JSON.stringify({ event: 'p5.runtime.started', role: 'all' }));
  startPipeServer(() => ({
    ready: false,
    postgres: { reachable: true, schema: 4 },
    sqlite: { reachable: true, schema: 6 },
    projects: { valid: true, count: 1 },
    pmProfiles: { valid: true, resolvable: false, count: 1, backends: [{ profile_id: 'test-fixture-pm', available: false, code: 'PM_BACKEND_UNAVAILABLE' }] },
    telegram: { configured: true, token_present: true },
  }));
} else {
  // 'becomes-ready-fast' (default): reachable and ready on the very first poll.
  console.log(JSON.stringify({ event: 'p5.runtime.started', role: 'all' }));
  startPipeServer(() => ({
    ready: true,
    postgres: { reachable: true, schema: 4 },
    sqlite: { reachable: true, schema: 6 },
    projects: { valid: true, count: 1 },
    pmProfiles: { valid: true, resolvable: true, count: 1, backends: [{ profile_id: 'test-fixture-pm', available: true, code: null }] },
    telegram: { configured: true, token_present: true },
  }));
}

process.on('SIGTERM', () => process.exit(0));
