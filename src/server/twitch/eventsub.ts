// EventSub over WebSocket: welcome -> subscribe within 10 s, keepalive watchdog, session_reconnect transfer
// (subscriptions move with the session, so they are NOT recreated), revocation, and bounded exponential
// backoff with jitter after a real loss (then a fresh session, so subscriptions ARE recreated).
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";

export interface SocketLike {
  on(ev: "message", cb: (data: Buffer | string) => void): unknown;
  on(ev: "close", cb: (code: number, reason: Buffer) => void): unknown;
  on(ev: "error", cb: (err: Error) => void): unknown;
  close(code?: number): void;
  terminate?(): void;
}

export interface EventSubOptions {
  url?: string;
  connect?: (url: string) => SocketLike;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  graceMs?: number;
}

type Envelope = { metadata: { message_id: string; message_type: string }; payload: Record<string, unknown> };

export class EventSubClient extends EventEmitter {
  private ws: SocketLike | null = null;
  private pending: SocketLike | null = null;
  private retired = new Set<SocketLike>();
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private keepaliveMs = 10_000;
  private attempt = 0;
  private stopped = true;
  sessionId: string | null = null;

  constructor(private readonly opts: EventSubOptions = {}) { super(); }

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.open(this.opts.url ?? EVENTSUB_URL, false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const s of [this.ws, this.pending]) if (s) { this.retired.add(s); s.close(1000); }
    this.ws = this.pending = null;
    this.sessionId = null;
  }

  get connected(): boolean { return !!this.sessionId; }

  private open(url: string, transfer: boolean): SocketLike {
    const sock = this.opts.connect ? this.opts.connect(url) : (new WebSocket(url) as unknown as SocketLike);
    if (transfer) this.pending = sock; else this.ws = sock;
    sock.on("message", (d) => this.onMessage(sock, d));
    sock.on("close", (code) => this.onClose(sock, code));
    sock.on("error", (err) => this.emit("socket-error", err.message));
    return sock;
  }

  private onMessage(sock: SocketLike, data: Buffer | string): void {
    if (this.retired.has(sock)) return;
    let msg: Envelope;
    try { msg = JSON.parse(String(data)) as Envelope; } catch { return; }
    const type = msg?.metadata?.message_type;
    if (sock === this.ws || (sock === this.pending && type === "session_welcome")) this.armWatchdog();
    switch (type) {
      case "session_welcome": {
        const session = msg.payload.session as { id: string; keepalive_timeout_seconds: number | null };
        this.keepaliveMs = (session.keepalive_timeout_seconds ?? 10) * 1000;
        this.sessionId = session.id;
        if (sock === this.pending) {
          // Transfer complete: close the old connection only now. Subscriptions came with the session.
          const old = this.ws;
          this.ws = sock;
          this.pending = null;
          if (old) { this.retired.add(old); old.close(1000); }
          this.emit("welcome", session.id, { transferred: true });
        } else {
          this.attempt = 0;
          this.emit("welcome", session.id, { transferred: false });
        }
        break;
      }
      case "session_keepalive":
        break;
      case "notification":
        this.emit("notification", msg);
        break;
      case "session_reconnect": {
        const url = (msg.payload.session as { reconnect_url: string }).reconnect_url;
        this.emit("transferring");
        this.open(url, true); // use the URL exactly as given
        break;
      }
      case "revocation":
        this.emit("revocation", msg.payload.subscription);
        break;
    }
  }

  private onClose(sock: SocketLike, code: number): void {
    if (this.retired.has(sock)) { this.retired.delete(sock); return; }
    if (sock === this.pending) {
      // The transfer target failed; keep the old connection, which will close after its grace period.
      this.pending = null;
      return;
    }
    if (sock !== this.ws || this.stopped) return;
    this.lost(`closed (${code})`);
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.lost("keepalive timeout"), this.keepaliveMs + (this.opts.graceMs ?? 3000));
  }

  /** The connection is gone: report the gap and reconnect with bounded exponential backoff and jitter. */
  private lost(reason: string): void {
    if (this.stopped) return;
    this.clearTimers();
    const dead = this.ws;
    this.ws = null;
    this.sessionId = null;
    if (dead) { this.retired.add(dead); (dead.terminate ?? dead.close).call(dead); }
    this.emit("down", reason);
    const base = this.opts.baseDelayMs ?? 1000, max = this.opts.maxDelayMs ?? 60_000;
    const ceiling = Math.min(max, base * 2 ** this.attempt);
    const delay = Math.round(ceiling * (0.5 + 0.5 * (this.opts.random ?? Math.random)()));
    this.attempt = Math.min(this.attempt + 1, 16);
    this.emit("retry", delay);
    this.retryTimer = setTimeout(() => { if (!this.stopped) this.open(this.opts.url ?? EVENTSUB_URL, false); }, delay);
  }

  private clearTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.watchdog = this.retryTimer = null;
  }
}
