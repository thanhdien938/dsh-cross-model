import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { LoginTerminalSession } from '../electron/main/services/loginTerminalService';

// A fake child_process-shaped EventEmitter. Using a fully fake spawnImpl
// (rather than a real spawned process) proves the session's own
// buffering/sanitization/bounding/closed-command logic deterministically,
// without depending on OS process behavior or, critically, ever invoking a
// real CLI's real `login`/`logout` command against this machine's actual
// auth state.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { writes: [] as string[], write: (data: string) => { this.stdin.writes.push(data); } };
  pid = 4242;
  killed = false;
  kill() { this.killed = true; }
}

function fakeSpawn(calls: any[]) {
  return (binary: string, args: string[], options: any) => {
    const child = new FakeChild();
    calls.push({ binary, args, options });
    return child as any;
  };
}

const safeEnv = () => ({ PATH: process.env.PATH });
const trustedBinary = process.execPath;

describe('LoginTerminalSession', () => {
  it('refuses an unsupported product before any spawn', async () => {
    const calls: any[] = [];
    await expect(LoginTerminalSession.start('not-a-real-product', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => 'fake' })).rejects.toMatchObject({ code: 'LOGIN_PRODUCT_UNSUPPORTED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an unsupported mode before any spawn — no arbitrary subcommand is possible', async () => {
    const calls: any[] = [];
    await expect(LoginTerminalSession.start('codex', 'rm -rf', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => 'fake' })).rejects.toMatchObject({ code: 'LOGIN_MODE_UNSUPPORTED' });
    expect(calls).toHaveLength(0);
  });

  it('spawns with the exact closed argv, shell:false, and the resolved binary — nothing renderer-supplied reaches argv', async () => {
    const calls: any[] = [];
    await LoginTerminalSession.start('codex', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe(trustedBinary);
    expect(calls[0].args).toEqual(['login']);
    expect(calls[0].options.shell).toBe(false);
  });

  it('logout uses the exact closed argv too', async () => {
    const calls: any[] = [];
    await LoginTerminalSession.start('grok', 'logout', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls[0].args).toEqual(['logout']);
  });

  // P6-W3-R4 Part M: live-verified against the real installed CLIs — claude
  // and opencode have no bare top-level login/logout subcommand (unlike
  // codex/grok); the real invocation is `claude auth login`/`opencode auth
  // login`. Still exactly two bare positional words, still zero flags.
  it('claude-code uses `auth login`/`auth logout`, not a bare top-level subcommand', async () => {
    const calls: any[] = [];
    await LoginTerminalSession.start('claude-code', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls[0].args).toEqual(['auth', 'login']);
    calls.length = 0;
    await LoginTerminalSession.start('claude-code', 'logout', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls[0].args).toEqual(['auth', 'logout']);
  });

  it('opencode uses `auth login`/`auth logout`, not a bare top-level subcommand', async () => {
    const calls: any[] = [];
    await LoginTerminalSession.start('opencode', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls[0].args).toEqual(['auth', 'login']);
    calls.length = 0;
    await LoginTerminalSession.start('opencode', 'logout', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    expect(calls[0].args).toEqual(['auth', 'logout']);
  });

  it('buffers stdout/stderr, strips ANSI escape sequences, and emits data events', async () => {
    const calls: any[] = [];
    const session = await LoginTerminalSession.start('codex', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    const received: string[] = [];
    session.on('data', (chunk: string) => received.push(chunk));
    const child = (session as any).child as FakeChild;
    child.stdout.emit('data', Buffer.from('\x1b[32mVisit https://example.invalid/device\x1b[0m\n'));
    child.stderr.emit('data', Buffer.from('warning: something\n'));
    expect(received.join('')).toContain('Visit https://example.invalid/device');
    expect(received.join('')).not.toMatch(/\x1b\[/);
    expect(session.getBuffer()).toContain('warning: something');
  });

  it('bounds the retained buffer instead of growing unboundedly', async () => {
    const calls: any[] = [];
    const session = await LoginTerminalSession.start('codex', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    const child = (session as any).child as FakeChild;
    for (let i = 0; i < 500; i += 1) child.stdout.emit('data', Buffer.from('x'.repeat(1000)));
    expect(session.getBuffer().length).toBeLessThanOrEqual(200 * 1024);
  });

  it('write() forwards bounded stdin only — never re-spawns or changes the command', async () => {
    const calls: any[] = [];
    const session = await LoginTerminalSession.start('codex', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    session.write('123456\n');
    const child = (session as any).child as FakeChild;
    expect(child.stdin.writes).toEqual(['123456\n']);
    session.write('x'.repeat(10_000));
    expect(child.stdin.writes[1].length).toBeLessThanOrEqual(4096);
    expect(calls).toHaveLength(1); // still exactly one process ever spawned
  });

  it('emits exit and marks the session not-running; no auth-evidence side effect exists in this module', async () => {
    const calls: any[] = [];
    const session = await LoginTerminalSession.start('codex', 'logout', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    const exits: any[] = [];
    session.on('exit', (info: any) => exits.push(info));
    const child = (session as any).child as FakeChild;
    child.emit('exit', 0, null);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(session.isRunning()).toBe(false);
    // The service exposes no method that writes to any auth-evidence
    // store — only scanPmRunsForAuthEvidence (a real terminal PM run) can.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(session))).not.toContain('recordProven');
  });

  it('stop() kills the underlying process', async () => {
    const calls: any[] = [];
    const session = await LoginTerminalSession.start('codex', 'login', { spawnImpl: fakeSpawn(calls) as any, resolveBinary: async () => trustedBinary, buildProviderChildEnv: safeEnv });
    const child = (session as any).child as FakeChild;
    // Force the non-Windows path in this cross-platform unit test so we
    // don't depend on `taskkill` being on PATH in CI.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    session.stop();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    expect(child.killed).toBe(true);
  });
});
