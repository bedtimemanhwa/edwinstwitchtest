// Types shared by the server, the overlay, the dashboard and the demo page.
// Imports use ".js" so the same files compile for Node (NodeNext) and the browser bundle.
import { z } from "zod";

export const MODES = ["INTRO", "LIVE", "BRB", "OUTRO", "END"] as const;
export type Mode = (typeof MODES)[number];
/** Modes the streamer picks. END is the quiet end card the OUTRO countdown leads to. */
export const SELECTABLE_MODES = ["INTRO", "LIVE", "BRB", "OUTRO"] as const;

export const CHARACTER_STATES = [
  "idle", "sleeping", "waking", "eating", "flexing", "charging", "smashing", "celebrating", "bedtime",
] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

export const COMMAND_KEYS = ["hulk", "wake", "feed", "flex", "smash", "vote"] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];

export type SessionKind = "live" | "demo";

// ---------------------------------------------------------------- internal events
// Everything that reaches the engine is one of these four, validated at the adapter boundary.
// `id` is the EventSub metadata.message_id for live events (the dedupe key) and "demo:<n>" for synthetic ones.
const base = { id: z.string().min(1).max(200), at: z.number() };
export const ChatCommandEvent = z.object({
  kind: z.literal("CHAT_COMMAND"), ...base,
  userId: z.string().min(1).max(64), login: z.string().max(64), displayName: z.string().max(64),
  command: z.enum(COMMAND_KEYS), arg: z.string().max(64).optional(),
});
export const NewSubEvent = z.object({
  kind: z.literal("NEW_SUB"), ...base,
  userId: z.string().min(1).max(64), displayName: z.string().max(64), tier: z.string().max(8),
});
export const GiftBatchEvent = z.object({
  kind: z.literal("GIFT_BATCH"), ...base,
  gifterId: z.string().max(64).nullable(), displayName: z.string().max(64), anonymous: z.boolean(),
  quantity: z.number().int().min(1).max(1000), tier: z.string().max(8),
});
export const ResubMessageEvent = z.object({
  kind: z.literal("RESUB_MESSAGE"), ...base,
  userId: z.string().min(1).max(64), displayName: z.string().max(64), tier: z.string().max(8),
  cumulativeMonths: z.number().int().min(0).max(1000),
});
export const InternalEvent = z.discriminatedUnion("kind", [ChatCommandEvent, NewSubEvent, GiftBatchEvent, ResubMessageEvent]);
export type InternalEvent = z.infer<typeof InternalEvent>;
export type ChatCommandEvent = z.infer<typeof ChatCommandEvent>;
export type NewSubEvent = z.infer<typeof NewSubEvent>;
export type GiftBatchEvent = z.infer<typeof GiftBatchEvent>;
export type ResubMessageEvent = z.infer<typeof ResubMessageEvent>;

// ---------------------------------------------------------------- effects (presentation)
export const EFFECT_TYPES = [
  "new-sub", "welcome-back", "gift-delivery", "unlock", "summary", // celebrations (sequential)
  "wake-up", "big-flex", "community-smash",                         // meter completions
  "activity", "snack", "help", "vote-update",                       // light, aggregated
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export interface Effect {
  id: string;
  type: EffectType;
  /** Escaped on render (canvas text / React). Never chat text, only display names and fixed labels. */
  names: string[];
  quantity?: number;
  months?: number;
  label?: string;
  decoration?: string;
  command?: CommandKey;
  priority: number;
  startAt: number;
  endAt: number;
}

export const PRIORITY = { timer: 100, emergency: 100, celebration: 50, completion: 40, light: 10 } as const;

// ---------------------------------------------------------------- snapshot
export interface Meters { wake: number; flex: number; smash: number }

export interface RoomProgress {
  supportUnits: number;
  unlocks: string[];
  milestonesAwarded: number;
  nextMilestoneAt: number;
}

export interface Supporter { name: string; kind: "new" | "gift" | "resub"; quantity?: number; at: number }

export interface Snapshot {
  session: SessionKind;
  serverNow: number;
  mode: Mode;
  countdown: { endsAt: number | null; durationMs: number; remainingMs: number | null };
  paused: boolean;
  stopped: boolean;
  character: CharacterState;
  awake: boolean;
  meters: Meters;
  thresholds: Meters;
  votes: Record<string, number>;
  voteOptions: { id: string; label: string }[];
  activeProp: string | null;
  room: RoomProgress;
  effects: Effect[];
  supporters: Supporter[];
  commandNames: Record<CommandKey, string>;
  prompt: string;
  sound: { volume: number; muted: boolean };
  reducedMotion: boolean;
  lastPulse: { command: CommandKey; count: number; at: number } | null;
}

/** Extra data only the dashboard sees (never sent to overlays). */
export interface DashboardInfo {
  stats: SessionStats;
  twitch: TwitchStatus | null;
  queueLength: number;
  settings: Settings;
}

export interface SessionStats {
  sessionId: string;
  startedAt: number;
  uniqueParticipants: number;
  perMode: Partial<Record<Mode, { accepted: number; participants: number; newSubs: number; giftBatches: number; giftedUnits: number; resubMessages: number }>>;
  rejected: number;
}

export interface TwitchStatus {
  configured: boolean;
  state: "not-configured" | "signed-out" | "connecting" | "connected" | "reconnecting" | "error";
  account: { id: string; login: string } | null;
  scopes: string[];
  missingScopes: string[];
  subscriptions: { type: string; status: string }[];
  lastError: string | null;
  gaps: { from: number; to: number | null }[];
  redirectUri: string;
  chatOnly: boolean;
}

// ---------------------------------------------------------------- settings
const cmd = (name: string, cooldownSec: number, amount = 0) =>
  z.object({ name: z.string().regex(/^![a-z0-9_]{1,24}$/i), cooldownSec: z.number().min(0).max(3600), amount: z.number().min(0).max(100), enabled: z.boolean() })
    .default({ name, cooldownSec, amount, enabled: true });

export const Settings = z.object({
  commands: z.object({
    hulk: cmd("!hulk", 60), wake: cmd("!wake", 20, 5), feed: cmd("!feed", 30), flex: cmd("!flex", 20, 5),
    smash: cmd("!smash", 15, 5), vote: cmd("!vote", 0),
  }).prefault({}),
  thresholds: z.object({ wake: z.number().int().min(1).max(10000), flex: z.number().int().min(1).max(10000), smash: z.number().int().min(1).max(10000) })
    .default({ wake: 100, flex: 100, smash: 100 }),
  milestoneSize: z.number().int().min(1).max(1000).default(5),
  countdowns: z.object({ introSec: z.number().int().min(10).max(7200), outroSec: z.number().int().min(10).max(3600), brbSec: z.number().int().min(0).max(7200) })
    .default({ introSec: 300, outroSec: 120, brbSec: 0 }),
  voteOptions: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,24}$/), label: z.string().min(1).max(32) })).min(2).max(8)
    .default([{ id: "hat", label: "Party hat" }, { id: "shades", label: "Sunglasses" }, { id: "cape", label: "Cape" }, { id: "dumbbell", label: "Giant dumbbell" }]),
  chatReplies: z.object({ enabled: z.boolean(), minIntervalSec: z.number().min(5).max(600) }).default({ enabled: false, minIntervalSec: 30 }),
  ignoredLogins: z.array(z.string().max(64)).default(["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "sery_bot", "botrixoficial", "pokemoncommunitygame"]),
  sound: z.object({ volume: z.number().min(0).max(1), muted: z.boolean() }).default({ volume: 0.6, muted: false }),
  reducedMotion: z.boolean().default(false),
  prompt: z.string().max(80).default("Chat powers the smash. Subs trigger a Gamma Smash!"),
});
export type Settings = z.infer<typeof Settings>;
export const defaultSettings = (): Settings => Settings.parse({});

// ---------------------------------------------------------------- room decorations
/** Unlocked in this order, one per support milestone; past the end they become numbered trophies. */
export const DECORATIONS = [
  "gamma-trophy", "neon-sign", "punching-bag", "green-rug", "arcade-cabinet", "potted-plant",
  "smash-banner", "giant-fridge", "lava-lamp", "championship-belt",
] as const;
export const decorationFor = (index: number): string => (index < DECORATIONS.length ? DECORATIONS[index] : `trophy-${index - DECORATIONS.length + 2}`);

// ---------------------------------------------------------------- wire messages
export type ServerMessage =
  | { t: "snapshot"; snapshot: Snapshot; dashboard?: DashboardInfo }
  | { t: "hello"; session: SessionKind; role: "overlay" | "dashboard" };

/** Display names arrive from Twitch; keep them short and free of control characters. Rendering escapes them. */
export const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").slice(0, 25) || "Someone";
