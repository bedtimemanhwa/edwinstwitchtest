import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/server/engine/engine.js";
import { Store } from "../src/server/persistence/store.js";
import type { InternalEvent } from "../src/shared/types.js";

function setup(path = ":memory:") {
  let now = 1_000_000;
  const clock = { get: () => now, add: (ms: number) => { now += ms; } };
  const store = new Store(path);
  const engine = new Engine(store, { session: "live", now: clock.get });
  return { engine, store, clock };
}
let n = 0;
const chat = (userId: string, command: string, arg?: string): InternalEvent =>
  ({ kind: "CHAT_COMMAND", id: `c${++n}`, at: 0, userId, login: userId, displayName: userId, command: command as never, arg });
const sub = (id: string, name = "Bruce"): InternalEvent => ({ kind: "NEW_SUB", id, at: 0, userId: `u-${name}`, displayName: name, tier: "1000" });
const gift = (id: string, quantity: number, anonymous = false): InternalEvent =>
  ({ kind: "GIFT_BATCH", id, at: 0, gifterId: anonymous ? null : "g1", displayName: anonymous ? "" : "Natasha", anonymous, quantity, tier: "1000" });

describe("commands", () => {
  it("wake adds energy in INTRO, respects the per-user cooldown, and wakes at the threshold", () => {
    const { engine, clock } = setup();
    engine.setMode("INTRO", 300);
    expect(engine.snapshot().character).toBe("sleeping");
    expect(engine.apply(chat("a", "wake")).accepted).toBe(true);
    expect(engine.apply(chat("a", "wake"))).toEqual({ accepted: false, reason: "cooldown" });
    expect(engine.snapshot().meters.wake).toBe(5);
    clock.add(20_000);
    expect(engine.apply(chat("a", "wake")).accepted).toBe(true);
    for (let i = 0; i < 18; i++) engine.apply(chat(`u${i}`, "wake"));
    engine.tick();
    const s = engine.snapshot();
    expect(s.meters.wake).toBe(100);
    expect(s.awake).toBe(true);
    expect(s.character).toBe("waking");
    expect(engine.apply(chat("zz", "wake"))).toEqual({ accepted: false, reason: "already-awake" });
  });

  it("rejects commands in the wrong mode and while paused or stopped", () => {
    const { engine } = setup();
    engine.setMode("LIVE");
    expect(engine.apply(chat("a", "smash"))).toEqual({ accepted: false, reason: "wrong-mode" });
    engine.setMode("BRB");
    engine.pause();
    expect(engine.apply(chat("a", "smash"))).toEqual({ accepted: false, reason: "paused" });
    engine.resume();
    expect(engine.apply(chat("a", "smash")).accepted).toBe(true);
    engine.emergencyStop();
    expect(engine.apply(chat("b", "smash"))).toEqual({ accepted: false, reason: "stopped" });
  });

  it("aggregates many commands into one reaction per window", () => {
    const { engine } = setup();
    engine.setMode("BRB");
    for (let i = 0; i < 40; i++) engine.apply(chat(`u${i}`, "flex"));
    engine.tick();
    const acts = engine.snapshot().effects.filter((e) => e.type === "activity");
    expect(acts).toHaveLength(1);
    expect(acts[0].quantity).toBe(40); // all 40 viewers counted, in one reaction
    // 40 x 5 energy = two full meters -> two big flexes on the timeline, meter back at 0
    expect(engine.snapshot().effects.filter((e) => e.type === "big-flex")).toHaveLength(2);
    expect(engine.snapshot().meters.flex).toBe(0);
  });

  it("one vote per user, changes allowed, only approved options", () => {
    const { engine } = setup();
    engine.setMode("BRB");
    expect(engine.apply(chat("a", "vote", "hat")).accepted).toBe(true);
    expect(engine.apply(chat("a", "vote", "cape")).accepted).toBe(true);
    expect(engine.apply(chat("b", "vote", "2")).accepted).toBe(true); // by number
    expect(engine.apply(chat("c", "vote", "<script>")).accepted).toBe(false);
    const s = engine.snapshot();
    expect(s.votes).toEqual({ hat: 0, shades: 1, cape: 1, dumbbell: 0 });
  });
});

describe("rewards", () => {
  it("a repeated EventSub message id rewards once", () => {
    const { engine } = setup();
    expect(engine.apply(sub("m1")).accepted).toBe(true);
    expect(engine.apply(sub("m1"))).toEqual({ accepted: false, reason: "duplicate" });
    expect(engine.snapshot().room.supportUnits).toBe(1);
  });

  it("a 50-gift batch is one bounded sequence and awards each crossed milestone once", () => {
    const { engine } = setup();
    engine.apply(sub("s1"));
    engine.apply(sub("s2"));
    engine.apply(gift("g50", 50));
    const s = engine.snapshot();
    expect(s.room.supportUnits).toBe(52);
    expect(s.room.milestonesAwarded).toBe(10); // 52 / 5
    expect(s.room.unlocks).toHaveLength(10);
    const gifts = s.effects.filter((e) => e.type === "gift-delivery");
    expect(gifts).toHaveLength(1);
    expect(gifts[0].quantity).toBe(50);
    expect(gifts[0].endAt - gifts[0].startAt).toBeLessThan(12_000);
    // replaying the batch changes nothing
    engine.apply(gift("g50", 50));
    expect(engine.snapshot().room.supportUnits).toBe(52);
  });

  it("individual celebrations stay under 8 s", () => {
    const { engine } = setup();
    for (let i = 0; i < 6; i++) engine.apply(sub(`s${i}`, `Sub${i}`));
    for (const e of engine.snapshot().effects.filter((x) => x.type === "new-sub")) expect(e.endAt - e.startAt).toBeLessThan(8000);
  });

  it("anonymous gifts never expose an identity", () => {
    const { engine } = setup();
    engine.apply({ ...gift("ga", 3, true), displayName: "RealPerson" } as InternalEvent);
    const s = engine.snapshot();
    expect(JSON.stringify(s)).not.toContain("RealPerson");
    expect(s.supporters[0].name).toBe("Anonymous");
  });

  it("resub messages celebrate but add no support units", () => {
    const { engine } = setup();
    engine.apply({ kind: "RESUB_MESSAGE", id: "r1", at: 0, userId: "u", displayName: "Thor", tier: "1000", cumulativeMonths: 7 });
    const s = engine.snapshot();
    expect(s.room.supportUnits).toBe(0);
    expect(s.effects[0]).toMatchObject({ type: "welcome-back", months: 7 });
    expect(engine.stats().perMode.LIVE?.resubMessages).toBe(1);
  });

  it("a burst of subscriptions stays bounded by folding into a summary", () => {
    const { engine } = setup();
    for (let i = 0; i < 200; i++) engine.apply(sub(`b${i}`, `Fan${i}`));
    const s = engine.snapshot();
    expect(s.room.supportUnits).toBe(200);
    expect(s.effects.length).toBeLessThanOrEqual(24);
    const summary = s.effects.find((e) => e.type === "summary");
    expect(summary).toBeTruthy();
    expect(summary!.names.length).toBeLessThanOrEqual(6);
  });
});

describe("timers and controls", () => {
  it("the outro expires on schedule despite an event burst, into a quiet end card", () => {
    const { engine, clock } = setup();
    engine.setMode("OUTRO", 60);
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 5; i++) engine.apply(sub(`o${s}-${i}`));
      engine.apply(gift(`og${s}`, 10));
      clock.add(1000);
      engine.tick();
    }
    const snap = engine.snapshot();
    expect(snap.mode).toBe("END");
    expect(snap.effects).toHaveLength(0);
    expect(snap.character).toBe("sleeping");
  });

  it("emergency stop clears every effect immediately", () => {
    const { engine } = setup();
    engine.apply(gift("x", 10));
    engine.setMode("BRB");
    engine.apply(chat("a", "feed"));
    engine.tick();
    expect(engine.snapshot().effects.length).toBeGreaterThan(0);
    engine.emergencyStop();
    expect(engine.snapshot().effects).toHaveLength(0);
    expect(engine.snapshot().stopped).toBe(true);
  });

  it("pause holds the countdown and resume continues it", () => {
    const { engine, clock } = setup();
    engine.setMode("INTRO", 100);
    clock.add(40_000);
    engine.pause();
    clock.add(500_000);
    engine.tick();
    expect(engine.snapshot().mode).toBe("INTRO");
    expect(engine.snapshot().countdown.remainingMs).toBe(60_000);
    engine.resume();
    clock.add(60_000);
    engine.tick();
    expect(engine.snapshot().mode).toBe("LIVE");
  });
});

describe("restart", () => {
  it("preserves unlocks, processed events and session state; finished celebrations are not replayed", () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-"));
    const path = join(dir, "db.sqlite");
    const a = setup(path);
    a.engine.setMode("BRB");
    a.engine.apply(gift("gg", 12));
    a.engine.apply(chat("p", "smash"));
    a.engine.flush();
    a.clock.add(60_000); // all celebrations finished
    a.store.close();

    let now = 1_000_000 + 60_000;
    const store = new Store(path);
    const engine = new Engine(store, { session: "live", now: () => now });
    const s = engine.snapshot();
    expect(s.room.supportUnits).toBe(12);
    expect(s.room.unlocks).toHaveLength(2);
    expect(s.mode).toBe("BRB");
    expect(s.meters.smash).toBe(5);
    expect(s.effects.filter((e) => e.type === "gift-delivery")).toHaveLength(0);
    // the same EventSub message after restart is harmless
    expect(engine.apply(gift("gg", 12))).toEqual({ accepted: false, reason: "duplicate" });
    expect(engine.snapshot().room.supportUnits).toBe(12);
    now += 1;
    store.close();
  });

  it("an unfinished celebration resumes after restart instead of being lost or doubled", () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-"));
    const path = join(dir, "db.sqlite");
    const a = setup(path);
    a.engine.apply(sub("s1", "Hank"));
    a.clock.add(1000);
    a.store.close(); // crash: no flush
    const store = new Store(path);
    const engine = new Engine(store, { session: "live", now: () => 1_000_000 + 1000 });
    const subs = engine.snapshot().effects.filter((e) => e.type === "new-sub");
    expect(subs).toHaveLength(1);
    expect(subs[0].names).toEqual(["Hank"]);
    store.close();
  });
});
