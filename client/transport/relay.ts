import type { Transport } from './types.js';
import { HIGH_WATER_BYTES } from './types.js';
import type { ClientSignal, ServerSignal } from '../../shared/signals.js';
import { parseServerSignal } from '../../shared/signals.js';

const DRAIN_POLL_MS = 25;

export interface RelayConnection {
  transport: RelayTransport;
  code: string;
  peerId: 'a' | 'b';
  peerPresent: boolean;
  /**
   * The address the relay saw this connection arrive from — the one fact
   * about this device that only the server can supply, since a browser
   * cannot see its own public address. Optional because an older relay does
   * not send it, and because a relay that was told not to trust its proxy
   * may have nothing useful to send.
   */
  ip?: string;
}

export class RelayTransport implements Transport {
  readonly kind = 'relay' as const;
  readonly #socket: WebSocket;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #onPeerJoined: (() => void) | undefined;
  /**
   * A room-presence signal, deliberately not routed through onClose (see
   * below). Symmetric with onPeerJoined, for the same reason: Session's
   * SwitchableTransport wraps this transport's onClose slot to decide
   * whether a swap should end the session, and detaches it once this
   * transport is no longer the live one — a peer leaving must still reach
   * Session even then, since it is a fact about the room, not about
   * whichever transport currently carries data.
   */
  #onPeerLeft: (() => void) | undefined;
  #onSignal: ((signal: ServerSignal) => void) | undefined;
  #drainTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        // Validated, not cast: the relay is untrusted, and `peerId` from a
        // created/joined signal ends up as the leading byte of every nonce
        // this peer derives. Anything that is not a signal is ignored.
        const signal = parseServerSignal(event.data);
        if (!signal) return;
        if (signal.t === 'peer-joined') this.#onPeerJoined?.();
        else if (signal.t === 'peer-left') this.#onPeerLeft?.();
        else this.#onSignal?.(signal);
        return;
      }
      this.#onMessage?.(new Uint8Array(event.data as ArrayBuffer));
    });

    socket.addEventListener('close', () => {
      this.#stopDrainPolling();
      this.#onClose?.('socket-closed');
    });
  }

  static connect(url: string, intent: { t: 'create' } | { t: 'join'; code: string }): Promise<RelayConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const transport = new RelayTransport(socket);

      const settle = (signal: ServerSignal): void => {
        if (signal.t === 'error') { socket.close(); reject(new Error(signal.reason)); return; }
        if (signal.t !== 'created' && signal.t !== 'joined') return;
        transport.#onSignal = undefined;
        resolve({
          transport,
          code: signal.code,
          peerId: signal.peerId,
          peerPresent: signal.t === 'joined',
          ip: signal.ip,
        });
      };

      transport.#onSignal = settle;
      socket.addEventListener('error', () => reject(new Error('websocket error')));
      // A socket that opens and is then closed with no 'error' at all is a
      // real outcome — a relay that accepts the connection and drops it, a
      // proxy timing out the upgrade. Without this the promise stayed
      // pending forever, and every caller waiting on it stalled silently:
      // Reconnector.#schedule awaits this before scheduling its next retry,
      // so one such close ended the retry chain outright and onGaveUp never
      // fired. Rejecting an already-settled promise is a no-op, so this
      // needs no "was it settled?" bookkeeping of its own.
      socket.addEventListener('close', () => reject(new Error('socket-closed')));
      socket.addEventListener('open', () => socket.send(JSON.stringify(intent satisfies ClientSignal)));
    });
  }

  get bufferedAmount(): number { return this.#socket.bufferedAmount; }

  send(frame: Uint8Array): void {
    if (this.#socket.readyState !== 1) return;
    // Copy into a standalone ArrayBuffer: a view over a larger pooled buffer
    // would otherwise send the whole pool.
    this.#socket.send(frame.slice().buffer);
    this.#startDrainPollingIfNeeded();
  }

  sendSignal(signal: ClientSignal): void {
    if (this.#socket.readyState === 1) this.#socket.send(JSON.stringify(signal));
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }
  onPeerJoined(cb: () => void): void { this.#onPeerJoined = cb; }
  onPeerLeft(cb: () => void): void { this.#onPeerLeft = cb; }
  onSignal(cb: (signal: ServerSignal) => void): void { this.#onSignal = cb; }

  close(): void {
    this.#stopDrainPolling();
    this.#socket.close();
  }

  /**
   * WebSocket has no bufferedamountlow event, so drain is polled. The timer
   * only runs while the socket is actually backed up.
   */
  #startDrainPollingIfNeeded(): void {
    if (this.#drainTimer !== undefined) return;
    if (this.#socket.bufferedAmount < HIGH_WATER_BYTES) return;
    this.#drainTimer = setInterval(() => {
      if (this.#socket.bufferedAmount < HIGH_WATER_BYTES) {
        this.#stopDrainPolling();
        this.#onDrain?.();
      }
    }, DRAIN_POLL_MS);
  }

  #stopDrainPolling(): void {
    if (this.#drainTimer === undefined) return;
    clearInterval(this.#drainTimer);
    this.#drainTimer = undefined;
  }
}
