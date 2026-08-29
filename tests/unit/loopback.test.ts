// tests/unit/loopback.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey } from '../../client/crypto.js';
import { CHUNK_SIZE, Sender } from '../../client/transfer/sender.js';
import { Receiver } from '../../client/transfer/receiver.js';
import { TransportSwapGate } from '../../client/transport/upgrade.js';

async function transfer(bytes: Uint8Array, name = 'payload.bin'): Promise<Uint8Array> {
  const [a, b] = createMemoryPair();
  const raw = generateRawKey();
  const key = await importKey(raw);
  const senderPrefix = generateNoncePrefix();

  let resolveBlob!: (blob: Blob) => void;
  let rejectBlob!: (error: Error) => void;
  const done = new Promise<Blob>((resolve, reject) => { resolveBlob = resolve; rejectBlob = reject; });

  const receiver = new Receiver({
    transport: b,
    key,
    peerId: 'b',
    remoteNoncePrefix: senderPrefix,
    events: {
      onOffer: vi.fn(),
      onProgress: vi.fn(),
      onText: vi.fn(),
      onError: (e) => rejectBlob(new Error(e.message)),
      onFileComplete: ({ blob }) => {
        // Without this branch a broken receiver that completes with no blob
        // (e.g. createBlobSink.close() after an abort) hangs the test on a
        // timeout instead of failing with a clear diagnostic.
        if (blob) resolveBlob(blob);
        else rejectBlob(new Error('file completed with no blob'));
      },
    },
  });
  receiver.start();

  const sender = new Sender({
    transport: a,
    key,
    peerId: 'a',
    noncePrefix: senderPrefix,
    initialSeq: 0n,
    initialFileId: 1,
    gate: new TransportSwapGate(),
    events: { onProgress: vi.fn(), onFileDone: vi.fn() },
  });
  // `as BlobPart`: TS 5.7+ types a bare Uint8Array parameter as
  // Uint8Array<ArrayBufferLike>, which File's BlobPart union (ArrayBufferView
  // over ArrayBuffer specifically) doesn't accept. Same cause as the
  // BufferSource cast documented in client/crypto.ts; type-only, no copy.
  await sender.sendFiles([new File([bytes as BlobPart], name)]);
  return new Uint8Array(await (await done).arrayBuffer());
}

describe('sender to receiver loopback', () => {
  it('moves a small file byte-identically', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect([...(await transfer(bytes))]).toEqual([...bytes]);
  });

  it('moves a multi-chunk file byte-identically', async () => {
    const bytes = new Uint8Array(CHUNK_SIZE * 3 + 17);
    globalThis.crypto.getRandomValues(bytes.subarray(0, 65536));
    for (let i = 65536; i < bytes.length; i++) bytes[i] = i % 251;
    const received = await transfer(bytes);
    expect(received.length).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(received), Buffer.from(bytes))).toBe(0);
  });
});
