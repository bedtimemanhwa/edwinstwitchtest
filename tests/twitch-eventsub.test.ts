import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { EventSubClient, EVENTSUB_URL, type SocketLike } from "../src/server/twitch/eventsub.js";

class FakeSocket extends EventEmitter {
  closed: number | null = null;
  constructor(readonly url: string) { super(); }
  close(code = 1000) { this.closed = code; }
  terminate() { this.closed = 1006; }
  push(type: string, payload: Record<string, unknown> = {}) {
    this.emit("message", JSON.stringify({ metadata: { message_id: Math.random().toString(), message_type: type, message_timestamp: "" }, payload }));
  }
  welcome(id: string, keepalive = 10) { this.push("session_welcome", { session: { id, status: "connected", keepalive_timeout_seconds: keepalive, reconnect_url: null } }); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const c = new EventSubClient({ connect: (url) => { const s = new FakeSocket(url); sockets.push(s); return s as unknown as SocketLike; }, random: () => 1, baseDelayMs: 1000, maxDelayMs: 8000 });
  const ev: { type: string; args: unknown[] }[] = [];
  for (const t of ["welcome", "notification", "revocation", "down", "retry", "transferring"]) c.on(t, (...args) => ev.push({ type: t, args }));
  return { c, sockets, ev };
}

describe("EventSub WebSocket lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects to the documented URL and reports a fresh welcome", () => {
    const { c, sockets, ev } = setup();
    c.start();
    expect(sockets[0].url).toBe(EVENTSUB_URL);
    sockets[0].welcome("sess-1");
    expect(ev).toContainEqual({ type: "welcome", args: ["sess-1", { transferred: false }] });
    expect(c.sessionId).toBe("sess-1");
  });

  it("treats a missed keepalive as a lost connection and reconnects with backoff", () => {
    const { c, sockets, ev } = setup();
    c.start();
    sockets[0].welcome("s1", 10);
    vi.advanceTimersByTime(9000);
    sockets[0].push("session_keepalive");
    vi.advanceTimersByTime(12_500);
    expect(ev.some((e) => e.type === "down")).toBe(false); // still inside keepalive (10 s) + grace (3 s)
    vi.advanceTimersByTime(1_000);
    expect(ev.some((e) => e.type === "down" && e.args[0] === "keepalive timeout")).toBe(true);
    expect(sockets[0].closed).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].welcome("s2");
    expect(ev.filter((e) => e.type === "welcome").at(-1)?.args).toEqual(["s2", { transferred: false }]); // fresh: resubscribe
  });

  it("session_reconnect: connects to the given URL, closes the old socket only after the new welcome, keeps subscriptions", () => {
    const { c, sockets, ev } = setup();
    c.start();
    sockets[0].welcome("s1");
    sockets[0].push("session_reconnect", { session: { id: "s1", reconnect_url: "wss://eventsub.wss.twitch.tv/ws?id=abc" } });
    expect(sockets[1].url).toBe("wss://eventsub.wss.twitch.tv/ws?id=abc");
    expect(sockets[0].closed).toBeNull();
    sockets[1].welcome("s1");
    expect(sockets[0].closed).toBe(1000);
    expect(ev.filter((e) => e.type === "welcome").at(-1)?.args).toEqual(["s1", { transferred: true }]);
    expect(ev.some((e) => e.type === "down")).toBe(false); // the transfer is not an outage
    sockets[1].push("notification", { event: {} });
    expect(ev.some((e) => e.type === "notification")).toBe(true);
  });

  it("reports revocations", () => {
    const { c, sockets, ev } = setup();
    c.start();
    sockets[0].welcome("s1");
    sockets[0].push("revocation", { subscription: { type: "channel.subscribe", status: "authorization_revoked" } });
    expect(ev).toContainEqual({ type: "revocation", args: [{ type: "channel.subscribe", status: "authorization_revoked" }] });
  });

  it("network loss: bounded exponential backoff", () => {
    const { c, sockets, ev } = setup();
    c.start();
    for (let i = 0; i < 6; i++) {
      sockets.at(-1)!.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(10_000);
    }
    const delays = ev.filter((e) => e.type === "retry").map((e) => e.args[0]);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(sockets.length).toBe(7);
  });

  it("stop() closes cleanly and does not reconnect", () => {
    const { c, sockets, ev } = setup();
    c.start();
    sockets[0].welcome("s1");
    c.stop();
    sockets[0].emit("close", 1000, Buffer.from(""));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(ev.some((e) => e.type === "down")).toBe(false);
  });
});
