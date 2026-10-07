// Load test: 100 synthetic commands/second for 60 seconds into the demo session, with an overlay open in
// headless Chromium. Measures overlay frame rate, dashboard-control latency and queue bounds.
//   npm run build && npm run test:load      (RATE, SECONDS env vars to change)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 3989, BASE = `http://localhost:${PORT}`;
const RATE = Number(process.env.RATE ?? 100), SECONDS = Number(process.env.SECONDS ?? 60);
const data = mkdtempSync(join(tmpdir(), "hh-load-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "dist/server/server/main.js"], {
  env: { ...process.env, HH_PORT: String(PORT), HH_DATA_DIR: data, TWITCH_CLIENT_ID: "", TWITCH_CLIENT_SECRET: "" }, stdio: "ignore",
});
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
  const token = readFileSync(join(data, "dashboard-token"), "utf8").trim();
  const post = async (p, b) => { const t0 = performance.now(); const r = await fetch(BASE + p, { method: "POST", headers: { "X-HH-Token": token, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify(b) }); await r.json(); return performance.now() - t0; };
  const state = async () => { const t0 = performance.now(); const s = (await (await fetch(`${BASE}/api/demo/state`, { headers: { "X-HH-Token": token } })).json()).snapshot; return { s, ms: performance.now() - t0 }; };

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${BASE}/overlay?session=demo&bg=room`);
  await page.waitForFunction(() => window.__hh?.feed?.snapshot);
  await post("/api/demo/action", { action: "setMode", mode: "BRB", durationSec: 0 });
  await sleep(1500);

  await post("/api/demo/burst", { perSecond: RATE, seconds: SECONDS });
  const samples = [];
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000);
    const perf = await page.evaluate(() => { const p = window.__hh.perf; const out = { fps: p.fps, worst: p.worst }; p.worst = 0; return out; });
    const ctl = await post("/api/demo/action", { action: i % 2 ? "resume" : "clearQueue" });
    const { s, ms } = await state();
    samples.push({ t: i + 1, fps: perf.fps, worstFrameMs: perf.worst, controlMs: ctl, stateMs: ms, effects: s.effects.length, flex: s.meters.flex, smash: s.meters.smash });
    if ((i + 1) % 10 === 0) console.log(`t=${i + 1}s fps=${perf.fps.toFixed(1)} worstFrame=${perf.worst.toFixed(0)}ms control=${ctl.toFixed(1)}ms effects=${s.effects.length}`);
  }
  const stopMs = await post("/api/demo/action", { action: "emergencyStop" });
  const after = (await state()).s;
  const stats = (k) => { const v = samples.map((x) => x[k]).sort((a, b) => a - b); return { min: +v[0].toFixed(1), median: +v[Math.floor(v.length / 2)].toFixed(1), p95: +v[Math.floor(v.length * 0.95)].toFixed(1), max: +v.at(-1).toFixed(1) }; };
  const report = {
    rate: RATE, seconds: SECONDS, commandsSent: RATE * SECONDS,
    overlayFps: stats("fps"), worstFrameMs: stats("worstFrameMs"), controlLatencyMs: stats("controlMs"), stateLatencyMs: stats("stateMs"),
    maxEffectsInSnapshot: Math.max(...samples.map((x) => x.effects)), emergencyStopMs: +stopMs.toFixed(1), effectsAfterStop: after.effects.length,
    note: "Headless Chromium with software rendering on a 4-core cloud container; OBS with GPU compositing will differ.",
  };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync("docs/load-test-results.json", JSON.stringify({ report, samples }, null, 2));
  await browser.close();
} finally {
  server.kill();
}
