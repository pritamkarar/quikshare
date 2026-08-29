import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';
import { confirmBoth, waitFor } from '../pairing.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('ending a session deliberately', () => {
  it('tells the peer it was ended on purpose, not merely dropped', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);

    let guestReason: string | undefined;
    guest.events.onSessionEnded = (reason) => { guestReason = reason; };
    await confirmBoth(host, guest);

    await host.endSession();

    // 'peer-ended' rather than a bare disconnect: this is the whole point of
    // the frame. A dropped socket and a deliberate end look identical to the
    // relay, and only the leaving device knows which one happened.
    await waitFor(() => guestReason !== undefined);
    expect(guestReason).toBe('peer-ended');
  });

  it('can be sent before the verification gate has opened', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);

    let guestReason: string | undefined;
    guest.events.onSessionEnded = (reason) => { guestReason = reason; };
    // Deliberately no confirmBoth. "End session" is on screen from the moment
    // the session is connected (client/ui/SessionHeader.tsx renders it beside
    // the verification panel, not after it), so a gate that refuses this
    // frame would strand the peer on the rejoin screen for the one exit the
    // user is most likely to take while comparing numbers.
    await waitFor(() => host.verification !== undefined && guest.verification !== undefined);

    await host.endSession();

    await waitFor(() => guestReason !== undefined);
    expect(guestReason).toBe('peer-ended');
  });

  it('resolves even with no peer to tell', async () => {
    const url = await start();
    const host = await Session.create(url);

    // Nobody has joined. The caller navigates away on this resolving, so a
    // promise that only settles when a peer acknowledges would hang the one
    // button whose whole job is to leave.
    await expect(host.endSession()).resolves.toBeUndefined();
  });
});
