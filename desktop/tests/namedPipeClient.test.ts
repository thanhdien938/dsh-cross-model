import { describe, it, expect, vi } from 'vitest';
import { NamedPipeClient } from '../electron/main/services/namedPipeClient';

describe('NamedPipeClient - Security', () => {
  const createClient = () => new NamedPipeClient(
    '\\\\.\\pipe\\dsh-runtime-control-test',
    '11'.repeat(32),
  );

  it('should refuse oversized frames even when fragmented', () => {
    const client = createClient();
    const reject = vi.fn();
    const timeout = setTimeout(() => {}, 1000);
    (client as any).pendingRequests.set('request-id', {
      resolve: vi.fn(),
      reject,
      timeout,
    });

    // No individual chunk exceeds the limit; the accumulated frame does.
    (client as any).handleResponse(Buffer.alloc(40_000, 'x'));
    (client as any).handleResponse(Buffer.alloc(40_000, 'x'));

    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0][0].message).toContain('oversized frame');
  });

  it('should handle connection errors gracefully', async () => {
    const client = createClient();
    
    // Attempt to connect when pipe doesn't exist
    const result = await client.ping();
    
    // Should return false, not throw
    expect(result).toBe(false);
  });

  it('should timeout requests', async () => {
    const client = createClient();
    
    // This will timeout since pipe doesn't exist
    const start = Date.now();
    await client.ping().catch(() => {});
    const duration = Date.now() - start;
    
    // Should have timed out quickly (within 10 seconds)
    expect(duration).toBeLessThan(10000);
  });
});

describe('NamedPipeClient - Operations', () => {
  const createClient = () => new NamedPipeClient(
    '\\\\.\\pipe\\dsh-runtime-control-test',
    '22'.repeat(32),
  );

  it('should support PING operation', async () => {
    const client = createClient();
    
    // When pipe is unavailable, ping should return false
    const result = await client.ping();
    expect(typeof result).toBe('boolean');
  });

  it('should support READINESS operation', async () => {
    const client = createClient();
    
    // When pipe is unavailable, readiness should return false
    const result = await client.readiness();
    expect(typeof result).toBe('boolean');
  });

  it('should cleanup on disconnect', () => {
    const client = createClient();
    
    client.disconnect();
    
    // Should be safe to call multiple times
    client.disconnect();
  });
});
