/**
 * Reconnecting WebSocket wrapper shared by the room socket and the per-user
 * notification hub.
 *
 * Connection states are explicit — connecting / open / reconnecting / closed /
 * failed — because the UI shows them and because call setup depends on knowing
 * whether signalling can be delivered.
 */

export const ConnectionState = {
  CONNECTING: "connecting",
  OPEN: "connected",
  RECONNECTING: "reconnecting",
  CLOSED: "closed",
  FAILED: "failed",
};

const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 20_000;
const PING_INTERVAL_MS = 20_000;
/** No pong within this window means the connection is dead, not just idle. */
const PONG_TIMEOUT_MS = 10_000;

export class RealtimeSocket {
  /**
   * @param {object} options
   * @param {string} options.url          full WebSocket URL (token included by the caller)
   * @param {(event: object) => void} options.onEvent
   * @param {(state: string, detail: object) => void} options.onState
   * @param {boolean} [options.ping]      send keep-alive pings
   */
  constructor({ url, onEvent, onState, ping = false }) {
    this.url = url;
    this.onEvent = onEvent;
    this.onState = onState;
    this.ping = ping;

    this.socket = null;
    this.state = ConnectionState.CLOSED;
    this.attempts = 0;
    this.pingTimer = null;
    this.pongTimer = null;
    this.retryTimer = null;
    this.closedByUs = false;
  }

  open() {
    this.closedByUs = false;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.#setState(ConnectionState.CONNECTING);

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.#setState(ConnectionState.OPEN);
      this.#startPing();
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload?.type === "pong") {
        this.#clearPongTimer();
        return;
      }
      this.onEvent(payload);
    });

    socket.addEventListener("close", (event) => {
      this.#stopPing();
      if (this.closedByUs) {
        this.#setState(ConnectionState.CLOSED);
        return;
      }
      // 1008/4401 style codes mean the server refused us: stop hammering it.
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.#setState(ConnectionState.FAILED, event);
        return;
      }
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // `close` always follows; reconnection is handled there.
    });
  }

  close(code = 1000) {
    this.closedByUs = true;
    this.#stopPing();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.socket && this.socket.readyState <= 1) {
      try {
        this.socket.close(code, "client closed");
      } catch {
        /* already gone */
      }
    }
    this.socket = null;
    this.#setState(ConnectionState.CLOSED);
  }

  /** Reconnect immediately (used after regaining network or changing tabs). */
  retryNow() {
    if (this.closedByUs) return;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.open();
  }

  get isOpen() {
    return this.socket?.readyState === 1;
  }

  /** Connected *and* actually usable — a socket can be half-open. */
  get isConnected() {
    return this.state === ConnectionState.OPEN && this.isOpen;
  }

  /** Nudge a socket that stopped being usable without firing `close`. */
  forceReconnect(reason = "socket unusable") {
    if (this.closedByUs) return;
    try {
      this.socket?.close(4000, reason);
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.#stopPing();
    this.#setState(ConnectionState.RECONNECTING, { reason });
    this.#scheduleReconnect();
  }

  send(payload) {
    if (!this.isOpen) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  #scheduleReconnect() {
    this.attempts += 1;
    if (this.attempts > 12) {
      this.#setState(ConnectionState.FAILED);
      return;
    }
    this.#setState(ConnectionState.RECONNECTING, { attempt: this.attempts });
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempts - 1), MAX_BACKOFF_MS);
    // Jitter avoids a thundering herd when many clients reconnect at once.
    const jitter = Math.random() * 400;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), delay + jitter);
  }

  #startPing() {
    if (!this.ping) return;
    this.#stopPing();
    this.pingTimer = setInterval(() => {
      if (this.closedByUs) return;
      if (!this.isOpen) {
        // Half-open: the browser never delivered a close event (dropped
        // tunnel, sleeping laptop). Treat it as dead instead of waiting.
        this.forceReconnect("no open socket");
        return;
      }
      if (!this.send({ type: "ping" })) return;
      // A TCP connection can stay "open" long after the network is gone.
      // A missing pong is the only reliable signal, so treat it as a dead
      // socket and reconnect.
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => this.forceReconnect("no pong"), PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #clearPongTimer() {
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  #stopPing() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  #setState(state, detail) {
    this.state = state;
    this.onState?.(state, detail ?? {});
  }
}