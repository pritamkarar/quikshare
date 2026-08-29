import type { Transport } from './types.js';

class MemoryTransport implements Transport {
  readonly kind = 'relay' as const;
  peer: MemoryTransport | undefined;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closed = false;

  get bufferedAmount(): number { return 0; }

  send(frame: Uint8Array): void {
    if (this.#closed) return;
    const copy = frame.slice();
    // Deliver asynchronously so behaviour matches a real network transport.
    queueMicrotask(() => this.peer?.receive(copy));
  }

  receive(frame: Uint8Array): void {
    this.#onMessage?.(frame);
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(_cb: () => void): void { /* never buffers */ }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Mirror RelayTransport: the closing side sees its own socket close,
    // the peer separately sees the partner leave. Both async, like a real one.
    queueMicrotask(() => this.#onClose?.('socket-closed'));
    queueMicrotask(() => this.peer?.remoteClosed());
  }

  remoteClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.('peer-left');
  }
}

export function createMemoryPair(): [Transport, Transport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
