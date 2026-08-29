import { describe, expect, it } from 'vitest';
import { FrameType, HEADER_BYTES, decodeControl, decodeFrame, encodeControl, encodeFrame } from '../../client/protocol.js';

describe('frame types', () => {
  /**
   * The additive property is load-bearing: Hello was appended after Control
   * and Data were already on the wire, so renumbering either would silently
   * reinterpret every frame a peer on the older build sends.
   */
  it('pins the wire values, with Hello appended', () => {
    expect(FrameType.Control).toBe(0);
    expect(FrameType.Data).toBe(1);
    expect(FrameType.Hello).toBe(2);
  });

  it('survives a round trip through the header byte', () => {
    expect(decodeFrame(encodeFrame(FrameType.Hello, 0, 0n, new Uint8Array([7]))).type)
      .toBe(FrameType.Hello);
  });
});

describe('frame codec', () => {
  it('round-trips a data frame', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeFrame(FrameType.Data, 7, 42n, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe(FrameType.Data);
    expect(decoded.fileId).toBe(7);
    expect(decoded.seq).toBe(42n);
    expect([...decoded.payload]).toEqual([1, 2, 3, 250]);
  });

  it('uses a 13-byte header', () => {
    expect(encodeFrame(FrameType.Data, 0, 0n, new Uint8Array(0))).toHaveLength(HEADER_BYTES);
  });

  it('round-trips an empty payload', () => {
    const decoded = decodeFrame(encodeFrame(FrameType.Control, 0, 0n, new Uint8Array(0)));
    expect(decoded.payload).toHaveLength(0);
  });

  it('handles the maximum u32 file id', () => {
    const decoded = decodeFrame(encodeFrame(FrameType.Data, 0xffffffff, 0n, new Uint8Array(1)));
    expect(decoded.fileId).toBe(0xffffffff);
  });

  it('handles a sequence number beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 2n ** 53n + 7n;
    expect(decodeFrame(encodeFrame(FrameType.Data, 1, big, new Uint8Array(1))).seq).toBe(big);
  });

  it('round-trips a maximum-size payload', () => {
    const payload = new Uint8Array(65536 - HEADER_BYTES).fill(0xab);
    const frame = encodeFrame(FrameType.Data, 1, 1n, payload);
    expect(frame).toHaveLength(65536); // the WebRTC DataChannel ceiling
    expect(decodeFrame(frame).payload).toHaveLength(65536 - HEADER_BYTES);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodeFrame(new Uint8Array(HEADER_BYTES - 1))).toThrow(/too short/i);
  });

  it('does not alias the source buffer', () => {
    const encoded = encodeFrame(FrameType.Data, 1, 1n, new Uint8Array([9, 9, 9]));
    const decoded = decodeFrame(encoded);
    // Mutate the frame decodeFrame was given, not the pre-encode source —
    // encodeFrame already copied that, so touching it proves nothing.
    encoded[HEADER_BYTES] = 0;
    expect(decoded.payload[0]).toBe(9);
  });
});

describe('control codec', () => {
  it('round-trips a control message', () => {
    const msg = { t: 'text', content: 'hello — "curly"' } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  it('survives non-ASCII filenames', () => {
    const msg = {
      t: 'offer-batch',
      batchId: 'b1',
      files: [{ id: 1, name: 'résumé 日本語.pdf', size: 10, type: 'application/pdf' }],
    } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });
});
