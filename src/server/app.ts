// HTTP routes: the three pages, static assets, the dashboard API and the Twitch OAuth callback.
// Bound to loopback; Host and Origin are checked on every request (DNS-rebinding and cross-site protection),
// and every state-changing call needs the per-install dashboard token that only the dashboard page carries.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, normalize as normPath, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import type { Engine } from "./engine/engine.js";
import type { Hub } from "./websocket/hub.js";
import type { TwitchManager } from "./twitch/manager.js";
import { demoEvent, startBurst } from "./demo/producer.js";
import { MODES, SELECTABLE_MODES, type Mode, type SessionKind } from "../shared/types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

export interface AppDeps { cfg: Config; engines: Record<SessionKind, Engine>; hub: Hub; twitch: TwitchManager; log: (m: string) => void }

export function dashboardToken(dataDir: string): string {
  const p = join(dataDir, "dashboard-token");
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const t = randomBytes(24).toString("hex");
  writeFileSync(p, t, { mode: 0o600 });
  return t;
}

export function createApp(d: AppDeps): Server {
  const { cfg } = d;
  const token = dashboardToken(cfg.dataDir);
  const hosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const goodToken = (t: string | null | undefined) => !!t && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token));
  let stopBurst: (() => void) | null = null;

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: Error) => {
      d.log(`HTTP error: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = req.headers.origin;
    const session = url.searchParams.get("session") === "demo" ? "demo" : "live";
    const role = url.searchParams.get("role") === "dashboard" ? "dashboard" : "overlay";
    const ok = url.pathname === "/ws" && hosts.has(req.headers.host ?? "") && (!origin || origins.has(origin)) &&
      (role === "overlay" || (origin && goodToken(url.searchParams.get("token"))));
    if (!ok) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    d.hub.handleUpgrade(req, socket, head, session, role);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Unknown host. Open the app via localhost or 127.0.0.1." });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const p = url.pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    if (req.method === "GET") {
      if (p === "/") return redirect(res, "/dashboard");
      if (p === "/overlay") return page(res, "overlay.html", false);
      if (p === "/dashboard") return page(res, "dashboard.html", true);
      if (p === "/demo") return page(res, "demo.html", true);
      if (p === "/healthz") return send(res, 200, { ok: true });
      if (p === "/pack/manifest.json" || p.startsWith("/pack/files/")) return packFile(res, p);
      if (p.startsWith("/assets/") || p.startsWith("/pack/")) return staticFile(res, p);
      if (p === "/auth/login") {
        if (!goodToken(url.searchParams.get("token"))) return send(res, 403, { error: "Open sign-in from the dashboard." });
        try { return redirect(res, d.twitch.loginUrl()); } catch (e) { return html(res, 400, "Twitch is not configured", (e as Error).message); }
      }
      if (p === "/auth/callback") {
        try {
          await d.twitch.handleCallback(url.searchParams);
          return html(res, 200, "Signed in to Twitch", "You can close this tab and return to the dashboard.");
        } catch (e) {
          return html(res, 400, "Twitch sign-in failed", (e as Error).message);
        }
      }
      const m = p.match(/^\/api\/(live|demo)\/state$/);
      if (m) {
        if (!goodToken(req.headers["x-hh-token"] as string)) return send(res, 403, { error: "missing dashboard token" });
        return send(res, 200, { snapshot: d.engines[m[1] as SessionKind].snapshot() });
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.method === "POST") {
      // Mutations: same-origin pages only, and only with the dashboard token.
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin) || !goodToken(req.headers["x-hh-token"] as string)) return send(res, 403, { error: "forbidden" });
      const body = await readJson(req);
      if (p === "/api/twitch/logout") { d.twitch.signOut(); return send(res, 200, { ok: true }); }
      if (p === "/api/twitch/reconnect") { await d.twitch.start(); return send(res, 200, { ok: true }); }
      if (p === "/api/demo/event") {
        const kind = String(body.kind ?? "CHAT_COMMAND");
        const ev = demoEvent(kind, body as never);
        return send(res, 200, d.engines.demo.apply(ev));
      }
      if (p === "/api/demo/burst") {
        stopBurst?.();
        const perSecond = clampNum(body.perSecond, 1, 500, 100), seconds = clampNum(body.seconds, 1, 300, 60);
        stopBurst = startBurst((e) => d.engines.demo.apply(e), perSecond, seconds, ["flex", "smash", "feed", "vote", "hulk"]);
        return send(res, 200, { ok: true, perSecond, seconds });
      }
      const m = p.match(/^\/api\/(live|demo)\/action$/);
      if (m) return send(res, 200, action(d.engines[m[1] as SessionKind], body));
      return send(res, 404, { error: "not found" });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  function action(e: Engine, b: Record<string, unknown>): unknown {
    const mode = String(b.mode ?? "") as Mode;
    switch (b.action) {
      case "setMode":
        if (!(SELECTABLE_MODES as readonly string[]).includes(mode)) return { error: "bad mode" };
        e.setMode(mode, b.durationSec === undefined ? undefined : clampNum(b.durationSec, 0, 7200, 0));
        return { ok: true };
      case "start": e.startSession((MODES as readonly string[]).includes(mode) ? mode : "INTRO"); return { ok: true };
      case "pause": e.pause(); return { ok: true };
      case "resume": e.resume(); return { ok: true };
      case "endSession": e.endSession(); return { ok: true };
      case "emergencyStop": stopBurst?.(); e.emergencyStop(); return { ok: true };
      case "clearQueue": e.clearQueue(); return { ok: true };
      case "resetVotes": e.resetVotes(); return { ok: true };
      case "updateSettings":
        try { return { ok: true, settings: e.updateSettings(b.settings) }; } catch (err) { return { error: (err as Error).message }; }
      case "resetProgress":
        if (b.confirm !== "RESET") return { error: "type RESET to confirm" };
        e.resetProgress(); return { ok: true };
      default: return { error: "unknown action" };
    }
  }

  function page(res: ServerResponse, file: string, withToken: boolean): void {
    const f = join(cfg.webDir, file);
    if (!existsSync(f)) return html(res, 503, "Not built yet", "Run npm run build (or npm run dev) first.");
    let body = readFileSync(f, "utf8");
    if (withToken) body = body.replace("</head>", `<meta name="hh-token" content="${token}"></head>`);
    res.setHeader("Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self' ws://localhost:${cfg.port} ws://127.0.0.1:${cfg.port}; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`);
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(body);
  }

  function staticFile(res: ServerResponse, p: string): void {
    serveFrom(res, cfg.webDir, p);
  }
  /** The active asset pack (placeholder by default; a streamer's own pack via HH_ASSET_PACK). */
  function packFile(res: ServerResponse, p: string): void {
    serveFrom(res, cfg.assetPack, p === "/pack/manifest.json" ? "/manifest.json" : p.slice("/pack/files".length));
  }
  function serveFrom(res: ServerResponse, root: string, p: string): void {
    const file = resolve(root, "." + normPath(decodeURIComponent(p)));
    if (!file.startsWith(resolve(root) + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  }

  return server;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { Location: to });
  res.end();
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function html(res: ServerResponse, status: number, title: string, msg: string): void {
  res.writeHead(status, { "Content-Type": MIME[".html"], "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;background:#10140f;color:#e8f5e0;padding:40px"><h1>${esc(title)}</h1><p>${esc(msg)}</p><p><a style="color:#8fe36a" href="/dashboard">Back to the dashboard</a></p>`);
}
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveP, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64 * 1024) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolveP({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolveP(v && typeof v === "object" ? v : {}); } catch { resolveP({}); }
    });
    req.on("error", reject);
  });
}
function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
