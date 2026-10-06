// EventSub WebSocket notification fixtures, shaped like the payloads in Twitch's subscription-type reference.
let n = 0;
export const BROADCASTER = "141981764";

function envelope(type: string, event: Record<string, unknown>, id = `msg-${++n}`) {
  return {
    metadata: { message_id: id, message_type: "notification", message_timestamp: "2026-10-06T19:00:00.000Z", subscription_type: type, subscription_version: "1" },
    payload: { subscription: { id: "sub", type, version: "1", status: "enabled", cost: 0, condition: {}, transport: { method: "websocket", session_id: "s" }, created_at: "x" }, event },
  };
}

const b = { broadcaster_user_id: BROADCASTER, broadcaster_user_login: "hulkstreams", broadcaster_user_name: "HulkStreams" };

export const chat = (text: string, o: Partial<{ chatter: string; login: string; source: string | null; id: string; broadcaster: string }> = {}) =>
  envelope("channel.chat.message", {
    ...b, broadcaster_user_id: o.broadcaster ?? BROADCASTER,
    chatter_user_id: o.chatter ?? "4242", chatter_user_login: o.login ?? "viewer_one", chatter_user_name: o.login ?? "Viewer_One",
    message_id: "cm", message: { text, fragments: [{ type: "text", text, cheermote: null, emote: null, mention: null }] },
    color: "#00FF00", badges: [], message_type: "text", cheer: null, reply: null, channel_points_custom_reward_id: null,
    source_broadcaster_user_id: o.source ?? null, source_broadcaster_user_login: null, source_broadcaster_user_name: null, source_message_id: null, source_badges: null,
  }, o.id);

export const subscribe = (isGift: boolean, id?: string, user = "Bruce") =>
  envelope("channel.subscribe", { ...b, user_id: `u-${user}`, user_login: user.toLowerCase(), user_name: user, tier: "1000", is_gift: isGift }, id);

export const gift = (total: number, anonymous = false, id?: string) =>
  envelope("channel.subscription.gift", {
    ...b, user_id: anonymous ? null : "777", user_login: anonymous ? null : "natasha", user_name: anonymous ? null : "Natasha",
    total, tier: "1000", cumulative_total: anonymous ? null : 99, is_anonymous: anonymous,
  }, id);

export const resub = (months: number, id?: string) =>
  envelope("channel.subscription.message", {
    ...b, user_id: "888", user_login: "thor", user_name: "Thor", tier: "1000",
    message: { text: "this is never displayed", emotes: [] }, cumulative_months: months, streak_months: null, duration_months: 1,
  }, id);
