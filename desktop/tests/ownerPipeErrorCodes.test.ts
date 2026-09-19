import { describe, it, expect, vi } from 'vitest';
import { NamedPipeClient, OwnerPipeError } from '../electron/main/services/namedPipeClient';

// P12-R5B Part E: mirrors src/runtime/local-runtime-control.mjs's own
// KNOWN_OWNER_ERROR_CODES addition — real, typed OwnerControlError codes
// (an inactive PM profile, a council spec naming an unregistered profile)
// were never forwarded by THIS client either, so even after the runtime
// side stopped genericizing them, this Desktop client would have
// re-genericized them right back via toOwnerPipeError()'s fallback,
// leaving the owner with the exact same unhelpful "OWNER_COMMAND_FAILED"
// regardless of the runtime-side fix. Reaches into the client's own
// internals to inject a fake pipe response, exactly like the existing
// `namedPipeClient.test.ts` oversized-frame test already does — no real
// pipe server is needed to prove this specific mapping.
function connectedClientWithPendingRequest() {
  const client = new NamedPipeClient('\\\\.\\pipe\\dsh-r5b-test', '11'.repeat(32));
  // Short-circuits connect(): "already connected, not destroyed".
  (client as any).client = { destroyed: false, write: vi.fn() };
  return client;
}

async function driveResponse(client: NamedPipeClient, promise: Promise<any>, errorCode: string) {
  // ownerMutate() awaits connect() before sendRequest() ever registers the
  // pending request, so the entry does not exist on the same microtask
  // ownerMutate() was called on — poll a few ticks until it appears.
  let id: string | undefined;
  for (let i = 0; i < 50 && !id; i += 1) {
    [id] = (client as any).pendingRequests.keys();
    if (!id) await new Promise((resolve) => setImmediate(resolve));
  }
  if (!id) throw new Error('pending request never registered');
  (client as any).handleResponse(Buffer.from(`${JSON.stringify({ id, success: false, error: errorCode })}\n`));
  return promise;
}

describe('NamedPipeClient — P12-R5B typed error code passthrough', () => {
  it('forwards COUNCIL_UNKNOWN_PARTICIPANT verbatim, not the generic OWNER_COMMAND_FAILED fallback', async () => {
    const client = connectedClientWithPendingRequest();
    const promise = client.ownerMutate('SUBMIT_TASK', { command_id: 'c1', payload: { body: 'x' } });
    await expect(driveResponse(client, promise, 'COUNCIL_UNKNOWN_PARTICIPANT')).rejects.toMatchObject({ code: 'COUNCIL_UNKNOWN_PARTICIPANT' });
  });

  it('forwards COUNCIL_UNKNOWN_CHAIR verbatim', async () => {
    const client = connectedClientWithPendingRequest();
    const promise = client.ownerMutate('SUBMIT_TASK', { command_id: 'c2', payload: { body: 'x' } });
    await expect(driveResponse(client, promise, 'COUNCIL_UNKNOWN_CHAIR')).rejects.toMatchObject({ code: 'COUNCIL_UNKNOWN_CHAIR' });
  });

  it('forwards PM_PROFILE_INACTIVE verbatim', async () => {
    const client = connectedClientWithPendingRequest();
    const promise = client.ownerMutate('SUBMIT_TASK', { command_id: 'c3', payload: { body: 'x' } });
    await expect(driveResponse(client, promise, 'PM_PROFILE_INACTIVE')).rejects.toMatchObject({ code: 'PM_PROFILE_INACTIVE' });
  });

  it('every other new council-validation code is also allow-listed, not silently re-genericized', async () => {
    const codes = [
      'COUNCIL_INVALID_SPEC', 'COUNCIL_INVALID_PROFILE_ID', 'COUNCIL_ZERO_PARTICIPANTS',
      'COUNCIL_DUPLICATE_PARTICIPANT', 'COUNCIL_TOO_MANY_PARTICIPANTS', 'COUNCIL_INVALID_ROUNDS',
      'COUNCIL_UNSUPPORTED_STRATEGY',
    ];
    for (const code of codes) {
      const client = connectedClientWithPendingRequest();
      const promise = client.ownerMutate('SUBMIT_TASK', { command_id: `c-${code}`, payload: { body: 'x' } });
      await expect(driveResponse(client, promise, code)).rejects.toMatchObject({ code });
    }
  });

  it('regression: a genuinely unknown code is still mapped to the safe local-transport fallback, never leaked verbatim', async () => {
    const client = connectedClientWithPendingRequest();
    const promise = client.ownerMutate('SUBMIT_TASK', { command_id: 'c4', payload: { body: 'x' } });
    const settled = driveResponse(client, promise, 'SOME_UNEXPECTED_CODE');
    await expect(settled).rejects.toBeInstanceOf(OwnerPipeError);
    await expect(settled).rejects.toMatchObject({ code: 'LOCAL_OWNER_PIPE_UNAVAILABLE' });
  });
});
