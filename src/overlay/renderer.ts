// Canvas renderer. Pure presentation: it draws whatever the server snapshot says, at time t.
// Stable state is authoritative; these animations can be cut short at any moment without consequence.
import type { Effect, Snapshot } from "../shared/types.js";
import type { Assets } from "./assets.js";
import { fmtClock } from "../web/conn.js";

export const W = 1920, H = 1080;
const GREEN = "#8fe36a", GOLD = "#ffd23f", INK = "#0d120b", WHITE = "#f4fff0";
const FONT = `"Arial Black", "Segoe UI Black", Impact, Arial, sans-serif`;
const BODY = `"Segoe UI", Arial, sans-serif`;

export interface RenderOpts { transparent: boolean; reduced: boolean }

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));

const DECO_NAMES: Record<string, string> = {
  "gamma-trophy": "Gamma trophy", "neon-sign": "Neon SMASH sign", "punching-bag": "Punching bag", "green-rug": "Green rug",
  "arcade-cabinet": "Arcade cabinet", "potted-plant": "Potted plant", "smash-banner": "Gamma banner", "giant-fridge": "Giant fridge",
  "lava-lamp": "Lava lamp", "championship-belt": "Championship belt",
};
export const decoName = (id: string) => DECO_NAMES[id] ?? (id.startsWith("trophy-") ? `Trophy #${id.slice(7)}` : id);

export class Renderer {
  constructor(private readonly ctx: CanvasRenderingContext2D, private readonly a: Assets) {}

  render(s: Snapshot, t: number, o: RenderOpts): void {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const reduced = o.reduced || s.reducedMotion;
    const main = s.stopped ? undefined : s.effects.find((e) => e.priority > 10 && e.startAt <= t && e.endAt > t);
    const light = s.stopped ? [] : s.effects.filter((e) => e.priority <= 10 && e.startAt <= t && e.endAt > t);
    const live = s.mode === "LIVE";

    // camera shake (small, never on reduced motion, never a flash)
    c.save();
    if (!reduced && main && (main.type === "community-smash" || main.type === "gift-delivery")) {
      const u = (t - main.startAt) / (main.endAt - main.startAt);
      if (u > 0.35 && u < 0.5) c.translate(Math.sin(t / 23) * 7, Math.cos(t / 29) * 5);
    }

    if (!live || !o.transparent) this.room(s, s.mode === "INTRO" || s.mode === "END" ? 0.55 : 1);
    if (!live) this.decorations(s, t);

    // character
    const pos = live ? { x: 1745, y: 1060, k: 0.42 } : { x: 960, y: 838, k: 1.05 };
    if (live) this.backplate(pos.x - 115, 760, 230, 300);
    this.character(s, t, pos.x, pos.y, pos.k, reduced, main);
    if (main && (main.type === "gift-delivery" || main.type === "community-smash")) this.crate(main, t, pos, reduced);
    for (const e of light) if (e.type === "snack") this.snack(e, t, pos);
    c.restore();

    // HUD per scene
    switch (s.mode) {
      case "INTRO": this.introHud(s, t); break;
      case "LIVE": this.liveHud(s, t, light); break;
      case "BRB": this.brbHud(s, t, light); break;
      case "OUTRO": this.outroHud(s, t); break;
      case "END": this.endCard(); break;
    }
    if (s.paused && s.mode !== "END") this.chip("Interactions paused", live ? 1490 : 40, live ? 700 : 1010, "#30402a");
    for (const e of light) if (e.type === "help") this.help(s, e, t, live);
    if (main) this.banner(main, t, s.mode, reduced);
  }

  // ------------------------------------------------------------------ scenery
  private room(s: Snapshot, dim: number): void {
    const bg = this.a.img(this.a.manifest.room.background);
    const c = this.ctx;
    if (bg) c.drawImage(bg, 0, 0, W, H); else { c.fillStyle = "#1c2618"; c.fillRect(0, 0, W, H); }
    if (dim < 1) { c.fillStyle = `rgba(5,8,4,${1 - dim})`; c.fillRect(0, 0, W, H); }
    void s;
  }

  private decorations(s: Snapshot, t: number): void {
    const c = this.ctx;
    const slots = [[180, 200], [330, 200], [1440, 200], [1590, 200], [140, 660], [1640, 660], [320, 660], [1460, 660], [480, 200], [1290, 200]];
    const tidy = s.mode === "OUTRO" && s.countdown.durationMs > 0 && s.countdown.remainingMs !== null ? clamp01(1 - s.countdown.remainingMs / s.countdown.durationMs) : 0;
    s.room.unlocks.slice(0, slots.length).forEach((id, i) => {
      const f = this.a.manifest.decorations[id] ?? this.a.manifest.fallbackDecoration;
      const im = this.a.img(f);
      if (!im) return;
      const [x, y] = slots[i];
      c.save();
      c.globalAlpha = 1 - tidy * 0.35; // cleaning up: the room quietens towards bedtime
      c.drawImage(im, x - 70, y - 10, 140, 140);
      c.restore();
    });
    const extra = s.room.unlocks.length - slots.length;
    if (extra > 0) this.text(`+${extra} more trophies`, 960, 1050, 28, GOLD, "center");
    void t;
  }

  private backplate(x: number, y: number, w: number, h: number): void {
    const c = this.ctx;
    c.save();
    c.fillStyle = "rgba(10,16,8,0.45)";
    this.roundRect(x, y, w, h, 24);
    c.fill();
    c.restore();
  }

  // ------------------------------------------------------------------ character
  private character(s: Snapshot, t: number, x: number, y: number, k: number, reduced: boolean, main?: Effect): void {
    const m = this.a.manifest.character;
    const st = s.character;
    const pose = st === "sleeping" || (st === "bedtime" && (s.countdown.remainingMs ?? 0) < 15_000) ? m.sleeping
      : st === "flexing" ? m.flex : m.idle;
    const im = this.a.img(pose);
    const c = this.ctx;
    let dy = 0, sx = 1, sy = 1, rot = 0, glow = 0;
    const u = main ? clamp01((t - main.startAt) / (main.endAt - main.startAt)) : 0;
    if (!reduced) {
      switch (st) {
        case "idle": dy = Math.sin(t / 600) * 6; break;
        case "sleeping": sy = 1 + Math.sin(t / 900) * 0.015; break;
        case "waking": { const p = Math.sin(Math.PI * clamp01(u * 1.4)); sx = 1 + p * 0.06; sy = 1 + p * 0.12; break; }
        case "eating": sy = 1 + Math.sin(t / 55) * 0.035; sx = 1 - Math.sin(t / 55) * 0.02; break;
        case "flexing": { const p = 1 + Math.sin(t / 160) * 0.035; sx = p; sy = p; glow = 0.5; break; }
        case "charging": glow = 0.35 + Math.sin(t / 250) * 0.2; dy = Math.sin(t / 45) * 2; break;
        case "smashing": dy = u < 0.35 ? -60 * ease(u / 0.35) : u < 0.42 ? -60 + 60 * ease((u - 0.35) / 0.07) : 0; break;
        case "celebrating": dy = -Math.abs(Math.sin(t / 220)) * 34; break;
        case "bedtime": rot = Math.sin(t / 1400) * 0.03; break;
      }
    } else if (st === "flexing" || st === "charging") glow = 0.3;
    const w = m.width * k, h = m.height * k;
    c.save();
    c.translate(x, y + dy);
    c.rotate(rot);
    c.scale(sx, sy);
    if (glow > 0) {
      const g = c.createRadialGradient(0, -h / 2, h * 0.1, 0, -h / 2, h * 0.75);
      g.addColorStop(0, `rgba(143,227,106,${0.55 * glow})`);
      g.addColorStop(1, "rgba(143,227,106,0)");
      c.fillStyle = g;
      c.fillRect(-h, -h * 1.3, h * 2, h * 1.6);
    }
    const prop = s.activeProp ? this.a.manifest.props[s.activeProp] : undefined;
    if (prop?.behind) this.prop(prop, w, h);
    if (im) c.drawImage(im, -w / 2, -h, w, h);
    else { c.fillStyle = "#5fbf3a"; c.fillRect(-w / 3, -h, (w * 2) / 3, h); }
    if (prop && !prop.behind) this.prop(prop, w, h);
    c.restore();
    if (st === "sleeping" || (st === "bedtime" && (s.countdown.remainingMs ?? 0) < 15_000)) this.zzz(x + w * 0.22, y - h * 0.9, t, k, reduced);
  }

  private prop(p: { file: string; x: number; y: number; w: number }, w: number, h: number): void {
    const im = this.a.img(p.file);
    if (!im) return;
    const pw = p.w * w, ph = (pw * im.height) / im.width;
    this.ctx.drawImage(im, -w / 2 + p.x * w - pw / 2, -h + p.y * h - ph / 2, pw, ph);
  }

  private zzz(x: number, y: number, t: number, k: number, reduced: boolean): void {
    for (let i = 0; i < 3; i++) {
      const p = reduced ? i / 3 : ((t / 2200 + i / 3) % 1);
      this.ctx.save();
      this.ctx.globalAlpha = reduced ? 0.8 : Math.sin(Math.PI * p);
      this.text("Z", x + p * 60 * k + i * 6, y - p * 120 * k, (38 + i * 10) * Math.max(k, 0.6), WHITE, "left");
      this.ctx.restore();
    }
  }

  private crate(e: Effect, t: number, pos: { x: number; y: number; k: number }, reduced: boolean): void {
    const u = clamp01((t - e.startAt) / (e.endAt - e.startAt));
    const c = this.ctx;
    const crate = this.a.img(this.a.manifest.room.crate), rubble = this.a.img(this.a.manifest.room.rubble);
    const bx = pos.x + 260 * pos.k, floor = pos.y;
    if (u < 0.4 && crate && e.type === "gift-delivery") {
      const yy = reduced ? floor - 200 * pos.k : -220 + (floor - 200 * pos.k + 220) * ease(u / 0.3);
      c.drawImage(crate, bx - 110 * pos.k, yy, 220 * pos.k, 200 * pos.k);
      if (e.quantity && e.quantity > 1) this.text(`x${e.quantity}`, bx, yy - 10, 54 * Math.max(pos.k, 0.6), GOLD, "center");
    } else if (u >= 0.4 && rubble) {
      c.save();
      c.globalAlpha = 1 - clamp01((u - 0.8) / 0.2);
      c.drawImage(rubble, bx - 130 * pos.k, floor - 120 * pos.k, 260 * pos.k, 120 * pos.k);
      c.restore();
    }
  }

  private snack(e: Effect, t: number, pos: { x: number; y: number; k: number }): void {
    const im = this.a.img(this.a.manifest.room.snack);
    if (!im) return;
    const u = clamp01((t - e.startAt) / (e.endAt - e.startAt));
    const x = pos.x - 380 * pos.k + 380 * pos.k * u, y = pos.y - 420 * pos.k - Math.sin(Math.PI * u) * 120 * pos.k;
    this.ctx.save();
    this.ctx.globalAlpha = 1 - clamp01((u - 0.8) / 0.2);
    this.ctx.drawImage(im, x - 60 * pos.k, y, 120 * pos.k, 90 * pos.k);
    this.ctx.restore();
    if ((e.quantity ?? 0) > 1) this.text(`x${e.quantity} snacks`, pos.x, pos.y - 560 * pos.k, 34 * Math.max(pos.k, 0.7), GOLD, "center");
  }

  // ------------------------------------------------------------------ HUDs
  private introHud(s: Snapshot, t: number): void {
    this.text("STARTING SOON", 960, 130, 92, GREEN, "center");
    this.text(fmtClock(s.countdown.remainingMs), 960, 270, 150, WHITE, "center");
    if (!s.awake) {
      this.meter(510, 900, 900, 54, s.meters.wake / s.thresholds.wake, `Wake Hulk up: type ${s.commandNames.wake}`, `${s.meters.wake}/${s.thresholds.wake}`);
    } else {
      this.text("HULK IS AWAKE!", 960, 960, 64, GOLD, "center");
    }
    this.text(s.prompt, 960, 1048, 30, WHITE, "center", true);
    void t;
  }

  private liveHud(s: Snapshot, t: number, light: Effect[]): void {
    this.meter(1500, 712, 360, 26, s.meters.flex / s.thresholds.flex, `${s.commandNames.flex}`, "", 26);
    const act = light.find((e) => e.type === "activity");
    if (act?.quantity) this.floatCount(act, t, 1840, 700, 32);
  }

  private brbHud(s: Snapshot, t: number, light: Effect[]): void {
    this.text("BE RIGHT BACK", 60, 100, 76, GREEN, "left");
    this.text(s.prompt, 60, 150, 30, WHITE, "left", true);
    this.meter(60, 900, 620, 44, s.meters.flex / s.thresholds.flex, `Flex: ${s.commandNames.flex}`, `${s.meters.flex}/${s.thresholds.flex}`);
    this.meter(60, 990, 620, 44, s.meters.smash / s.thresholds.smash, `Smash: ${s.commandNames.smash}`, `${s.meters.smash}/${s.thresholds.smash}`);
    for (const e of light) {
      if (e.type !== "activity" || !e.quantity) continue;
      const y = e.command === "smash" ? 990 : e.command === "flex" ? 900 : 0;
      if (y) this.floatCount(e, t, 720, y, 40);
    }
    // vote panel
    const pulse = light.some((e) => e.type === "vote-update");
    const x = 1380, y = 430, w = 480;
    const h = 90 + s.voteOptions.length * 58;
    this.panel(x, y, w, h, pulse ? GOLD : "rgba(143,227,106,0.6)");
    this.text(`Pick Hulk's prop: ${s.commandNames.vote} <name>`, x + 24, y + 52, 28, WHITE, "left");
    s.voteOptions.forEach((o, i) => {
      const yy = y + 100 + i * 58;
      const lead = o.id === s.activeProp;
      this.text(`${o.label}`, x + 24, yy, 32, lead ? GOLD : WHITE, "left", true);
      this.text(`${s.votes[o.id] ?? 0}`, x + w - 24, yy, 32, lead ? GOLD : WHITE, "right");
    });
    this.text(`${s.commandNames.feed}   ${s.commandNames.flex}   ${s.commandNames.smash}   ${s.commandNames.vote}   ${s.commandNames.hulk}`, 1860, 1048, 30, WHITE, "right", true);
    this.supportStrip(s, 1380, 360);
  }

  private outroHud(s: Snapshot, t: number): void {
    this.text("THANKS FOR WATCHING", 960, 120, 84, GREEN, "center");
    this.text(`Stream ending in ${fmtClock(s.countdown.remainingMs)}`, 960, 200, 56, WHITE, "center");
    const names = s.supporters.slice(0, 8);
    if (names.length) {
      this.panel(60, 390, 520, 90 + names.length * 52, "rgba(255,210,63,0.7)");
      this.text("Tonight's supporters", 84, 442, 34, GOLD, "left");
      names.forEach((p, i) => this.text(`${p.name}${p.kind === "gift" && p.quantity ? ` (${p.quantity} gifts)` : p.kind === "resub" ? " (welcome back)" : ""}`, 84, 500 + i * 52, 32, WHITE, "left", true));
    }
    this.text("Hulk is tidying up for bed...", 960, 1048, 30, WHITE, "center", true);
    void t;
  }

  private endCard(): void {
    const c = this.ctx;
    c.fillStyle = "rgba(4,7,3,0.55)";
    c.fillRect(0, 0, W, H);
    this.text("That's all for today", 960, 200, 88, GREEN, "center");
    this.text("Hulk is asleep. See you next stream!", 960, 280, 44, WHITE, "center", true);
  }

  private supportStrip(s: Snapshot, x: number, y: number): void {
    const units = s.room.supportUnits, next = s.room.nextMilestoneAt;
    this.text(`Room upgrades: ${s.room.unlocks.length}   Next at ${next} support`, x, y, 26, GOLD, "left");
    this.text(`Support so far: ${units}`, x, y + 34, 26, WHITE, "left", true);
  }

  private help(s: Snapshot, e: Effect, t: number, live: boolean): void {
    const u = clamp01((t - e.startAt) / 400) * (1 - clamp01((t - (e.endAt - 400)) / 400));
    const c = this.ctx;
    c.save();
    c.globalAlpha = u;
    const n = s.commandNames;
    const lines = [`${n.wake}  wake him up (before the stream)`, `${n.feed}  give him a snack`, `${n.flex}  power the community flex`,
      `${n.smash}  charge the smash (break time)`, `${n.vote} <prop>  pick his accessory`];
    const x = live ? 1130 : 760, y = live ? 430 : 360, w = live ? 600 : 760;
    this.panel(x, y, w, 80 + lines.length * 46, GREEN);
    this.text("How to play", x + 24, y + 50, 34, GREEN, "left");
    lines.forEach((l, i) => this.text(l, x + 24, y + 100 + i * 46, live ? 26 : 30, WHITE, "left", true));
    c.restore();
  }

  // ------------------------------------------------------------------ celebrations
  private banner(e: Effect, t: number, mode: Snapshot["mode"], reduced: boolean): void {
    const live = mode === "LIVE";
    const dur = e.endAt - e.startAt;
    const inU = ease((t - e.startAt) / 350), outU = ease((e.endAt - t) / 350);
    const vis = Math.min(inU, outU);
    const name = e.names[0] ?? "";
    let title = "", sub = "";
    switch (e.type) {
      case "new-sub": title = "GAMMA FLEX!"; sub = `${name} just subscribed`; break;
      case "welcome-back": title = "WELCOME BACK!"; sub = e.months ? `${name}: ${e.months} months` : name; break;
      case "gift-delivery": title = "SUPPLY DROP!"; sub = `${name} gifted ${e.quantity ?? 1} sub${(e.quantity ?? 1) === 1 ? "" : "s"}`; break;
      case "summary": {
        title = "THANK YOU, SUPPORTERS!";
        const more = Math.max(0, (e.quantity ?? 0) - e.names.length);
        sub = e.names.join(", ") + (more ? ` and ${more} more` : "");
        break;
      }
      case "wake-up": title = "HULK IS AWAKE!"; sub = "Chat woke him up"; break;
      case "big-flex": title = "COMMUNITY FLEX!"; sub = "Chat filled the flex meter"; break;
      case "community-smash": title = "COMMUNITY SMASH!"; sub = "Chat filled the smash meter"; break;
    }
    const c = this.ctx;
    const w = live ? 720 : 1160, h = live ? 150 : 190;
    const x = live ? W - w - 30 : (W - w) / 2;
    // Placed so it never covers a scene's title or countdown.
    const y0 = live ? 540 : mode === "BRB" ? 190 : 560;
    const y = reduced ? y0 : y0 - (1 - vis) * 60;
    c.save();
    c.globalAlpha = reduced ? vis : Math.max(vis, 0.001);
    this.panel(x, y, w, h, GOLD);
    this.text(title, x + w / 2, y + (live ? 64 : 84), live ? 50 : 70, GOLD, "center");
    this.text(sub, x + w / 2, y + (live ? 118 : 150), live ? 32 : 42, WHITE, "center", true);
    // milestone unlock folded into the celebration
    if (e.decoration && (t - e.startAt) > dur * 0.45) {
      const im = this.a.img(this.a.manifest.decorations[e.decoration] ?? this.a.manifest.fallbackDecoration);
      const names = (e.label ?? e.decoration).split(",").filter(Boolean);
      this.panel(x + w / 2 - 330, y + h + 16, 660, 96, GREEN);
      if (im) c.drawImage(im, x + w / 2 - 316, y + h + 22, 84, 84);
      this.text(names.length > 1 ? `${names.length} room upgrades unlocked!` : `Room upgrade: ${decoName(names[0])}`, x + w / 2 + 40, y + h + 78, 34, GREEN, "center", true);
    }
    c.restore();
  }

  private floatCount(e: Effect, t: number, x: number, y: number, size: number): void {
    const u = clamp01((t - e.startAt) / (e.endAt - e.startAt));
    this.ctx.save();
    this.ctx.globalAlpha = 1 - u;
    this.text(`+${e.quantity}`, x, y - u * 40, size, GOLD, "left");
    this.ctx.restore();
  }

  // ------------------------------------------------------------------ primitives
  private meter(x: number, y: number, w: number, h: number, frac: number, label: string, value: string, size = 32): void {
    const c = this.ctx;
    c.save();
    c.fillStyle = "rgba(8,12,6,0.75)";
    this.roundRect(x, y, w, h, h / 2); c.fill();
    c.fillStyle = GREEN;
    if (frac > 0) { this.roundRect(x + 4, y + 4, Math.max(h - 8, (w - 8) * clamp01(frac)), h - 8, (h - 8) / 2); c.fill(); }
    c.restore();
    this.text(label, x + 20, y - 12, size, WHITE, "left", true);
    if (value) this.text(value, x + w - 16, y - 12, size, WHITE, "right", true);
  }

  private panel(x: number, y: number, w: number, h: number, border: string): void {
    const c = this.ctx;
    c.save();
    c.fillStyle = "rgba(10,16,8,0.86)";
    this.roundRect(x, y, w, h, 22); c.fill();
    c.lineWidth = 5; c.strokeStyle = border; c.stroke();
    c.restore();
  }

  private chip(label: string, x: number, y: number, bg: string): void {
    const c = this.ctx;
    c.save();
    c.font = `700 26px ${BODY}`;
    const w = c.measureText(label).width + 40;
    c.fillStyle = bg; this.roundRect(x, y - 34, w, 46, 23); c.fill();
    c.restore();
    this.text(label, x + 20, y - 2, 26, WHITE, "left", true);
  }

  /** Text is always drawn with fillText, so a username can never become markup or script. */
  private text(s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign, body = false): void {
    const c = this.ctx;
    c.save();
    c.font = `${body ? "700" : "900"} ${size}px ${body ? BODY : FONT}`;
    c.textAlign = align;
    c.lineJoin = "round";
    c.lineWidth = Math.max(4, size / 7);
    c.strokeStyle = INK;
    c.strokeText(s, x, y);
    c.fillStyle = color;
    c.fillText(s, x, y);
    c.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
  }
}
