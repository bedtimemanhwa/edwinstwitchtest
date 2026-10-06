// Local WebSocket fan-out. Overlays are read-only consumers: anything they send is ignored, so several OBS
// browser sources can show the same state without ever awarding anything twice. A client that joins late gets
// the current snapshot; finished celebrations are simply no longer in it.
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Engine } from "../engine/engine.js";
import type { DashboardInfo, ServerMessage, SessionKind } from "../../shared/types.js";

interface Client { ws: WebSocket; session: SessionKind; role: "overlay" | "dashboard" }

export class Hub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private clients = new Set<Client>();
  private pending = new Set<SessionKind>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly engines: Record<SessionKind, Engine>, private readonly dashboardInfo: (s: SessionKind) => DashboardInfo) {
    for (const k of Object.keys(engines) as SessionKind[]) engines[k].on("change", () => this.schedule(k));
    // Heartbeat keeps countdowns exact even when nothing else changes.
    this.timer = setInterval(() => { this.pending.add("live"); this.pending.add("demo"); this.flush(); }, 1000);
    this.timer.unref();
  }

  get size(): number { return this.clients.size; }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, session: SessionKind, role: Client["role"]): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { ws, session, role };
      this.clients.add(c);
      ws.on("close", () => this.clients.delete(c));
      ws.on("error", () => this.clients.delete(c));
      ws.on("message", () => { /* read-only: ignore */ });
      this.send(c, { t: "hello", session, role });
      this.send(c, this.message(session, role));
    });
  }

  /** Coalesce bursts of changes into at most ~12 updates a second. */
  private schedule(s: SessionKind): void {
    this.pending.add(s);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 80);
  }
  private flushTimer: NodeJS.Timeout | null = null;

  private flush(): void {
    const sessions = [...this.pending];
    this.pending.clear();
    for (const s of sessions) {
      const cache: Partial<Record<Client["role"], string>> = {};
      for (const c of this.clients) {
        if (c.session !== s) continue;
        cache[c.role] ??= JSON.stringify(this.message(s, c.role));
        if (c.ws.bufferedAmount < 1_000_000) c.ws.send(cache[c.role]!);
      }
    }
  }

  private message(s: SessionKind, role: Client["role"]): ServerMessage {
    const snapshot = this.engines[s].snapshot();
    return role === "dashboard" ? { t: "snapshot", snapshot, dashboard: this.dashboardInfo(s) } : { t: "snapshot", snapshot };
  }
  private send(c: Client, m: ServerMessage): void { c.ws.send(JSON.stringify(m)); }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.ws.close(1001);
    this.wss.close();
  }
}
