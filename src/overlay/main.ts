// OBS browser source entry: /overlay  (options: ?session=demo, ?bg=room, ?reduced=1, ?debug=1)
import { connect } from "../web/conn.js";
import { loadAssets } from "./assets.js";
import { H, Renderer, W } from "./renderer.js";
import type { Effect, Snapshot } from "../shared/types.js";

const q = new URLSearchParams(location.search);
const session = q.get("session") === "demo" ? "demo" : "live";
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: true })!;
canvas.width = W;
canvas.height = H;

const SOUND_FOR: Partial<Record<Effect["type"], string>> = {
  "new-sub": "celebrate", "welcome-back": "celebrate", summary: "celebrate", "gift-delivery": "smash",
  "wake-up": "wake", "big-flex": "flex", "community-smash": "smash", snack: "snack",
};

async function main(): Promise<void> {
  const assets = await loadAssets();
  const r = new Renderer(ctx, assets);
  const loadedAt = Date.now();
  let last: Snapshot | null = null;
  let offset = 0;
  const feed = connect(session, "overlay", (f) => { last = f.snapshot; offset = f.offset; });
  const played = new Set<string>();
  let lastSnackSound = 0;

  // perf counter for the load test (?debug=1 shows it; window.__hh exposes it to tests)
  const perf = { frames: 0, worst: 0, since: performance.now(), fps: 0 };
  (window as unknown as { __hh: unknown }).__hh = { perf, feed };
  let prev = performance.now();

  const frame = (now: number) => {
    const dt = now - prev; prev = now;
    perf.frames++; perf.worst = Math.max(perf.worst, dt);
    if (now - perf.since >= 1000) { perf.fps = (perf.frames * 1000) / (now - perf.since); perf.frames = 0; perf.since = now; }
    const s = last;
    if (s) {
      const t = Date.now() + offset;
      r.render(s, t, { transparent: q.get("bg") !== "room", reduced: q.get("reduced") === "1" });
      sounds(s, t);
      if (q.get("debug") === "1") {
        ctx.font = "20px monospace"; ctx.fillStyle = "#ff0"; ctx.fillText(`${perf.fps.toFixed(0)} fps  worst ${perf.worst.toFixed(0)} ms  ${feed.connected ? "connected" : "OFFLINE"}`, 10, 24);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  function sounds(s: Snapshot, t: number): void {
    if (s.sound.muted || s.stopped) return;
    for (const e of s.effects) {
      if (played.has(e.id) || e.startAt > t) continue;
      played.add(e.id);
      // A late-joining overlay never replays a celebration that started before it loaded.
      if (e.startAt < loadedAt + offset - 300) continue;
      const key = SOUND_FOR[e.type];
      if (e.type === "snack") { if (t - lastSnackSound < 1500) continue; lastSnackSound = t; }
      if (!key) continue;
      const a = assets.sound(key);
      if (!a) continue;
      a.volume = s.sound.volume;
      a.currentTime = 0;
      void a.play().catch(() => { /* autoplay blocked outside OBS: fine */ });
      if (e.decoration) {
        const u = assets.sound("unlock");
        if (u) setTimeout(() => { u.volume = s.sound.volume; void u.play().catch(() => {}); }, (e.endAt - e.startAt) * 0.45);
      }
    }
    if (played.size > 500) for (const id of [...played].slice(0, 250)) played.delete(id);
  }
}

void main();
