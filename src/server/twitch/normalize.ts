// Adapter boundary: raw EventSub WebSocket notifications in, validated internal events out.
// Anything unexpected is rejected here, before it can reach the engine.
import { z } from "zod";
import { COMMAND_KEYS, type CommandKey, type InternalEvent, InternalEvent as InternalEventSchema, type Settings } from "../../shared/types.js";

const Metadata = z.object({
  message_id: z.string().min(1),
  message_type: z.literal("notification"),
  message_timestamp: z.string(),
  subscription_type: z.string(),
  subscription_version: z.string(),
});

const ChatEvent = z.object({
  broadcaster_user_id: z.string(),
  chatter_user_id: z.string(),
  chatter_user_login: z.string(),
  chatter_user_name: z.string(),
  message: z.object({ text: z.string() }),
  source_broadcaster_user_id: z.string().nullable().optional(),
});
const SubscribeEvent = z.object({
  user_id: z.string(), user_login: z.string(), user_name: z.string(),
  broadcaster_user_id: z.string(), tier: z.string(), is_gift: z.boolean(),
});
const GiftEvent = z.object({
  user_id: z.string().nullable(), user_login: z.string().nullable(), user_name: z.string().nullable(),
  broadcaster_user_id: z.string(), total: z.number().int(), tier: z.string(),
  cumulative_total: z.number().int().nullable().optional(), is_anonymous: z.boolean(),
});
const ResubEvent = z.object({
  user_id: z.string(), user_login: z.string(), user_name: z.string(),
  broadcaster_user_id: z.string(), tier: z.string(), cumulative_months: z.number().int(),
});

export type NormalizeResult = { event: InternalEvent } | { ignored: string };

export interface NormalizeContext {
  broadcasterId: string;
  commands: Settings["commands"];
  ignoredLogins: string[];
}

/** Map one EventSub WebSocket message to an internal event, or say why it is ignored. */
export function normalize(raw: unknown, ctx: NormalizeContext): NormalizeResult {
  const msg = z.object({ metadata: Metadata, payload: z.object({ event: z.unknown() }) }).safeParse(raw);
  if (!msg.success) return { ignored: "malformed" };
  const { metadata, payload } = msg.data;
  if (metadata.subscription_version !== "1") return { ignored: "unsupported-version" };
  const id = metadata.message_id;
  const at = Date.parse(metadata.message_timestamp) || Date.now();
  const out = (e: InternalEvent): NormalizeResult => {
    const v = InternalEventSchema.safeParse(e);
    return v.success ? { event: v.data } : { ignored: "invalid" };
  };

  switch (metadata.subscription_type) {
    case "channel.chat.message": {
      const e = ChatEvent.safeParse(payload.event);
      if (!e.success) return { ignored: "malformed" };
      const ev = e.data;
      if (ev.broadcaster_user_id !== ctx.broadcasterId) return { ignored: "other-channel" };
      // Shared chat: only commands typed in this channel count.
      if (ev.source_broadcaster_user_id && ev.source_broadcaster_user_id !== ctx.broadcasterId) return { ignored: "shared-chat-source" };
      if (ctx.ignoredLogins.includes(ev.chatter_user_login.toLowerCase())) return { ignored: "bot" };
      const parsed = parseCommand(ev.message.text, ctx.commands);
      if (!parsed) return { ignored: "not-a-command" };
      return out({
        kind: "CHAT_COMMAND", id, at, userId: ev.chatter_user_id, login: ev.chatter_user_login,
        displayName: ev.chatter_user_name, command: parsed.command, ...(parsed.arg ? { arg: parsed.arg } : {}),
      });
    }
    case "channel.subscribe": {
      const e = SubscribeEvent.safeParse(payload.event);
      if (!e.success) return { ignored: "malformed" };
      if (e.data.broadcaster_user_id !== ctx.broadcasterId) return { ignored: "other-channel" };
      // Gifted subs arrive here too; the gift batch owns those rewards.
      if (e.data.is_gift) return { ignored: "gifted-sub-owned-by-batch" };
      return out({ kind: "NEW_SUB", id, at, userId: e.data.user_id, displayName: e.data.user_name, tier: e.data.tier });
    }
    case "channel.subscription.gift": {
      const e = GiftEvent.safeParse(payload.event);
      if (!e.success) return { ignored: "malformed" };
      if (e.data.broadcaster_user_id !== ctx.broadcasterId) return { ignored: "other-channel" };
      if (e.data.total < 1) return { ignored: "empty-gift" };
      const anon = e.data.is_anonymous || !e.data.user_id;
      return out({
        kind: "GIFT_BATCH", id, at, anonymous: anon,
        gifterId: anon ? null : e.data.user_id, displayName: anon ? "Anonymous" : (e.data.user_name ?? "Someone"),
        quantity: Math.min(e.data.total, 1000), tier: e.data.tier,
      });
    }
    case "channel.subscription.message": {
      const e = ResubEvent.safeParse(payload.event);
      if (!e.success) return { ignored: "malformed" };
      if (e.data.broadcaster_user_id !== ctx.broadcasterId) return { ignored: "other-channel" };
      return out({
        kind: "RESUB_MESSAGE", id, at, userId: e.data.user_id, displayName: e.data.user_name,
        tier: e.data.tier, cumulativeMonths: e.data.cumulative_months,
      });
    }
    default:
      return { ignored: "unknown-type" };
  }
}

/** "!vote hat" -> { command: "vote", arg: "hat" }. Ordinary conversation and unknown commands -> null. */
export function parseCommand(text: string, commands: Settings["commands"]): { command: CommandKey; arg?: string } | null {
  const t = text.trim();
  if (!t.startsWith("!")) return null;
  const [head, arg] = t.split(/\s+/, 3);
  const word = head.toLowerCase();
  for (const k of COMMAND_KEYS) {
    if (commands[k].enabled && commands[k].name.toLowerCase() === word) {
      return k === "vote" ? (arg ? { command: k, arg: arg.slice(0, 32) } : { command: k }) : { command: k };
    }
  }
  return null;
}
