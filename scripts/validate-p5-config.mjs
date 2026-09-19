// Standalone, closed validation entry point used by Desktop's Add Folder
// flow (W2-I/W2-J). It performs exactly the same validation the runtime
// itself performs at startup — the production config loader — so a
// candidate projects.yaml is never accepted by the Desktop unless the real
// runtime would also accept it. Prints one JSON line and sets exit code 0
// (valid) or 1 (invalid); never throws raw stack traces to stdout.
import { loadP5ProductionConfig, publicP5Config } from '../src/runtime/p5-production-config.mjs';

const configPath = value('--config');
if (!configPath) {
  console.log(JSON.stringify({ ok: false, code: 'CONFIG_VALIDATION_FAILED', message: 'usage: node scripts/validate-p5-config.mjs --config <path>' }));
  process.exitCode = 1;
} else {
  try {
    const config = await loadP5ProductionConfig(configPath);
    console.log(JSON.stringify({ ok: true, public: publicP5Config(config) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error?.code ?? 'CONFIG_VALIDATION_FAILED', message: String(error?.message ?? 'invalid configuration') }));
    process.exitCode = 1;
  }
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}
