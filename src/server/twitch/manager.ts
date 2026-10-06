// Ties Twitch sign-in, EventSub and the live engine together and keeps a diagnostics view for the dashboard.
// Only real EventSub notifications reach the live engine; the demo never goes through here.
import { EventEmitter } from "node:events";
import type { Engine } from "../engine/engine.js";
import type { TwitchStatus } from "../../shared/types.js";
import { AuthError, BASE_SCOPES, REPLY_SCOPE, TwitchAuth, redact } from "./auth.js";
import { Helix, HelixError } from "./api.js";
import { EventSubClient } from "./eventsub.js";
import { normalize } from "./normalize.js";

const SUBSCRIPTIONS = [
  { type: "channel.chat.message", needs: "user:read:chat", chat: true },
  { type: "channel.subscribe", needs: "channel:read:subscriptions", chat: false },
  { type: "channel.subscription.gift", needs: "channel:read:subscriptions", chat: false },
  { type: "channel.subscription.message", needs: "channel:read:subscriptions", chat: false },
] as const;

export interface ManagerOptions {
  auth: TwitchAuth | null; // null = no client id/secret configured
  helix: Helix | null;
  eventsub: EventSubClient;
  engine: Engine;
  log?: (msg: string) => void;
  validateEveryMs?: number;
}

export class TwitchManager extends EventEmitter {
  private status: TwitchStatus;
  private validateTimer: NodeJS.Timeout | null = null;
  private ignored = new Map<string, number>();

  constructor(private readonly o: ManagerOptions) {
    super();
    this.status = {
      configured: !!o.auth, state: o.auth ? "signed-out" : "not-configured", account: null, scopes: [], missingScopes: [],
      subscriptions: [], lastError: null, gaps: [], redirectUri: o.auth?.cfg.redirectUri ?? "", chatOnly: false,
    };
    const es = o.eventsub;
    es.on("welcome", (sessionId: string, info: { transferred: boolean }) => void this.onWelcome(sessionId, info.transferred));
    es.on("notification", (msg: unknown) => this.onNotification(msg));
    es.on("revocation", (sub: { type: string; status: string }) => this.onRevocation(sub));
    es.on("down", (reason: string) => {
      this.status.gaps.push({ from: Date.now(), to: null });
      if (this.status.gaps.length > 20) this.status.gaps.shift();
      this.set({ state: "reconnecting", lastError: `EventSub connection lost: ${reason}. Events during the gap are not replayed.` });
    });
    es.on("socket-error", (m: string) => this.log(`EventSub socket error: ${redact(m)}`));
    o.auth?.on("signed-out", (reason: string) => {
      es.stop();
      this.set({ state: "signed-out", account: null, scopes: [], subscriptions: [], lastError: reason });
    });
  }

  get info(): TwitchStatus { return structuredClone(this.status); }

  requiredScopes(): string[] {
    const s: string[] = [...BASE_SCOPES];
    if (this.o.engine.getSettings().chatReplies.enabled) s.push(REPLY_SCOPE);
    return s;
  }

  loginUrl(): string {
    if (!this.o.auth) throw new AuthError("Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env first.", "config");
    return this.o.auth.authorizeUrl(this.requiredScopes());
  }

  async handleCallback(q: URLSearchParams): Promise<void> {
    if (!this.o.auth) throw new AuthError("Twitch is not configured.", "config");
    await this.o.auth.handleCallback(q);
    await this.start();
  }

  /** Validate (startup), check scopes, connect EventSub; then validate hourly. */
  async start(): Promise<void> {
    const auth = this.o.auth;
    if (!auth) return;
    if (!auth.signedIn) { this.set({ state: "signed-out" }); return; }
    this.set({ state: "connecting", lastError: null });
    try {
      if (!(await auth.validate())) return; // signed-out event already fired
    } catch (e) {
      this.set({ state: "error", lastError: (e as Error).message });
      setTimeout(() => void this.start(), 30_000).unref();
      return;
    }
    this.refreshScopes();
    if (this.status.missingScopes.includes("user:read:chat")) {
      this.set({ state: "error", lastError: "The sign-in is missing the user:read:chat permission. Sign in again from the dashboard." });
      return;
    }
    this.o.eventsub.stop();
    this.o.eventsub.start();
    if (!this.validateTimer) {
      this.validateTimer = setInterval(() => void this.periodicValidate(), this.o.validateEveryMs ?? 3_600_000);
      this.validateTimer.unref();
    }
  }

  stop(): void {
    this.o.eventsub.stop();
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.validateTimer = null;
  }

  signOut(): void {
    this.o.auth?.signOut("Signed out from the dashboard.");
  }

  sendChat(text: string): void {
    const a = this.o.auth?.account;
    if (!a || !this.o.helix || !this.status.scopes.includes(REPLY_SCOPE)) return;
    this.o.helix.sendChatMessage(a.id, a.id, text).catch((e: Error) => this.log(`Chat reply failed: ${redact(e.message)}`));
  }

  private async periodicValidate(): Promise<void> {
    try {
      if (await this.o.auth?.validate()) this.refreshScopes();
    } catch (e) {
      this.log(`Hourly token validation could not reach Twitch: ${(e as Error).message}`);
    }
  }

  private refreshScopes(): void {
    const scopes = this.o.auth?.scopes ?? [];
    const missing = this.requiredScopes().filter((s) => !scopes.includes(s));
    this.set({ account: this.o.auth?.account ?? null, scopes, missingScopes: missing, chatOnly: missing.includes("channel:read:subscriptions") });
  }

  /** Fresh session: (re)create the subscriptions within the 10 s window. Transferred session: keep them. */
  private async onWelcome(sessionId: string, transferred: boolean): Promise<void> {
    const gap = this.status.gaps.at(-1);
    if (gap && gap.to === null) gap.to = Date.now();
    if (transferred) { this.set({ state: "connected", lastError: null }); return; }
    const helix = this.o.helix, account = this.o.auth?.account;
    if (!helix || !account) return;
    const subs: TwitchStatus["subscriptions"] = [];
    const scopes = this.status.scopes;
    await Promise.all(SUBSCRIPTIONS.map(async (s) => {
      if (!scopes.includes(s.needs)) { subs.push({ type: s.type, status: `skipped: missing ${s.needs}` }); return; }
      const condition: Record<string, string> = s.chat ? { broadcaster_user_id: account.id, user_id: account.id } : { broadcaster_user_id: account.id };
      try {
        const r = await helix.createSubscription(s.type, condition, sessionId);
        subs.push({ type: s.type, status: r.data[0]?.status ?? "enabled" });
      } catch (e) {
        const he = e as HelixError;
        const hint = he.status === 403 ? " (subscription events need an Affiliate or Partner channel and the channel:read:subscriptions permission)" : "";
        subs.push({ type: s.type, status: `failed: ${redact(he.message)}${hint}` });
      }
    }));
    subs.sort((a, b) => a.type.localeCompare(b.type));
    const chatOk = subs.some((s) => s.type === "channel.chat.message" && /enabled/.test(s.status));
    const subOk = subs.filter((s) => s.type !== "channel.chat.message").every((s) => /enabled/.test(s.status));
    this.set({
      state: chatOk ? "connected" : "error", subscriptions: subs, chatOnly: chatOk && !subOk,
      lastError: chatOk ? (subOk ? null : "Chat commands work; subscription events are unavailable (see below).") : "Could not subscribe to chat messages.",
    });
  }

  private onNotification(msg: unknown): void {
    const account = this.o.auth?.account;
    if (!account) return;
    const s = this.o.engine.getSettings();
    const r = normalize(msg, { broadcasterId: account.id, commands: s.commands, ignoredLogins: s.ignoredLogins });
    if ("ignored" in r) { this.ignored.set(r.ignored, (this.ignored.get(r.ignored) ?? 0) + 1); return; }
    try {
      this.o.engine.apply(r.event);
    } catch (e) {
      this.log(`Engine rejected ${r.event.kind}: ${(e as Error).message}`);
    }
  }

  private onRevocation(sub: { type: string; status: string }): void {
    const subs = this.status.subscriptions.map((s) => (s.type === sub.type ? { ...s, status: `revoked: ${sub.status}` } : s));
    this.set({ subscriptions: subs, lastError: `Twitch revoked ${sub.type} (${sub.status}).` });
    if (sub.status === "authorization_revoked" || sub.status === "user_removed") this.o.auth?.signOut("The Twitch authorisation was revoked. Sign in again from the dashboard.");
  }

  private set(p: Partial<TwitchStatus>): void {
    this.status = { ...this.status, ...p };
    this.emit("change");
  }
  private log(m: string): void { (this.o.log ?? console.log)(redact(m)); }
}
