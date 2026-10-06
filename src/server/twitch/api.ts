// Minimal Helix client: EventSub subscription management and (optional) chat replies.
import type { TwitchAuth } from "./auth.js";

export const HELIX = "https://api.twitch.tv/helix";

export class HelixError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class Helix {
  private readonly fetch: typeof fetch;
  constructor(private readonly auth: TwitchAuth, private readonly clientId: string, fetchImpl?: typeof fetch) {
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  /** One retry after a refresh on 401 (expired token). */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken();
      const res = await this.fetch(`${HELIX}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Client-Id": this.clientId, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) { await this.auth.refresh(); continue; }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* keep text */ }
        throw new HelixError(res.status, `${method} ${path} failed (${res.status}): ${msg}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw new HelixError(401, "Unauthorised after refresh");
  }

  createSubscription(type: string, condition: Record<string, string>, sessionId: string) {
    return this.call<{ data: { id: string; status: string; type: string }[] }>("POST", "/eventsub/subscriptions", {
      type, version: "1", condition, transport: { method: "websocket", session_id: sessionId },
    });
  }

  sendChatMessage(broadcasterId: string, senderId: string, message: string) {
    return this.call("POST", "/chat/messages", { broadcaster_id: broadcasterId, sender_id: senderId, message: message.slice(0, 450) });
  }
}
