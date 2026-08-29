import { describe, expect, it } from 'vitest';
import { BLOB_SINK_MAX_BYTES, createBlobSink } from '../../client/save/blob.js';

const meta = { id: 1, name: 'a.bin', size: 3, type: 'application/octet-stream' };

describe('blob sink', () => {
  it('assembles written chunks in order', async () => {
    const sink = createBlobSink(meta);
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    const blob = await sink.close();
    expect(blob).toBeDefined();
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('applies the declared MIME type', async () => {
    const sink = createBlobSink({ ...meta, type: 'text/plain' });
    await sink.write(new Uint8Array([65]));
    expect((await sink.close())?.type).toBe('text/plain');
  });

  it('refuses a file beyond the memory ceiling', () => {
    const sink = createBlobSink({ ...meta, size: BLOB_SINK_MAX_BYTES + 1 });
    expect(() => sink.assertWithinCap(BLOB_SINK_MAX_BYTES + 1)).toThrow(/too large/i);
  });

  it('accepts a file exactly at the ceiling', () => {
    const sink = createBlobSink({ ...meta, size: BLOB_SINK_MAX_BYTES });
    expect(() => sink.assertWithinCap(BLOB_SINK_MAX_BYTES)).not.toThrow();
  });

  it('discards buffered chunks on abort', async () => {
    const sink = createBlobSink(meta);
    await sink.write(new Uint8Array([1]));
    await sink.abort('cancelled');
    expect(await sink.close()).toBeUndefined();
  });
});
