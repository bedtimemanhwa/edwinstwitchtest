// The authoritative state engine. Everything that changes the room goes through here; overlays only render
// snapshots. It owns timers, energy meters, cooldowns, votes, permanent progress and the celebration timeline.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  type CharacterState, type CommandKey, type Effect, type EffectType, type InternalEvent, type Meters, type Mode,
  type SessionKind, type SessionStats, type Snapshot, type Supporter, PRIORITY, Settings, cleanName, decorationFor,
} from "../../shared/types.js";
import { Store, type RoomRow } from "../persistence/store.js";

export type Result = { accepted: true } | { accepted: false; reason: string };

const COMMAND_MODES: Record<CommandKey, Mode[]> = {
  hulk: ["INTRO", "LIVE", "BRB", "OUTRO"],
  wake: ["INTRO"],
  feed: ["LIVE", "BRB"],
  flex: ["LIVE", "BRB"],
  smash: ["BRB"],
  vote: ["LIVE", "BRB"],
};

/** Main-timeline durations (ms). Individual celebrations < 8 s, a gift batch sequence < 12 s. */
export const DURATION = { newSub: 6000, resub: 6000, unlockBonus: 1800, giftBase: 7000, giftPerUnit: 200, giftMax: 11500, summary: 7500, wake: 4500, flex: 4500, smash: 6000 };
const BACKLOG_LIMIT_MS = 25_000; // beyond this much queued celebration time, new ones fold into one summary
const MAX_TIMELINE = 24;
const LIGHT_MS = 1400;
const HELP_MIN_GAP_MS = 20_000;
const SUPPORTERS_KEPT = 30;
const CHAT_DEDUPE = 5000;

interface ModeStats { accepted: number; participants: string[]; newSubs: number; giftBatches: number; giftedUnits: number; resubMessages: number }

interface SessionState {
  sessionId: string;
  startedAt: number;
  mode: Mode;
  countdownEndsAt: number | null;
  countdownDurationMs: number;
  pausedRemainingMs: number | null;
  paused: boolean;
  stopped: boolean;
  awake: boolean;
  meters: Meters;
  votes: Record<string, string>;
  supporters: Supporter[];
  rejected: number;
  modeStats: Partial<Record<Mode, ModeStats>>;
}

export interface EngineOptions {
  session: SessionKind;
  now?: () => number;
  /** Called when an accepted !hulk should post a chat reply (live session, replies enabled, rate limit passed). */
  onChatReply?: (text: string) => void;
}

export class Engine extends EventEmitter {
  readonly session: SessionKind;
  private readonly now: () => number;
  private settings: Settings;
  private room: RoomRow;
  private s: SessionState;
  private timeline: Effect[] = []; // main sequential timeline: celebrations and meter completions
  private light: Effect[] = [];    // short aggregated reactions, at most one per kind
  private cooldowns = new Map<string, number>();
  private pulses = new Map<CommandKey, number>();
  private lastPulse: Snapshot["lastPulse"] = null;
  private lastHelpAt = -Infinity;
  private lastReplyAt = -Infinity;
  private seenChat = new Set<string>();
  private metricsBuf: { mode: string; kind: string; userId: string | null; quantity: number; at: number }[] = [];
  private dirty = false;
  private lastSave = 0;
  private effectsDirty = false;
  /** Effects created but not yet given a slot on the timeline (their startAt/endAt only carry the duration). */
  private unplaced = new Set<string>();

  constructor(readonly store: Store, private readonly opts: EngineOptions) {
    super();
    this.session = opts.session;
    this.now = opts.now ?? Date.now;
    this.settings = store.loadSettings();
    this.room = store.loadRoom();
    const t = this.now();
    const saved = store.loadSession();
    this.s = saved ? (JSON.parse(saved) as SessionState) : this.freshSession(t);
    store.startSession(this.s.sessionId, this.s.startedAt);
    // Restart: celebrations that already finished are not replayed; unfinished ones resume where they were.
    this.timeline = store.loadPendingEffects(t).filter((e) => e.endAt > t);
    this.tick();
  }

  private freshSession(t: number): SessionState {
    return {
      sessionId: randomUUID(), startedAt: t, mode: "LIVE", countdownEndsAt: null, countdownDurationMs: 0,
      pausedRemainingMs: null, paused: false, stopped: false, awake: true,
      meters: { wake: 0, flex: 0, smash: 0 }, votes: {}, supporters: [], rejected: 0, modeStats: {},
    };
  }

  // ================================================================== events
  /** Apply one normalised event. Rewards are exactly-once by event id (persisted ledger). */
  apply(ev: InternalEvent): Result {
    switch (ev.kind) {
      case "CHAT_COMMAND": return this.command(ev.id, ev.userId, ev.command, ev.arg);
      case "NEW_SUB": return this.reward(ev.id, "NEW_SUB", ev.userId, 1, (t) => this.celebrate("new-sub", [cleanName(ev.displayName)], 1, t, { kind: "new", name: cleanName(ev.displayName) }));
      case "GIFT_BATCH": {
        const name = ev.anonymous ? "Anonymous" : cleanName(ev.displayName);
        return this.reward(ev.id, "GIFT_BATCH", ev.anonymous ? null : ev.gifterId, ev.quantity, (t) =>
          this.celebrate("gift-delivery", [name], ev.quantity, t, { kind: "gift", name, quantity: ev.quantity }));
      }
      case "RESUB_MESSAGE":
        // A shared resub message is acknowledged, but it is not evidence of every renewal: it adds no support
        // units and is counted separately from new subscriptions.
        return this.reward(ev.id, "RESUB_MESSAGE", ev.userId, 0, (t) =>
          this.celebrate("welcome-back", [cleanName(ev.displayName)], 0, t, { kind: "resub", name: cleanName(ev.displayName) }, ev.cumulativeMonths));
    }
  }

  private command(id: string, userId: string, cmd: CommandKey, arg?: string): Result {
    const t = this.now();
    if (this.seenChat.has(id)) return { accepted: false, reason: "duplicate" };
    this.rememberChat(id);
    const reject = (reason: string): Result => { this.s.rejected++; this.dirty = true; return { accepted: false, reason }; };
    const c = this.settings.commands[cmd];
    if (!c.enabled) return reject("disabled");
    if (this.s.stopped) return reject("stopped");
    if (this.s.paused) return reject("paused");
    if (!COMMAND_MODES[cmd].includes(this.s.mode)) return reject("wrong-mode");
    const key = `${cmd}:${userId}`;
    const until = this.cooldowns.get(key) ?? 0;
    if (cmd !== "vote" && t < until) return reject("cooldown");

    switch (cmd) {
      case "wake":
        if (this.s.awake) return reject("already-awake");
        this.addEnergy("wake", c.amount, t);
        break;
      case "flex":
        this.addEnergy("flex", c.amount, t);
        break;
      case "smash":
        this.addEnergy("smash", c.amount, t);
        break;
      case "feed":
        this.pulse("feed");
        break;
      case "vote": {
        const opt = this.matchVote(arg);
        if (!opt) return reject("bad-option");
        this.s.votes[userId] = opt;
        this.pulse("vote");
        break;
      }
      case "hulk":
        if (t - this.lastHelpAt >= HELP_MIN_GAP_MS) {
          this.lastHelpAt = t;
          this.setLight({ type: "help", command: "hulk", t, ms: 7000 });
        }
        if (this.session === "live" && this.settings.chatReplies.enabled && this.opts.onChatReply &&
            t - this.lastReplyAt >= this.settings.chatReplies.minIntervalSec * 1000) {
          this.lastReplyAt = t;
          const n = this.settings.commands;
          this.opts.onChatReply(`Hulk's Hangout: ${n.wake.name} wakes him up, ${n.feed.name} feeds him, ${n.flex.name} and ${n.smash.name} power him up, ${n.vote.name} <option> picks his prop.`);
        }
        break;
    }
    if (c.cooldownSec > 0) this.cooldowns.set(key, t + c.cooldownSec * 1000);
    if (cmd !== "feed" && cmd !== "vote" && cmd !== "hulk") this.pulse(cmd);
    const ms = this.modeStats();
    ms.accepted++;
    if (!ms.participants.includes(userId)) ms.participants.push(userId);
    this.metricsBuf.push({ mode: this.s.mode, kind: "command", userId, quantity: 1, at: t });
    this.dirty = true;
    return { accepted: true };
  }

  private matchVote(arg?: string): string | null {
    if (!arg) return null;
    const a = arg.trim().toLowerCase();
    const opts = this.settings.voteOptions;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1].id;
    return opts.find((o) => o.id === a || o.label.toLowerCase() === a)?.id ?? null;
  }

  private addEnergy(meter: keyof Meters, amount: number, t: number): void {
    const th = this.settings.thresholds[meter];
    this.s.meters[meter] = Math.min(th, this.s.meters[meter] + amount);
    if (this.s.meters[meter] < th) return;
    if (meter === "wake") {
      this.s.awake = true; // the meter stays full: the room remembers it woke up
      this.enqueue(this.mk("wake-up", [], t, DURATION.wake, PRIORITY.completion));
    } else if (meter === "flex") {
      this.s.meters.flex = 0;
      this.enqueue(this.mk("big-flex", [], t, DURATION.flex, PRIORITY.completion));
    } else {
      this.s.meters.smash = 0;
      this.enqueue(this.mk("community-smash", [], t, DURATION.smash, PRIORITY.completion));
    }
    this.persistTimeline();
  }

  /**
   * Shared path for subscription events: compute the new room + celebration, then commit ledger,
   * room, outbox and session in one transaction. Only after the commit is the in-memory state replaced.
   */
  private reward(id: string, kind: "NEW_SUB" | "GIFT_BATCH" | "RESUB_MESSAGE", userId: string | null, units: number,
    build: (t: number) => { effects: Effect[]; supporter: Supporter }): Result {
    const t = this.now();
    if (this.store.hasProcessed(id)) return { accepted: false, reason: "duplicate" };
    // Work on copies so a failed or duplicate commit leaves memory untouched.
    const prevRoom = this.room, prevTimeline = this.timeline, prevS = this.s;
    this.room = { ...prevRoom, unlocks: [...prevRoom.unlocks] };
    this.timeline = prevTimeline.map((e) => ({ ...e, names: [...e.names] }));
    this.s = structuredClone(prevS);
    this.room.supportUnits += units;
    const { effects, supporter } = build(t);
    this.s.supporters = [supporter, ...this.s.supporters].slice(0, SUPPORTERS_KEPT);
    const ms = this.modeStats();
    if (kind === "NEW_SUB") ms.newSubs++;
    else if (kind === "GIFT_BATCH") { ms.giftBatches++; ms.giftedUnits += units; }
    else ms.resubMessages++;
    let ok = false;
    try {
      ok = this.store.applyReward({
        messageId: id, kind, at: t, room: this.room, effects, sessionJson: JSON.stringify(this.s),
        metric: { sessionId: this.s.sessionId, mode: this.s.mode, kind, userId, quantity: Math.max(units, 1) },
      });
    } catch (e) {
      this.room = prevRoom; this.timeline = prevTimeline; this.s = prevS;
      throw e;
    }
    if (!ok) {
      this.room = prevRoom; this.timeline = prevTimeline; this.s = prevS;
      return { accepted: false, reason: "duplicate" };
    }
    this.emitChange();
    return { accepted: true };
  }

  /** Build the celebration (folding milestone unlocks into it) and place it on the timeline. */
  private celebrate(type: EffectType, names: string[], units: number, t: number, supporter: Omit<Supporter, "at">, months?: number) {
    const decorations = this.awardMilestones();
    let ms = type === "gift-delivery"
      ? Math.min(DURATION.giftMax, DURATION.giftBase + DURATION.giftPerUnit * Math.min(units, 20))
      : type === "welcome-back" ? DURATION.resub : DURATION.newSub;
    if (decorations.length) ms = Math.min(type === "gift-delivery" ? 11_900 : 7_900, ms + DURATION.unlockBonus);
    let effect = this.mk(type, names, t, ms, PRIORITY.celebration);
    if (units) effect.quantity = units;
    if (months !== undefined) effect.months = months;
    if (decorations.length) { effect.decoration = decorations[decorations.length - 1]; effect.label = decorations.join(","); }
    // Heavy activity: fold into one bounded summary instead of growing the queue without limit.
    if (this.backlogMs(t) > BACKLOG_LIMIT_MS || this.timeline.length >= MAX_TIMELINE) {
      effect = this.foldIntoSummary(effect, t);
    } else {
      this.enqueue(effect);
    }
    this.reflow(t);
    return { effects: this.timeline.filter((e) => e.endAt > t), supporter: { ...supporter, at: t } };
  }

  private awardMilestones(): string[] {
    const size = this.settings.milestoneSize;
    const reached = Math.floor(this.room.supportUnits / size);
    const out: string[] = [];
    // Each milestone is awarded exactly once, even when one batch crosses several.
    while (this.room.milestonesAwarded < reached) {
      const d = decorationFor(this.room.unlocks.length);
      this.room.unlocks.push(d);
      this.room.milestonesAwarded++;
      out.push(d);
    }
    return out;
  }

  private foldIntoSummary(e: Effect, t: number): Effect {
    let sum = [...this.timeline].reverse().find((x) => x.type === "summary" && x.startAt > t);
    if (!sum) {
      sum = this.mk("summary", [], t, DURATION.summary, PRIORITY.celebration);
      sum.quantity = 0;
      this.timeline.push(sum);
    }
    for (const n of e.names) if (!sum.names.includes(n) && sum.names.length < 6) sum.names.push(n);
    sum.quantity = (sum.quantity ?? 0) + Math.max(1, e.quantity ?? 1);
    if (e.decoration) { sum.decoration = e.decoration; sum.label = [sum.label, e.label].filter(Boolean).join(","); }
    return sum;
  }

  // ================================================================== timeline
  private mk(type: EffectType, names: string[], t: number, ms: number, priority: number): Effect {
    const e = { id: randomUUID(), type, names, priority, startAt: t, endAt: t + ms };
    if (priority !== PRIORITY.light) this.unplaced.add(e.id);
    return e;
  }
  private enqueue(e: Effect): void {
    this.timeline.push(e);
    this.reflow(this.now());
  }
  private backlogMs(t: number): number {
    const last = this.timeline.reduce((m, e) => Math.max(m, e.endAt), t);
    return last - t;
  }
  /** Keep what is playing; reorder what hasn't started by priority (stable) and lay it out back to back. */
  private reflow(t: number): void {
    const placed = (e: Effect) => !this.unplaced.has(e.id);
    const playing = this.timeline.filter((e) => placed(e) && e.startAt <= t && e.endAt > t);
    const queue = this.timeline.filter((e) => !playing.includes(e) && (!placed(e) || e.endAt > t))
      .sort((a, b) => b.priority - a.priority); // stable: equal priorities keep arrival order
    let cursor = playing.reduce((m, e) => Math.max(m, e.endAt), t);
    const laid: Effect[] = [];
    for (const e of queue) {
      const dur = e.endAt - e.startAt;
      e.startAt = cursor; e.endAt = cursor + dur; cursor = e.endAt;
      this.unplaced.delete(e.id);
      laid.push(e);
    }
    // Bound: drop the lowest-priority tail if something still overflows.
    while (playing.length + laid.length > MAX_TIMELINE) laid.pop();
    this.timeline = [...playing, ...laid];
    this.effectsDirty = true;
  }
  private persistTimeline(): void {
    this.store.replaceEffects(this.timeline);
    this.effectsDirty = false;
  }

  private setLight(a: { type: EffectType; command: CommandKey; t: number; ms: number; quantity?: number }): void {
    this.light = this.light.filter((e) => !(e.type === a.type && e.command === a.command));
    const e = this.mk(a.type, [], a.t, a.ms, PRIORITY.light);
    e.command = a.command;
    if (a.quantity) e.quantity = a.quantity;
    this.light.push(e);
    if (this.light.length > 6) this.light.shift();
  }
  private pulse(cmd: CommandKey): void {
    this.pulses.set(cmd, (this.pulses.get(cmd) ?? 0) + 1);
  }

  // ================================================================== clock
  /** Advance timers, aggregate command pulses, expire effects, save. Call ~10x a second. */
  tick(): void {
    const t = this.now();
    let changed = false;
    // Countdowns are authoritative: nothing extends them, and expiry wins over any queued effect.
    if (!this.s.paused && this.s.countdownEndsAt !== null && t >= this.s.countdownEndsAt) {
      this.onCountdownEnd(t);
      changed = true;
    }
    // Aggregate: one reaction per command per window, carrying the count, instead of one animation per message.
    if (this.pulses.size) {
      for (const [cmd, count] of this.pulses) {
        const type: EffectType = cmd === "feed" ? "snack" : cmd === "vote" ? "vote-update" : "activity";
        this.setLight({ type, command: cmd, t, ms: LIGHT_MS, quantity: count });
        this.lastPulse = { command: cmd, count, at: t };
      }
      this.pulses.clear();
      changed = true;
    }
    const before = this.timeline.length + this.light.length;
    this.timeline = this.timeline.filter((e) => e.endAt > t);
    this.light = this.light.filter((e) => e.endAt > t);
    if (this.timeline.length + this.light.length !== before) changed = true;
    if (this.effectsDirty) { this.persistTimeline(); changed = true; }
    if (this.dirty && t - this.lastSave >= 1000) this.save(t);
    if (changed) this.emitChange();
  }

  private onCountdownEnd(t: number): void {
    const mode = this.s.mode;
    this.s.countdownEndsAt = null;
    this.s.pausedRemainingMs = null;
    if (mode === "OUTRO") {
      // Quiet end card. Ending the actual broadcast stays with the streamer.
      this.setModeInner("END", t);
    } else if (mode === "INTRO") {
      this.setModeInner("LIVE", t);
    } else if (mode === "BRB") {
      this.setModeInner("LIVE", t);
    }
  }

  private save(t: number): void {
    const buf = this.metricsBuf;
    this.metricsBuf = [];
    this.store.tx(() => {
      this.store.saveSession(JSON.stringify(this.s), t);
      for (const m of buf) this.store.addMetric({ sessionId: this.s.sessionId, ...m }, m.at);
    });
    this.dirty = false;
    this.lastSave = t;
  }
  /** Flush everything now (shutdown, tests). */
  flush(): void {
    this.save(this.now());
    this.persistTimeline();
  }

  // ================================================================== dashboard controls
  setMode(mode: Mode, durationSec?: number): void {
    this.setModeInner(mode, this.now(), durationSec);
    this.dirty = true;
    this.emitChange();
  }
  private setModeInner(mode: Mode, t: number, durationSec?: number): void {
    const prev = this.s.mode;
    this.s.mode = mode;
    const c = this.settings.countdowns;
    const sec = durationSec ?? (mode === "INTRO" ? c.introSec : mode === "OUTRO" ? c.outroSec : mode === "BRB" ? c.brbSec : 0);
    this.s.countdownDurationMs = sec * 1000;
    const timed = sec > 0 && mode !== "LIVE" && mode !== "END";
    // While paused the countdown is held as "remaining" and starts when the dashboard resumes.
    this.s.countdownEndsAt = timed && !this.s.paused ? t + sec * 1000 : null;
    this.s.pausedRemainingMs = timed && this.s.paused ? sec * 1000 : null;
    if (mode === "INTRO" && prev !== "INTRO") {
      this.s.awake = false;
      this.s.meters.wake = 0;
    }
    if (mode !== "INTRO") this.s.awake = true;
    // Scene change: drop reactions and completions that no longer make sense; END clears everything.
    this.light = [];
    if (mode === "END") this.timeline = [];
    else this.timeline = this.timeline.filter((e) => !(e.type === "wake-up" && mode !== "INTRO") && !(e.type === "community-smash" && mode !== "BRB"));
    this.reflow(t);
    this.persistTimeline();
  }

  startSession(mode: Mode = "INTRO"): void {
    const t = this.now();
    this.endSession(false);
    const fresh = this.freshSession(t);
    fresh.paused = false;
    this.s = fresh;
    this.store.startSession(this.s.sessionId, t);
    this.cooldowns.clear();
    this.setModeInner(mode, t);
    this.save(t);
    this.emitChange();
  }
  endSession(emit = true): void {
    const t = this.now();
    this.store.endSession(this.s.sessionId, t);
    if (emit) {
      this.setModeInner("END", t);
      this.save(t);
      this.emitChange();
    }
  }
  pause(): void {
    const t = this.now();
    if (this.s.paused) return;
    this.s.paused = true;
    if (this.s.countdownEndsAt !== null) { this.s.pausedRemainingMs = Math.max(0, this.s.countdownEndsAt - t); this.s.countdownEndsAt = null; }
    this.dirty = true; this.emitChange();
  }
  resume(): void {
    const t = this.now();
    this.s.stopped = false;
    if (this.s.paused) {
      this.s.paused = false;
      if (this.s.pausedRemainingMs !== null) { this.s.countdownEndsAt = t + this.s.pausedRemainingMs; this.s.pausedRemainingMs = null; }
    }
    this.dirty = true; this.emitChange();
  }
  /** Stops every effect at once and blocks interactions until resume(). */
  emergencyStop(): void {
    this.s.stopped = true;
    this.timeline = [];
    this.light = [];
    this.pulses.clear();
    this.persistTimeline();
    this.save(this.now());
    this.emitChange();
  }
  clearQueue(): void {
    const t = this.now();
    this.timeline = this.timeline.filter((e) => e.startAt <= t && e.endAt > t);
    this.light = [];
    this.persistTimeline();
    this.emitChange();
  }
  resetVotes(): void {
    this.s.votes = {};
    this.dirty = true; this.emitChange();
  }
  updateSettings(patch: unknown): Settings {
    const next = Settings.parse({ ...this.settings, ...(patch as object) });
    this.settings = next;
    this.store.saveSettings(next);
    for (const k of ["wake", "flex", "smash"] as const) this.s.meters[k] = Math.min(this.s.meters[k], next.thresholds[k]);
    this.dirty = true; this.emitChange();
    return next;
  }
  /** Permanent progress reset (the dashboard asks for confirmation first). */
  resetProgress(): void {
    this.store.resetRoom();
    this.room = this.store.loadRoom();
    this.emitChange();
  }

  // ================================================================== read side
  getSettings(): Settings { return this.settings; }
  queueLength(): number { return this.timeline.length; }

  character(t: number): CharacterState {
    const s = this.s;
    if (s.mode === "END") return "sleeping";
    if (s.stopped) return "idle";
    const cur = this.timeline.find((e) => e.startAt <= t && e.endAt > t);
    if (cur) {
      if (cur.type === "wake-up") return "waking";
      if (cur.type === "big-flex") return "flexing";
      if (cur.type === "community-smash") return "smashing";
      return "celebrating";
    }
    if (s.mode === "INTRO" && !s.awake) return "sleeping";
    if (this.light.some((e) => e.type === "snack")) return "eating";
    if (this.light.some((e) => e.type === "activity" && e.command === "flex")) return "flexing";
    if (s.mode === "OUTRO") {
      const rem = s.countdownEndsAt !== null ? s.countdownEndsAt - t : s.pausedRemainingMs ?? 0;
      if (rem < Math.max(30_000, s.countdownDurationMs * 0.25)) return "bedtime";
    }
    if (s.mode === "BRB" && s.meters.smash >= this.settings.thresholds.smash / 2) return "charging";
    return "idle";
  }

  snapshot(): Snapshot {
    const t = this.now();
    const s = this.s;
    const votes: Record<string, number> = {};
    for (const o of this.settings.voteOptions) votes[o.id] = 0;
    for (const v of Object.values(s.votes)) if (v in votes) votes[v]++;
    let activeProp: string | null = null;
    let best = 0;
    for (const o of this.settings.voteOptions) if (votes[o.id] > best) { best = votes[o.id]; activeProp = o.id; }
    const size = this.settings.milestoneSize;
    const commandNames = Object.fromEntries(Object.entries(this.settings.commands).map(([k, v]) => [k, v.name])) as Record<CommandKey, string>;
    return {
      session: this.session,
      serverNow: t,
      mode: s.mode,
      countdown: {
        endsAt: s.countdownEndsAt, durationMs: s.countdownDurationMs,
        remainingMs: s.countdownEndsAt !== null ? Math.max(0, s.countdownEndsAt - t) : s.pausedRemainingMs,
      },
      paused: s.paused,
      stopped: s.stopped,
      character: this.character(t),
      awake: s.awake,
      meters: { ...s.meters },
      thresholds: { ...this.settings.thresholds },
      votes,
      voteOptions: this.settings.voteOptions,
      activeProp,
      room: {
        supportUnits: this.room.supportUnits, unlocks: [...this.room.unlocks], milestonesAwarded: this.room.milestonesAwarded,
        nextMilestoneAt: (this.room.milestonesAwarded + 1) * size,
      },
      effects: [...this.timeline, ...this.light].filter((e) => e.endAt > t).map((e) => ({ ...e, names: [...e.names] })),
      supporters: s.supporters.slice(0, 12),
      commandNames,
      prompt: this.settings.prompt,
      sound: this.settings.sound,
      reducedMotion: this.settings.reducedMotion,
      lastPulse: this.lastPulse,
    };
  }

  stats(): SessionStats {
    const perMode: SessionStats["perMode"] = {};
    for (const [m, v] of Object.entries(this.s.modeStats) as [Mode, ModeStats][]) {
      perMode[m] = { accepted: v.accepted, participants: v.participants.length, newSubs: v.newSubs, giftBatches: v.giftBatches, giftedUnits: v.giftedUnits, resubMessages: v.resubMessages };
    }
    const all = new Set<string>();
    for (const v of Object.values(this.s.modeStats)) v?.participants.forEach((p) => all.add(p));
    return { sessionId: this.s.sessionId, startedAt: this.s.startedAt, uniqueParticipants: all.size, perMode, rejected: this.s.rejected };
  }

  private modeStats(): ModeStats {
    return (this.s.modeStats[this.s.mode] ??= { accepted: 0, participants: [], newSubs: 0, giftBatches: 0, giftedUnits: 0, resubMessages: 0 });
  }
  private rememberChat(id: string): void {
    this.seenChat.add(id);
    if (this.seenChat.size > CHAT_DEDUPE) this.seenChat.delete(this.seenChat.values().next().value as string);
  }
  private emitChange(): void {
    this.emit("change");
  }
}
