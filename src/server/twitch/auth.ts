// Twitch OAuth (authorization code flow) for the broadcaster's user access token.
// Secrets and tokens live only on the backend, in a file outside version control (data/), never in URLs or bundles.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
export const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

export const BASE_SCOPES = ["user:read:chat", "channel:read:subscriptions"] as const;
export const REPLY_SCOPE = "user:write:chat";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: number;
  userId: string;
  login: string;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class AuthError extends Error {
  constructor(message: string, readonly kind: "revoked" | "network" | "config" | "state") { super(message); }
}

/** Never let a token or secret reach a log line. */
export const redact = (s: string): string => s.replace(/(access_token|refresh_token|client_secret|code)=([^&\s"]+)/gi, "$1=[redacted]")
  .replace(/("(?:accessToken|refreshToken|access_token|refresh_token|client_secret)"\s*:\s*")[^"]+"/g, '$1[redacted]"')
  .replace(/(Bearer|OAuth)\s+[A-Za-z0-9]+/g, "$1 [redacted]");

export class TwitchAuth extends EventEmitter {
  private tokens: Tokens | null = null;
  private states = new Map<string, number>();
  private refreshing: Promise<Tokens> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(readonly cfg: AuthConfig) {
    super();
    this.fetch = cfg.fetch ?? globalThis.fetch;
    this.now = cfg.now ?? Date.now;
    this.tokens = this.load();
  }

  get signedIn(): boolean { return !!this.tokens; }
  get account(): { id: string; login: string } | null { return this.tokens ? { id: this.tokens.userId, login: this.tokens.login } : null; }
  get scopes(): string[] { return this.tokens?.scopes ?? []; }

  /** Start the sign-in: a random, single-use state that expires in 10 minutes. */
  authorizeUrl(scopes: string[]): string {
    const state = randomBytes(24).toString("hex");
    this.states.set(state, this.now() + 10 * 60_000);
    for (const [k, exp] of this.states) if (exp < this.now()) this.states.delete(k);
    const q = new URLSearchParams({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri,
      scope: scopes.join(" "), state, force_verify: "true",
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  /** OAuth redirect target. Consumes the state (single use), exchanges the code, validates the account. */
  async handleCallback(query: URLSearchParams): Promise<Tokens> {
    const state = query.get("state") ?? "";
    const exp = this.states.get(state);
    this.states.delete(state);
    if (!exp || exp < this.now()) throw new AuthError("The sign-in link expired or was already used. Start the sign-in again from the dashboard.", "state");
    const err = query.get("error");
    if (err) throw new AuthError(`Twitch sign-in was not completed: ${query.get("error_description") ?? err}`, "revoked");
    const code = query.get("code");
    if (!code) throw new AuthError("Twitch did not return an authorization code.", "state");
    const body = new URLSearchParams({
      client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code,
      grant_type: "authorization_code", redirect_uri: this.cfg.redirectUri,
    });
    const res = await this.post(TOKEN_URL, body);
    if (!res.ok) throw new AuthError(`Token exchange failed (${res.status}). Check the client ID, secret and redirect URL.`, "config");
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string[] };
    const v = await this.validateToken(j.access_token);
    if (!v) throw new AuthError("Twitch returned a token that does not validate.", "revoked");
    const t: Tokens = { accessToken: j.access_token, refreshToken: j.refresh_token, scopes: v.scopes, expiresAt: this.now() + v.expires_in * 1000, userId: v.user_id, login: v.login };
    this.save(t);
    this.emit("signed-in", this.account);
    return t;
  }

  /** A usable access token, refreshing first if it is about to expire. */
  async accessToken(): Promise<string> {
    if (!this.tokens) throw new AuthError("Not signed in to Twitch.", "revoked");
    if (this.tokens.expiresAt - this.now() < 60_000) await this.refresh();
    return this.tokens!.accessToken;
  }

  /** Startup and hourly validation, as Twitch requires. Refreshes on 401; signs out if that fails too. */
  async validate(): Promise<boolean> {
    if (!this.tokens) return false;
    const v = await this.validateToken(this.tokens.accessToken);
    if (v) {
      if (v.user_id !== this.tokens.userId) { this.signOut("The token belongs to a different account."); return false; }
      this.tokens.scopes = v.scopes;
      this.tokens.expiresAt = this.now() + v.expires_in * 1000;
      this.save(this.tokens);
      return true;
    }
    try { await this.refresh(); return true; } catch { return false; }
  }

  /** Refresh once at a time; concurrent callers share the same refresh. */
  refresh(): Promise<Tokens> {
    if (!this.tokens) return Promise.reject(new AuthError("Not signed in to Twitch.", "revoked"));
    this.refreshing ??= (async () => {
      try {
        const body = new URLSearchParams({
          client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
          grant_type: "refresh_token", refresh_token: this.tokens!.refreshToken,
        });
        const res = await this.post(TOKEN_URL, body);
        if (res.status === 400 || res.status === 401) {
          this.signOut("Twitch authorisation expired or was revoked. Sign in again from the dashboard.");
          throw new AuthError("Authorisation revoked", "revoked");
        }
        if (!res.ok) throw new AuthError(`Token refresh failed (${res.status})`, "network");
        const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string[] };
        const t: Tokens = { ...this.tokens!, accessToken: j.access_token, refreshToken: j.refresh_token, scopes: j.scope ?? this.tokens!.scopes, expiresAt: this.now() + j.expires_in * 1000 };
        this.save(t);
        this.emit("refreshed");
        return t;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  signOut(reason: string): void {
    this.tokens = null;
    if (existsSync(this.cfg.tokenPath)) rmSync(this.cfg.tokenPath);
    this.emit("signed-out", reason);
  }

  private async validateToken(token: string): Promise<{ client_id: string; login: string; user_id: string; scopes: string[]; expires_in: number } | null> {
    let res: Response;
    try {
      res = await this.fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${token}` } });
    } catch (e) {
      throw new AuthError(`Could not reach Twitch to validate the token: ${(e as Error).message}`, "network");
    }
    if (res.status === 401) return null;
    if (!res.ok) throw new AuthError(`Token validation failed (${res.status})`, "network");
    return (await res.json()) as never;
  }

  private async post(url: string, body: URLSearchParams): Promise<Response> {
    try {
      return await this.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    } catch (e) {
      throw new AuthError(`Could not reach Twitch: ${(e as Error).message}`, "network");
    }
  }

  private load(): Tokens | null {
    try {
      return existsSync(this.cfg.tokenPath) ? (JSON.parse(readFileSync(this.cfg.tokenPath, "utf8")) as Tokens) : null;
    } catch {
      return null;
    }
  }
  private save(t: Tokens): void {
    this.tokens = t;
    mkdirSync(dirname(this.cfg.tokenPath), { recursive: true });
    writeFileSync(this.cfg.tokenPath, JSON.stringify(t), { mode: 0o600 });
    try { chmodSync(this.cfg.tokenPath, 0o600); } catch { /* Windows: see README, keep data/ private */ }
  }
}
