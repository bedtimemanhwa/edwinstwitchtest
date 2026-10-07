// Entry point: one live engine (fed only by Twitch) and one isolated demo engine (fed only by synthetic events).
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { Store } from "./persistence/store.js";
import { Engine } from "./engine/engine.js";
import { Hub } from "./websocket/hub.js";
import { createApp } from "./app.js";
import { TwitchAuth, redact } from "./twitch/auth.js";
import { Helix } from "./twitch/api.js";
import { EventSubClient } from "./twitch/eventsub.js";
import { TwitchManager } from "./twitch/manager.js";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${redact(m)}`);
const cfg = loadConfig();

const liveStore = new Store(join(cfg.dataDir, "hulks-hangout.sqlite"));
const demoStore = new Store(":memory:"); // the demo never touches live totals and is gone on restart
let twitch: TwitchManager;
const live = new Engine(liveStore, { session: "live", onChatReply: (t) => twitch?.sendChat(t) });
const demo = new Engine(demoStore, { session: "demo" });
demo.setMode("BRB");

const auth = cfg.twitch ? new TwitchAuth({ ...cfg.twitch, tokenPath: join(cfg.dataDir, "twitch-tokens.json") }) : null;
const helix = auth && cfg.twitch ? new Helix(auth, cfg.twitch.clientId) : null;
twitch = new TwitchManager({ auth, helix, eventsub: new EventSubClient(), engine: live, log });

const hub = new Hub({ live, demo }, (s) => {
  const e = s === "live" ? live : demo;
  return { stats: e.stats(), twitch: s === "live" ? twitch.info : null, queueLength: e.queueLength(), settings: e.getSettings() };
});
twitch.on("change", () => live.emit("change"));

const server = createApp({ cfg, engines: { live, demo }, hub, twitch, log });
const ticker = setInterval(() => { live.tick(); demo.tick(); }, 100);
const pruner = setInterval(() => liveStore.pruneProcessed(Date.now() - 30 * 86_400_000), 3_600_000);
pruner.unref();

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  log(`Port ${cfg.port} is already in use. Hulk's Hangout is probably already running in another window; close that one first, or set HH_PORT in .env.`);
  if (process.env.HH_OPEN_BROWSER === "1") openBrowser(`http://localhost:${cfg.port}/dashboard`);
  setTimeout(() => process.exit(1), 500);
});

server.listen(cfg.port, cfg.host, () => {
  const base = `http://localhost:${cfg.port}`;
  log(`Hulk's Hangout is running.`);
  log(`  OBS browser source (1920x1080): ${base}/overlay`);
  log(`  Dashboard:                      ${base}/dashboard`);
  log(`  Demo (synthetic events only):   ${base}/demo`);
  if (!cfg.twitch) log("Twitch is not configured: add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env (see README). Demo mode works without them.");
  else log(`Twitch OAuth redirect URL (register exactly this in the Twitch console): ${cfg.twitch.redirectUri}`);
  void twitch.start();
  if (process.env.HH_OPEN_BROWSER === "1") openBrowser(`${base}/dashboard`);
});

/** Used by the start-windows.bat / start.sh launchers so a double-click lands on the dashboard. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => log(`Open ${url} in your browser.`)).unref();
  } catch {
    log(`Open ${url} in your browser.`);
  }
}

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  log("Shutting down...");
  clearInterval(ticker);
  twitch.stop();
  live.flush();
  hub.close();
  server.close(() => { liveStore.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
