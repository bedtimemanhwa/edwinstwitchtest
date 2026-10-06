// Browser smoke test: starts its own server (fresh temp data dir), drives the isolated demo session,
// checks overlay + dashboard in headless Chromium, and writes screenshots to docs/screenshots/.
//   npm run build && npm run test:smoke
// Uses CHROMIUM_PATH if set, else Playwright's default browser.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = Number(process.env.SMOKE_PORT ?? 3988);
const BASE = `http://localhost:${PORT}`;
const data = mkdtempSync(join(tmpdir(), "hh-smoke-"));
const shots = join(process.cwd(), "docs/screenshots");
mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "dist/server/server/main.js"], {
  env: { ...process.env, HH_PORT: String(PORT), HH_DATA_DIR: data, TWITCH_CLIENT_ID: "", TWITCH_CLIENT_SECRET: "" }, stdio: "ignore",
});
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
  const token = readFileSync(join(data, "dashboard-token"), "utf8").trim();
  const api = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "X-HH-Token": token, Origin: BASE }, body: JSON.stringify(body) })).json();
  const state = async (s) => (await (await fetch(`${BASE}/api/${s}/state`, { headers: { "X-HH-Token": token } })).json()).snapshot;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  let dialogs = 0;
  ctx.on("page", (p) => { p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => { dialogs++; void d.dismiss(); }); });

  // --- overlay basics (live session, transparent)
  const live = await ctx.newPage();
  await live.goto(`${BASE}/overlay`);
  await live.waitForFunction(() => window.__hh?.feed?.connected && window.__hh.feed.snapshot, null, { timeout: 10000 });
  check("live overlay connects and receives a snapshot", true);

  // --- demo scenes, rendered with the room background
  const demo = await ctx.newPage();
  await demo.goto(`${BASE}/overlay?session=demo&bg=room&debug=0`);
  await demo.waitForFunction(() => window.__hh?.feed?.snapshot, null, { timeout: 10000 });
  const shot = async (name, page = demo) => { await sleep(600); await page.screenshot({ path: join(shots, `${name}.png`) }); };

  await api("/api/demo/action", { action: "setMode", mode: "INTRO", durationSec: 300 });
  for (let i = 0; i < 7; i++) await api("/api/demo/event", { kind: "CHAT_COMMAND", command: "wake", userId: `w${i}` });
  await shot("01-intro");
  let s = await state("demo");
  check("!wake adds energy in INTRO", s.meters.wake === 35, `wake=${s.meters.wake}`);
  const again = await api("/api/demo/event", { kind: "CHAT_COMMAND", command: "wake", userId: "w0" });
  check("cooldown violation adds no energy", again.accepted === false && (await state("demo")).meters.wake === 35, again.reason);

  await api("/api/demo/action", { action: "setMode", mode: "BRB", durationSec: 0 });
  for (let i = 0; i < 6; i++) await api("/api/demo/event", { kind: "CHAT_COMMAND", command: "smash", userId: `s${i}` });
  for (let i = 0; i < 5; i++) await api("/api/demo/event", { kind: "CHAT_COMMAND", command: "vote", arg: i < 3 ? "shades" : "hat", userId: `v${i}` });
  await shot("02-brb");

  await api("/api/demo/event", { kind: "GIFT_BATCH", quantity: 10, name: "GammaGal" });
  await sleep(3200);
  await shot("03-gift-celebration");

  // --- untrusted usernames
  const evil = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;
  await api("/api/demo/event", { kind: "NEW_SUB", name: evil });
  await sleep(1500);
  const dash = await ctx.newPage();
  await dash.goto(`${BASE}/demo`);
  await dash.waitForSelector("text=DEMO SESSION");
  await sleep(1200);
  const pwned = (await demo.evaluate(() => window.__pwned)) ?? (await dash.evaluate(() => window.__pwned));
  const injected = await dash.evaluate(() => document.querySelectorAll("img[src='x'], body script:not([type])").length);
  check("untrusted usernames cannot inject HTML or script", !pwned && injected === 0 && dialogs === 0, `pwned=${pwned} injectedNodes=${injected} dialogs=${dialogs}`);
  await dash.screenshot({ path: join(shots, "06-demo-page.png"), fullPage: true });

  // --- two overlays: no double awarding; late join without replay
  const before = (await state("demo")).room.supportUnits;
  const second = await ctx.newPage();
  await second.goto(`${BASE}/overlay?session=demo&bg=room`);
  await second.waitForFunction(() => window.__hh?.feed?.snapshot);
  await api("/api/demo/event", { kind: "NEW_SUB", name: "TwoOverlays" });
  await sleep(500);
  const after = (await state("demo")).room.supportUnits;
  const seen = await Promise.all([demo, second].map((p) => p.evaluate(() => window.__hh.feed.snapshot.room.supportUnits)));
  check("two overlays do not duplicate progression", after === before + 1 && seen.every((v) => v === after), `before=${before} after=${after} overlays=${seen}`);
  await sleep(20000); // let the queue finish
  await second.reload();
  await second.waitForFunction(() => window.__hh?.feed?.snapshot);
  const replay = await second.evaluate(() => window.__hh.feed.snapshot.effects.filter((e) => e.priority > 10 && e.endAt < Date.now() + window.__hh.feed.offset).length);
  check("reload does not replay completed rewards", replay === 0, `finished effects in snapshot: ${replay}`);

  // --- outro and end card
  await api("/api/demo/action", { action: "setMode", mode: "OUTRO", durationSec: 12 });
  await shot("04-outro");
  await sleep(12500);
  s = await state("demo");
  check("outro expires on schedule into the end card", s.mode === "END", s.mode);
  await shot("05-end-card");

  // --- live overlay in LIVE mode (transparent companion) + 720p readability
  await api("/api/live/action", { action: "setMode", mode: "LIVE" });
  await shot("07-live-companion-transparent", live);
  const p720 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await p720.goto(`${BASE}/overlay?session=demo&bg=room`);
  await api("/api/demo/action", { action: "setMode", mode: "BRB", durationSec: 0 });
  await p720.waitForFunction(() => window.__hh?.feed?.snapshot?.mode === "BRB");
  await shot("08-brb-720p", p720);
  await api("/api/demo/action", { action: "setMode", mode: "INTRO", durationSec: 300 });
  await shot("09-intro-720p", p720);

  // --- dashboard
  const d = await ctx.newPage();
  await d.goto(`${BASE}/dashboard`);
  await d.waitForSelector("text=server connected", { timeout: 10000 });
  check("dashboard loads and connects", true);
  await d.screenshot({ path: join(shots, "10-dashboard.png"), fullPage: true });
  const stop = await api("/api/demo/action", { action: "emergencyStop" });
  check("emergency stop clears effects immediately", stop.ok === true && (await state("demo")).effects.length === 0);

  // --- rejected without token / origin
  const noTok = await fetch(`${BASE}/api/live/action`, { method: "POST", headers: { Origin: BASE }, body: "{}" });
  const badOrigin = await fetch(`${BASE}/api/live/action`, { method: "POST", headers: { Origin: "http://evil.example", "X-HH-Token": token }, body: "{}" });
  check("dashboard mutations need the token and a local origin", noTok.status === 403 && badOrigin.status === 403);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
} catch (e) {
  check("smoke run", false, String(e?.stack ?? e));
} finally {
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: docs/screenshots/`);
process.exit(failed.length ? 1 : 0);
