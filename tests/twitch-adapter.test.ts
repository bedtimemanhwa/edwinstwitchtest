import { describe, expect, it } from "vitest";
import { normalize } from "../src/server/twitch/normalize.js";
import { Engine } from "../src/server/engine/engine.js";
import { Store } from "../src/server/persistence/store.js";
import { defaultSettings } from "../src/shared/types.js";
import { BROADCASTER, chat, gift, resub, subscribe } from "./fixtures.js";

const s = defaultSettings();
const ctx = { broadcasterId: BROADCASTER, commands: s.commands, ignoredLogins: s.ignoredLogins };

describe("normalize (adapter boundary)", () => {
  it("turns a chat command into CHAT_COMMAND keyed by the stable user id", () => {
    const r = normalize(chat("!vote Shades"), ctx);
    expect(r).toMatchObject({ event: { kind: "CHAT_COMMAND", command: "vote", arg: "Shades", userId: "4242" } });
  });
  it("ignores ordinary conversation, unknown commands, bots, other channels and other shared-chat sources", () => {
    expect(normalize(chat("hello hulk"), ctx)).toEqual({ ignored: "not-a-command" });
    expect(normalize(chat("!dance"), ctx)).toEqual({ ignored: "not-a-command" });
    expect(normalize(chat("!smash", { login: "nightbot" }), ctx)).toEqual({ ignored: "bot" });
    expect(normalize(chat("!smash", { broadcaster: "999" }), ctx)).toEqual({ ignored: "other-channel" });
    expect(normalize(chat("!smash", { source: "555" }), ctx)).toEqual({ ignored: "shared-chat-source" });
    expect(normalize(chat("!smash", { source: BROADCASTER }), ctx)).toMatchObject({ event: { command: "smash" } });
  });
  it("rewards only non-gift channel.subscribe; gifted ones belong to the gift batch", () => {
    expect(normalize(subscribe(false), ctx)).toMatchObject({ event: { kind: "NEW_SUB", displayName: "Bruce" } });
    expect(normalize(subscribe(true), ctx)).toEqual({ ignored: "gifted-sub-owned-by-batch" });
  });
  it("maps gift batches, and anonymous gifts never carry an identity", () => {
    expect(normalize(gift(5), ctx)).toMatchObject({ event: { kind: "GIFT_BATCH", quantity: 5, displayName: "Natasha", anonymous: false } });
    const anon = normalize(gift(3, true), ctx);
    expect(anon).toMatchObject({ event: { kind: "GIFT_BATCH", gifterId: null, displayName: "Anonymous", anonymous: true } });
  });
  it("maps resub messages without keeping the message text", () => {
    const r = normalize(resub(14), ctx);
    expect(r).toMatchObject({ event: { kind: "RESUB_MESSAGE", cumulativeMonths: 14 } });
    expect(JSON.stringify(r)).not.toContain("never displayed");
  });
  it("rejects malformed payloads at the boundary", () => {
    expect(normalize({ metadata: { message_type: "notification" } }, ctx)).toEqual({ ignored: "malformed" });
    const bad = gift(5);
    (bad.payload.event as Record<string, unknown>).total = "lots";
    expect(normalize(bad, ctx)).toEqual({ ignored: "malformed" });
  });
});

describe("adapter + engine", () => {
  const feed = (engine: Engine, msgs: unknown[]) => {
    for (const m of msgs) { const r = normalize(m, ctx); if ("event" in r) engine.apply(r.event); }
  };

  it("a gift batch plus its gifted-subscriber notifications yields the batch quantity once", () => {
    const e = new Engine(new Store(":memory:"), { session: "live" });
    feed(e, [gift(5), ...Array.from({ length: 5 }, (_, i) => subscribe(true, undefined, `Giftee${i}`))]);
    expect(e.snapshot().room.supportUnits).toBe(5);
    expect(e.snapshot().room.milestonesAwarded).toBe(1);
  });

  it("a redelivered EventSub message (same message_id) is rewarded once", () => {
    const e = new Engine(new Store(":memory:"), { session: "live" });
    const m = gift(7, false, "dup-1");
    feed(e, [m, m, structuredClone(m)]);
    expect(e.snapshot().room.supportUnits).toBe(7);
  });

  it("a 50-gift batch through the adapter is one bounded sequence and crosses ten milestones once", () => {
    const e = new Engine(new Store(":memory:"), { session: "live" });
    feed(e, [gift(50)]);
    const snap = e.snapshot();
    expect(snap.room.milestonesAwarded).toBe(10);
    expect(snap.effects.filter((x) => x.type === "gift-delivery")).toHaveLength(1);
  });
});
