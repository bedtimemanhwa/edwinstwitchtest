// Synthetic events for the isolated demo session. They only ever reach the demo engine.
import type { CommandKey, InternalEvent } from "../../shared/types.js";

const NAMES = ["GammaGal", "BannerFan99", "SmashBros", "TinyTitan", "GreenMachine", "Rulk", "Puny_Human", "AvengerAndy", "BruceyB", "ShesHulk"];
let seq = 0;
const nextId = () => `demo:${Date.now().toString(36)}:${++seq}`;
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

export function demoEvent(kind: string, opts: { name?: string; quantity?: number; months?: number; command?: CommandKey; arg?: string; userId?: string; repeatId?: string } = {}): InternalEvent {
  const id = opts.repeatId ?? nextId();
  const name = opts.name ?? pick(NAMES);
  const userId = opts.userId ?? `demo-user-${name.toLowerCase()}`;
  const at = Date.now();
  switch (kind) {
    case "NEW_SUB": return { kind, id, at, userId, displayName: name, tier: "1000" };
    case "GIFT_BATCH": return { kind, id, at, gifterId: userId, displayName: name, anonymous: false, quantity: Math.max(1, Math.min(opts.quantity ?? 5, 1000)), tier: "1000" };
    case "ANON_GIFT": return { kind: "GIFT_BATCH", id, at, gifterId: null, displayName: "Anonymous", anonymous: true, quantity: Math.max(1, Math.min(opts.quantity ?? 5, 1000)), tier: "1000" };
    case "RESUB_MESSAGE": return { kind, id, at, userId, displayName: name, tier: "1000", cumulativeMonths: opts.months ?? 6 };
    default: return { kind: "CHAT_COMMAND", id, at, userId, login: name.toLowerCase(), displayName: name, command: opts.command ?? "flex", ...(opts.arg ? { arg: opts.arg } : {}) };
  }
}

/** A steady stream of commands from many distinct synthetic viewers (load testing). */
export function startBurst(apply: (e: InternalEvent) => void, perSecond: number, seconds: number, commands: CommandKey[]): () => void {
  const total = Math.min(perSecond, 500) * Math.min(seconds, 300);
  let sent = 0;
  const every = 50; // ms
  const perTick = Math.max(1, Math.round((perSecond * every) / 1000));
  const timer = setInterval(() => {
    for (let i = 0; i < perTick && sent < total; i++, sent++) {
      apply(demoEvent("CHAT_COMMAND", { command: commands[sent % commands.length], userId: `burst-${sent % 5000}`, name: `Viewer${sent % 5000}`, arg: "hat" }));
    }
    if (sent >= total) clearInterval(timer);
  }, every);
  return () => clearInterval(timer);
}
