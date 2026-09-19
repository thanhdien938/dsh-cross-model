import { spawn, ChildProcess, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { getRepoRoot } from '../repoRoot';
import { importEsmModule } from '../dynamicImport';

// W3-A Login Terminal: a bounded, closed-command PTY-like session for a
// product's own native CLI login/logout flow only. It is explicitly NOT a
// general-purpose terminal:
//   - product must be one of the four registered backends;
//   - the executable is resolved the same way the production PM backend
//     registry resolves it (src/session/*-session-bridge.mjs), never a
//     renderer-supplied path;
//   - the argv is exactly `[login]` or `[logout]` — a fixed, closed
//     two-item vocabulary; no other subcommand or flag is ever possible;
//   - `shell: false` always — spawn() receives an args array, so there is
//     no shell interpretation of anything, including whatever the CLI
//     itself echoes back;
//   - stdin `write()` is the only additional input surface, bounded per
//     call, used only to answer the CLI's own interactive prompts (e.g.
//     "press Enter", pasting a device code) — it can never inject a new
//     command line to spawn.
//
// Deliberate, disclosed engineering deviation from a literal PTY: this
// implementation pipes stdio through child_process rather than allocating
// a real pseudo-terminal (node-pty). node-pty is a native addon; adding it
// to the Desktop package under this environment's Node/Electron ABI setup
// (already a source of real friction for better-sqlite3 — see
// docs/p6/implementation/14_W2_ACCEPTANCE_REPORT.md's ABI note) was judged
// too risky to introduce untested in this pass. Piped stdio still satisfies
// every hard requirement (closed command, bounded lifecycle, sanitized
// output, no arbitrary shell) for the login/logout flows these CLIs
// document (print a URL/code, wait for Enter or a browser round-trip) —
// it would not suffice for a full-screen interactive TUI, which login/
// logout commands are not.

export type LoginTerminalProduct = 'claude-code' | 'opencode' | 'codex' | 'grok';
export type LoginTerminalMode = 'login' | 'logout';

interface ProductCommand {
  resolveBinary: () => Promise<string>;
}

function sessionModule(fileName: string) {
  return path.join(getRepoRoot(), 'src', 'session', fileName);
}

// Closed executable resolution: reuses the exact same candidate search
// each product's production PM driver already uses (dynamically imported
// via importEsmModule since these are pure-ESM .mjs modules loaded from a
// CommonJS-compiled Electron main — see dynamicImport.ts), so the Login
// Terminal can never diverge from what the runtime itself would execute.
//
// P6.5 Part K: these call the *async* resolver export
// (resolveXBinaryAsync — src/session/binary-resolution-async.mjs) rather
// than each bridge's original synchronous resolveXBinary(), which could
// run several sequential spawnSync `--version` probes and block Electron
// main for the whole search — opening Login Terminal must never freeze
// the rest of the app while it resolves which binary to launch.
const PRODUCTS: Record<LoginTerminalProduct, ProductCommand> = {
  'claude-code': {
    resolveBinary: async () => (await importEsmModule(sessionModule('claude-code-session-bridge.mjs'))).resolveClaudeBinaryAsync(),
  },
  opencode: {
    resolveBinary: async () => (await importEsmModule(sessionModule('opencode-cli-session-bridge.mjs'))).resolveOpenCodeBinaryAsync(),
  },
  codex: {
    resolveBinary: async () => (await importEsmModule(sessionModule('codex-cli-session-bridge.mjs'))).resolveCodexCliBinaryAsync(),
  },
  grok: {
    resolveBinary: async () => (await importEsmModule(sessionModule('grok-acp-client.mjs'))).resolveGrokBinaryAsync(),
  },
};

// Fixed, closed argv — never extended, never renderer-supplied, never a
// flag (every entry is bare positional subcommand words only — see
// desktop/tests/security.test.ts's assertion that this table never
// matches /--/). P6-W3-R4 Part M live-verified every one of the four
// entries below against the real installed CLIs in this environment
// (previously codex/grok only; claude-code and opencode were previously
// assumed, not verified, because those binaries were not resolvable in
// an earlier pass's environment):
//   codex  --help  Commands: login / logout                (top-level, bare)
//   grok   --help  Commands: login / logout                (top-level, bare)
//   claude --help  Commands: auth  (Manage authentication)  -> `claude auth
//          --help` lists `login`/`logout` as *its* subcommands; there is no
//          bare top-level `claude login`/`claude logout` (confirmed live:
//          `claude login --help` does not error, it silently falls back to
//          normal `claude [prompt]` usage help, treating "login" as an
//          ordinary prompt argument instead of a subcommand).
//   opencode --help  Commands: `opencode providers` (aliased `auth`), whose
//          own subcommands are `opencode auth login [url]` / `opencode auth
//          logout [provider]` — again no bare top-level login/logout.
const ARGS: Record<LoginTerminalProduct, Record<LoginTerminalMode, string[]>> = {
  'claude-code': { login: ['auth', 'login'], logout: ['auth', 'logout'] },
  opencode: { login: ['auth', 'login'], logout: ['auth', 'logout'] },
  codex: { login: ['login'], logout: ['logout'] },
  grok: { login: ['login'], logout: ['logout'] },
};

const MAX_BUFFER_BYTES = 200 * 1024;
const MAX_WRITE_BYTES = 4096;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function isSupportedLoginProduct(value: string): value is LoginTerminalProduct {
  return value === 'claude-code' || value === 'opencode' || value === 'codex' || value === 'grok';
}

export class LoginTerminalSession extends EventEmitter {
  readonly product: LoginTerminalProduct;
  readonly mode: LoginTerminalMode;
  private child: ChildProcess | null = null;
  private buffer = '';
  private exited = false;

  private constructor(product: LoginTerminalProduct, mode: LoginTerminalMode) {
    super();
    this.product = product;
    this.mode = mode;
  }

  // `deps` exists purely as a test seam (see desktop/tests/
  // loginTerminalService.test.ts): production callers never pass it, so
  // the real resolver + real `child_process.spawn` are always used
  // outside tests. Tests inject a harmless stand-in binary so the suite
  // never touches this machine's real CLI auth state.
  static async start(product: string, mode: string, deps: { resolveBinary?: (p: LoginTerminalProduct) => Promise<string>; spawnImpl?: typeof spawn; buildProviderChildEnv?: (input: {provider: LoginTerminalProduct}) => NodeJS.ProcessEnv } = {}): Promise<LoginTerminalSession> {
    if (!isSupportedLoginProduct(product)) throw Object.assign(new Error('unsupported product'), { code: 'LOGIN_PRODUCT_UNSUPPORTED' });
    if (mode !== 'login' && mode !== 'logout') throw Object.assign(new Error('unsupported mode'), { code: 'LOGIN_MODE_UNSUPPORTED' });
    const session = new LoginTerminalSession(product, mode);
    const binary = deps.resolveBinary ? await deps.resolveBinary(product) : await PRODUCTS[product].resolveBinary();
    if (!binary || !path.isAbsolute(binary)) throw Object.assign(new Error('provider executable is unavailable or untrusted'), { code: 'PROVIDER_EXECUTABLE_UNTRUSTED' });
    const args = ARGS[product][mode];
    const spawnFn = deps.spawnImpl ?? spawn;
    const buildChildEnv = deps.buildProviderChildEnv ?? (await importEsmModule(sessionModule('provider-child-policy.mjs'))).buildProviderChildEnv;
    session.child = spawnFn(binary, args, {
      cwd: process.env.USERPROFILE || process.env.HOME || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: buildChildEnv({ provider: product }),
    });
    session.child.stdout?.on('data', (chunk) => session.append(chunk));
    session.child.stderr?.on('data', (chunk) => session.append(chunk));
    session.child.on('exit', (code, signal) => {
      session.exited = true;
      session.emit('exit', { code, signal });
    });
    session.child.on('error', (error: any) => {
      session.exited = true;
      session.emit('exit', { code: null, signal: null, error: error?.code ?? 'LOGIN_PROCESS_ERROR' });
    });
    return session;
  }

  // Bounded, sanitized: strips ANSI CSI escape sequences (this is a plain
  // text view, not a terminal emulator) and caps the retained buffer.
  private append(chunk: Buffer): void {
    const text = chunk.toString('utf8').replace(ANSI_ESCAPE, '');
    this.buffer = (this.buffer + text).slice(-MAX_BUFFER_BYTES);
    this.emit('data', text);
  }

  // Only for answering the CLI's own interactive prompts. Bounded per
  // call; never shell-interpreted (this is raw stdin bytes to an already-
  // spawned process, not a new command).
  write(data: string): void {
    if (this.exited || !this.child?.stdin) return;
    this.child.stdin.write(String(data).slice(0, MAX_WRITE_BYTES));
  }

  getBuffer(): string {
    return this.buffer;
  }

  isRunning(): boolean {
    return !this.exited;
  }

  stop(): void {
    if (this.exited || !this.child) return;
    if (process.platform === 'win32' && this.child.pid) {
      spawnSync('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      this.child.kill('SIGTERM');
    }
  }
}
