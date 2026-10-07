import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TwitchAuth, redact } from "../src/server/twitch/auth.js";
import { Helix } from "../src/server/twitch/api.js";
import { TwitchManager } from "../src/server/twitch/manager.js";
import type { EventSubClient } from "../src/server/twitch/eventsub.js";
import { Engine } from "../src/server/engine/engine.js";
import { Store } from "../src/server/persistence/store.js";
import { BROADCASTER, chat, gift } from "./fixtures.js";

type Call = { url: string; method: string; body: string; auth: string };

/** A scripted stand-in for id.twitch.tv and api.twitch.tv. */
function fakeTwitch(o: { scopes?: string[]; validate?: (n: number) => number; refresh?: (n: number) => number; subscribe?: (type: string) => number } = {}) {
  const calls: Call[] = [];
  let validates = 0, refreshes = 0, token = 1;
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET", body = String(init?.body ?? "");
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    calls.push({ url, method, body, auth });
    if (url.endsWith("/oauth2/validate")) {
      const st = o.validate?.(validates++) ?? 200;
      return st === 200 ? json(200, { client_id: "cid", login: "hulkstreams", user_id: BROADCASTER, scopes: o.scopes ?? ["user:read:chat", "channel:read:subscriptions"], expires_in: 14000 }) : json(st, { status: st, message: "invalid access token" });
    }
    if (url.endsWith("/oauth2/token")) {
      if (body.includes("grant_type=refresh_token")) {
        const st = o.refresh?.(refreshes++) ?? 200;
        return st === 200 ? json(200, { access_token: `at-${++token}`, refresh_token: `rt-${token}`, expires_in: 14000, scope: o.scopes ?? ["user:read:chat", "channel:read:subscriptions"] }) : json(st, { status: st, message: "Invalid refresh token" });
      }
      return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 14000, scope: o.scopes ?? [] });
    }
    if (url.endsWith("/eventsub/subscriptions")) {
      const type = (JSON.parse(body) as { type: string }).type;
      const st = o.subscribe?.(type) ?? 202;
      return st === 202 ? json(202, { data: [{ id: `id-${type}`, status: "enabled", type }] }) : json(st, { error: "Forbidden", status: st, message: "subscription missing proper authorization" });
    }
    return json(404, {});
  }) as typeof fetch;
  return { f, calls };
}

class FakeEventSub extends EventEmitter {
  started = 0; stopped = 0;
  start() { this.started++; }
  stop() { this.stopped++; }
}

function setup(o: Parameters<typeof fakeTwitch>[0] = {}, signedIn = true) {
  const dir = mkdtempSync(join(tmpdir(), "hh-tw-"));
  const { f, calls } = fakeTwitch(o);
  const auth = new TwitchAuth({ clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:3977/auth/callback", tokenPath: join(dir, "t.json"), fetch: f });
  if (signedIn) (auth as unknown as { save: (t: unknown) => void }).save({ accessToken: "at-1", refreshToken: "rt-1", scopes: o.scopes ?? ["user:read:chat", "channel:read:subscriptions"], expiresAt: Date.now() + 3_600_000, userId: BROADCASTER, login: "hulkstreams" });
  const engine = new Engine(new Store(":memory:"), { session: "live" });
  const es = new FakeEventSub();
  const logs: string[] = [];
  const m = new TwitchManager({ auth, helix: new Helix(auth, "cid", f), eventsub: es as unknown as EventSubClient, engine, log: (x) => logs.push(x) });
  return { m, auth, engine, es, calls, logs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Twitch manager", () => {
  it("startup: validates, connects, and creates the four subscriptions on a fresh welcome", async () => {
    const { m, es, calls } = setup();
    await m.start();
    expect(calls[0].url).toContain("/oauth2/validate");
    expect(es.started).toBe(1);
    es.emit("welcome", "sess-1", { transferred: false });
    await tick(); await tick();
    const subs = calls.filter((c) => c.url.endsWith("/eventsub/subscriptions"));
    expect(subs.map((c) => JSON.parse(c.body).type).sort()).toEqual(["channel.chat.message", "channel.subscribe", "channel.subscription.gift", "channel.subscription.message"]);
    const chatSub = JSON.parse(subs.find((c) => c.body.includes("chat.message"))!.body);
    expect(chatSub).toMatchObject({ version: "1", condition: { broadcaster_user_id: BROADCASTER, user_id: BROADCASTER }, transport: { method: "websocket", session_id: "sess-1" } });
    expect(m.info.state).toBe("connected");
  });

  it("a transferred session (session_reconnect) does not recreate subscriptions", async () => {
    const { m, es, calls } = setup();
    await m.start();
    es.emit("welcome", "s1", { transferred: false });
    await tick(); await tick();
    const before = calls.length;
    es.emit("welcome", "s1", { transferred: true });
    await tick();
    expect(calls.length).toBe(before);
  });

  it("token expiry: a 401 on validation triggers a refresh and carries on", async () => {
    const { m, es, calls } = setup({ validate: (n) => (n === 0 ? 401 : 200) });
    await m.start();
    expect(calls.some((c) => c.body.includes("grant_type=refresh_token"))).toBe(true);
    expect(es.started).toBe(1);
    expect(m.info.state).toBe("connecting");
  });

  it("revoked authorisation: a failed refresh signs out and stops EventSub with an actionable message", async () => {
    const { m, es, auth } = setup({ validate: () => 401, refresh: () => 400 });
    await m.start();
    expect(auth.signedIn).toBe(false);
    expect(m.info.state).toBe("signed-out");
    expect(m.info.lastError).toMatch(/Sign in again/);
    expect(es.started).toBe(0);
  });

  it("revocation message for authorization_revoked signs out", async () => {
    const { m, es, auth } = setup();
    await m.start();
    es.emit("revocation", { type: "channel.chat.message", status: "authorization_revoked" });
    expect(auth.signedIn).toBe(false);
    expect(m.info.state).toBe("signed-out");
  });

  it("missing the subscription scope: chat-only operation stays usable", async () => {
    const { m, es, calls } = setup({ scopes: ["user:read:chat"] });
    await m.start();
    expect(m.info.missingScopes).toEqual(["channel:read:subscriptions"]);
    es.emit("welcome", "s1", { transferred: false });
    await tick(); await tick();
    expect(calls.filter((c) => c.url.endsWith("/eventsub/subscriptions"))).toHaveLength(1);
    expect(m.info.state).toBe("connected");
    expect(m.info.chatOnly).toBe(true);
  });

  it("subscription events unavailable (403): explains why, chat keeps working", async () => {
    const { m, es } = setup({ subscribe: (t) => (t === "channel.chat.message" ? 202 : 403) });
    await m.start();
    es.emit("welcome", "s1", { transferred: false });
    await tick(); await tick();
    expect(m.info.state).toBe("connected");
    expect(m.info.chatOnly).toBe(true);
    expect(m.info.subscriptions.find((s) => s.type === "channel.subscribe")?.status).toMatch(/Affiliate or Partner/);
  });

  it("network loss is reported as a gap, closed again on the next welcome", async () => {
    const { m, es } = setup();
    await m.start();
    es.emit("welcome", "s1", { transferred: false });
    es.emit("down", "keepalive timeout");
    expect(m.info.state).toBe("reconnecting");
    expect(m.info.gaps.at(-1)?.to).toBeNull();
    es.emit("welcome", "s2", { transferred: false });
    await tick();
    expect(m.info.gaps.at(-1)?.to).not.toBeNull();
  });

  it("live notifications reach the live engine; duplicates are rewarded once", async () => {
    const { m, es, engine } = setup();
    await m.start();
    engine.setMode("BRB");
    const g = gift(5, false, "evt-1");
    es.emit("notification", g);
    es.emit("notification", g);
    es.emit("notification", chat("!smash"));
    engine.tick();
    expect(engine.snapshot().room.supportUnits).toBe(5);
    expect(engine.snapshot().meters.smash).toBe(5);
    void m;
  });
});

describe("OAuth", () => {
  it("state is random and single use", async () => {
    const { auth } = setup({}, false);
    const url = new URL(auth.authorizeUrl(["user:read:chat"]));
    const state = url.searchParams.get("state")!;
    expect(state).toHaveLength(48);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3977/auth/callback");
    await auth.handleCallback(new URLSearchParams({ code: "abc", state }));
    expect(auth.signedIn).toBe(true);
    await expect(auth.handleCallback(new URLSearchParams({ code: "abc", state }))).rejects.toThrow(/expired or was already used/);
    await expect(auth.handleCallback(new URLSearchParams({ code: "abc", state: "forged" }))).rejects.toThrow(/expired or was already used/);
  });

  it("redacts credentials from log lines", () => {
    expect(redact("POST token body client_secret=abc123&refresh_token=xyz")).not.toMatch(/abc123|xyz/);
    expect(redact('{"accessToken":"secret-token"}')).not.toContain("secret-token");
    expect(redact("Authorization: Bearer abcdef123")).not.toContain("abcdef123");
  });
});
