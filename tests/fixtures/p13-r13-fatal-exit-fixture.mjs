// P13-R1.3: a tiny standalone script for deterministically exercising
// installFatalExitCapture()'s uncaughtException/unhandledRejection
// handling in a REAL, separate Node process (a full process-fatal exit
// cannot be safely triggered inside the test runner's own process).
// No provider, no network, no real config -- pure process-lifecycle
// reproduction, matching Part H's "smallest deterministic regression".
import { installFatalExitCapture } from '../../src/runtime/fatal-exit-log.mjs';

const mode = process.argv[2];
const logPath = process.argv[3];

installFatalExitCapture({ logPath });

if (mode === 'uncaught') {
  setTimeout(() => {
    throw Object.assign(new Error('fixture uncaught: token=SECRET123456789 postgresql://dbuser:hunter2pass@dbhost:5432/production'), { code: 'FIXTURE_UNCAUGHT' });
  }, 5);
} else if (mode === 'rejection') {
  setTimeout(() => {
    Promise.reject(Object.assign(new Error('fixture rejection Bearer abcdefgh123456789012'), { code: 'FIXTURE_REJECTION' }));
  }, 5);
} else if (mode === 'clean') {
  console.log('clean-exit');
} else {
  process.exit(3);
}
