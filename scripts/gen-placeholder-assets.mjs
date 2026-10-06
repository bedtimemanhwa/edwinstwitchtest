// Generates the placeholder asset pack (SVG art + short synthesised WAV sounds) into public/pack/placeholder.
// Replace the whole pack with your own art: see docs/ASSETS.md. Run: npm run assets
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public/pack/placeholder");
mkdirSync(OUT, { recursive: true });
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const G = "#5fbf3a", GD = "#3d8a22", GL = "#8fe36a", P = "#6b3fa0", PD = "#4a2a72", S = "#1d2b17";

// --- character: 400x520, feet at the bottom centre
const head = (eyes) => `<ellipse cx="200" cy="105" rx="58" ry="62" fill="${G}" stroke="${S}" stroke-width="6"/>
  <path d="M146 78 Q200 30 254 78 L250 60 Q200 22 150 60Z" fill="${S}"/>${eyes}
  <path d="M176 140 Q200 152 224 140" stroke="${S}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
const openEyes = `<path d="M168 100 l22 6" stroke="${S}" stroke-width="7" stroke-linecap="round"/><path d="M232 100 l-22 6" stroke="${S}" stroke-width="7" stroke-linecap="round"/>
  <circle cx="182" cy="112" r="6" fill="${S}"/><circle cx="218" cy="112" r="6" fill="${S}"/>`;
const shutEyes = `<path d="M168 110 q14 8 28 0" stroke="${S}" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M204 110 q14 8 28 0" stroke="${S}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
const torso = `<path d="M110 190 Q200 150 290 190 L310 330 Q200 360 90 330Z" fill="${G}" stroke="${S}" stroke-width="6"/>
  <path d="M150 215 Q200 240 250 215" stroke="${GD}" stroke-width="6" fill="none"/><path d="M200 240 v70" stroke="${GD}" stroke-width="5"/>
  <path d="M96 325 Q200 352 304 325 L296 400 L210 400 L200 370 L190 400 L104 400Z" fill="${P}" stroke="${S}" stroke-width="6"/>
  <rect x="112" y="395" width="72" height="105" rx="26" fill="${G}" stroke="${S}" stroke-width="6"/><rect x="216" y="395" width="72" height="105" rx="26" fill="${G}" stroke="${S}" stroke-width="6"/>
  <ellipse cx="146" cy="505" rx="44" ry="14" fill="${GD}" stroke="${S}" stroke-width="5"/><ellipse cx="254" cy="505" rx="44" ry="14" fill="${GD}" stroke="${S}" stroke-width="5"/>`;
const armsDown = `<path d="M112 200 Q60 250 64 330" stroke="${S}" stroke-width="58" stroke-linecap="round" fill="none"/><path d="M112 200 Q60 250 64 330" stroke="${G}" stroke-width="46" stroke-linecap="round" fill="none"/>
  <path d="M288 200 Q340 250 336 330" stroke="${S}" stroke-width="58" stroke-linecap="round" fill="none"/><path d="M288 200 Q340 250 336 330" stroke="${G}" stroke-width="46" stroke-linecap="round" fill="none"/>
  <circle cx="64" cy="338" r="34" fill="${G}" stroke="${S}" stroke-width="6"/><circle cx="336" cy="338" r="34" fill="${G}" stroke="${S}" stroke-width="6"/>`;
const armsUp = `<path d="M112 205 Q40 200 50 120" stroke="${S}" stroke-width="62" stroke-linecap="round" fill="none"/><path d="M112 205 Q40 200 50 120" stroke="${G}" stroke-width="50" stroke-linecap="round" fill="none"/>
  <path d="M288 205 Q360 200 350 120" stroke="${S}" stroke-width="62" stroke-linecap="round" fill="none"/><path d="M288 205 Q360 200 350 120" stroke="${G}" stroke-width="50" stroke-linecap="round" fill="none"/>
  <circle cx="74" cy="185" r="30" fill="${GL}" opacity=".7"/><circle cx="326" cy="185" r="30" fill="${GL}" opacity=".7"/>
  <circle cx="52" cy="104" r="36" fill="${G}" stroke="${S}" stroke-width="6"/><circle cx="348" cy="104" r="36" fill="${G}" stroke="${S}" stroke-width="6"/>`;
writeFileSync(join(OUT, "hulk.svg"), svg(400, 520, armsDown + torso + head(openEyes)));
writeFileSync(join(OUT, "hulk-sleep.svg"), svg(400, 520, armsDown + torso + head(shutEyes)));
writeFileSync(join(OUT, "hulk-flex.svg"), svg(400, 520, armsUp + torso + head(openEyes)));

// --- props worn on the character (positioned by anchors in the manifest)
writeFileSync(join(OUT, "prop-hat.svg"), svg(160, 140, `<path d="M80 6 L140 128 H20Z" fill="#e94f8a" stroke="${S}" stroke-width="6"/><circle cx="80" cy="10" r="12" fill="#ffd23f"/><path d="M50 70 h60 M38 100 h84" stroke="#ffd23f" stroke-width="8"/>`));
writeFileSync(join(OUT, "prop-shades.svg"), svg(180, 60, `<rect x="6" y="10" width="72" height="40" rx="12" fill="#111"/><rect x="102" y="10" width="72" height="40" rx="12" fill="#111"/><path d="M78 24 h24" stroke="#111" stroke-width="8"/><path d="M16 18 l20 0" stroke="#fff" stroke-width="5" opacity=".6"/>`));
writeFileSync(join(OUT, "prop-cape.svg"), svg(300, 320, `<path d="M40 10 Q150 40 260 10 L290 310 Q150 270 10 310Z" fill="#c8202f" stroke="${S}" stroke-width="6"/>`));
writeFileSync(join(OUT, "prop-dumbbell.svg"), svg(260, 90, `<rect x="40" y="38" width="180" height="16" rx="8" fill="#999" stroke="${S}" stroke-width="5"/><rect x="6" y="6" width="46" height="80" rx="10" fill="#333" stroke="${S}" stroke-width="5"/><rect x="208" y="6" width="46" height="80" rx="10" fill="#333" stroke="${S}" stroke-width="5"/>`));

// --- room
writeFileSync(join(OUT, "room.svg"), svg(1920, 1080, `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25331f"/><stop offset="1" stop-color="#1a2416"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#w)"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${i * 160}" y="0" width="80" height="820" fill="#ffffff" opacity=".025"/>`).join("")}
  <rect y="820" width="1920" height="260" fill="#3a2b1f"/>${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 120}" y="820" width="4" height="260" fill="#2a1f16"/>`).join("")}
  <rect y="812" width="1920" height="14" fill="#5a4330"/><rect x="120" y="330" width="420" height="16" fill="#5a4330"/><rect x="1380" y="330" width="420" height="16" fill="#5a4330"/>
  <rect x="760" y="120" width="400" height="260" rx="10" fill="#0e140c" stroke="#5a4330" stroke-width="14"/><circle cx="960" cy="250" r="70" fill="${GD}" opacity=".35"/>`));
writeFileSync(join(OUT, "crate.svg"), svg(220, 200, `<rect x="10" y="20" width="200" height="170" rx="8" fill="#b9874b" stroke="${S}" stroke-width="7"/><path d="M10 20 L210 190 M210 20 L10 190" stroke="#8a6232" stroke-width="10"/><rect x="0" y="6" width="220" height="30" rx="6" fill="#d19d5c" stroke="${S}" stroke-width="6"/><text x="110" y="122" font-family="Arial Black,Arial" font-size="40" text-anchor="middle" fill="${S}">GIFT</text>`));
writeFileSync(join(OUT, "snack.svg"), svg(120, 90, `<path d="M10 40 Q60 -10 110 40 L100 80 H20Z" fill="#e2a24b" stroke="${S}" stroke-width="6"/><path d="M30 46 h60" stroke="#c13b2b" stroke-width="10"/><path d="M26 60 h68" stroke="${GL}" stroke-width="8"/>`));
writeFileSync(join(OUT, "rubble.svg"), svg(260, 120, `<path d="M10 110 L40 60 L80 80 L110 30 L150 70 L190 40 L250 110Z" fill="#7a6a5a" stroke="${S}" stroke-width="6"/>`));

// --- decorations (one per milestone)
const deco = {
  "gamma-trophy": `<path d="M40 20 h80 v30 q0 50 -40 60 q-40 -10 -40 -60z" fill="#ffd23f" stroke="${S}" stroke-width="6"/><rect x="62" y="110" width="36" height="20" fill="#ffd23f" stroke="${S}" stroke-width="5"/><rect x="40" y="130" width="80" height="20" rx="4" fill="${GD}" stroke="${S}" stroke-width="5"/>`,
  "neon-sign": `<rect x="6" y="30" width="148" height="80" rx="16" fill="#120b1d" stroke="${GL}" stroke-width="8"/><text x="80" y="84" font-family="Arial Black,Arial" font-size="34" text-anchor="middle" fill="${GL}">SMASH</text>`,
  "punching-bag": `<path d="M80 0 v30" stroke="#555" stroke-width="6"/><rect x="45" y="30" width="70" height="120" rx="30" fill="#b3262e" stroke="${S}" stroke-width="6"/>`,
  "green-rug": `<ellipse cx="80" cy="120" rx="76" ry="26" fill="${G}" stroke="${S}" stroke-width="6"/><ellipse cx="80" cy="120" rx="46" ry="14" fill="${GD}"/>`,
  "arcade-cabinet": `<rect x="30" y="10" width="100" height="140" rx="8" fill="${P}" stroke="${S}" stroke-width="6"/><rect x="44" y="26" width="72" height="54" fill="#0b1a0b" stroke="${S}" stroke-width="4"/><circle cx="60" cy="108" r="8" fill="#e94f8a"/><circle cx="96" cy="108" r="8" fill="#ffd23f"/>`,
  "potted-plant": `<path d="M80 90 Q40 40 60 10 Q80 50 80 90 Q100 30 120 20 Q110 70 80 90" fill="${G}" stroke="${S}" stroke-width="5"/><path d="M50 90 h60 l-10 60 h-40z" fill="#b8693a" stroke="${S}" stroke-width="6"/>`,
  "smash-banner": `<path d="M10 20 h140 v90 l-70 -24 l-70 24z" fill="${PD}" stroke="${S}" stroke-width="6"/><text x="80" y="70" font-family="Arial Black,Arial" font-size="30" text-anchor="middle" fill="#ffd23f">GAMMA</text>`,
  "giant-fridge": `<rect x="34" y="4" width="92" height="146" rx="10" fill="#dfe8e0" stroke="${S}" stroke-width="6"/><path d="M34 60 h92" stroke="${S}" stroke-width="5"/><rect x="108" y="22" width="8" height="26" fill="${S}"/><rect x="108" y="76" width="8" height="40" fill="${S}"/>`,
  "lava-lamp": `<path d="M60 20 h40 l14 100 h-68z" fill="#2a1840" stroke="${S}" stroke-width="5"/><circle cx="80" cy="60" r="12" fill="${GL}"/><circle cx="74" cy="96" r="9" fill="${GL}"/><rect x="50" y="120" width="60" height="30" rx="6" fill="#888" stroke="${S}" stroke-width="5"/>`,
  "championship-belt": `<rect x="4" y="60" width="152" height="40" rx="12" fill="#2b2b2b" stroke="${S}" stroke-width="5"/><ellipse cx="80" cy="80" rx="40" ry="34" fill="#ffd23f" stroke="${S}" stroke-width="6"/><circle cx="80" cy="80" r="14" fill="${G}"/>`,
};
for (const [k, body] of Object.entries(deco)) writeFileSync(join(OUT, `deco-${k}.svg`), svg(160, 160, body));

// --- sounds: tiny synthesised placeholders (16-bit mono 22.05 kHz)
function wav(name, seconds, fn) {
  const sr = 22050, n = Math.floor(sr * seconds), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr, v = Math.max(-1, Math.min(1, fn(t, rnd)));
    buf.writeInt16LE(Math.round(v * 0.7 * 32767), 44 + i * 2);
  }
  writeFileSync(join(OUT, name), buf);
}
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);
wav("wake.wav", 0.9, (t) => Math.sin(2 * Math.PI * (200 + 500 * t) * t) * env(t, 0.02, 0.35));
wav("snack.wav", 0.35, (t, r) => (r() * 0.6 + Math.sin(2 * Math.PI * 320 * t) * 0.4) * env(t, 0.005, 0.06) * (1 + Math.sin(2 * Math.PI * 18 * t)) / 2);
wav("flex.wav", 0.8, (t) => (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t)) * env(t, 0.05, 0.3));
wav("smash.wav", 1.0, (t, r) => (r() * Math.exp(-t * 6) * 0.8 + Math.sin(2 * Math.PI * (60 - 30 * t) * t) * Math.exp(-t * 3)));
wav("celebrate.wav", 1.2, (t) => [523, 659, 784, 1047].reduce((s, f, k) => s + (t > k * 0.12 ? Math.sin(2 * Math.PI * f * t) * Math.exp(-(t - k * 0.12) * 3) * 0.3 : 0), 0));
wav("unlock.wav", 1.0, (t) => (Math.sin(2 * Math.PI * 880 * t) + Math.sin(2 * Math.PI * 1320 * t)) * 0.4 * env(t, 0.01, 0.4));

writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
  name: "Placeholder pack (replace with the streamer's own art)",
  version: 1,
  character: { idle: "hulk.svg", sleeping: "hulk-sleep.svg", flex: "hulk-flex.svg", width: 400, height: 520 },
  props: {
    hat: { file: "prop-hat.svg", x: 0.5, y: 0.02, w: 0.36 },
    shades: { file: "prop-shades.svg", x: 0.5, y: 0.205, w: 0.42 },
    cape: { file: "prop-cape.svg", x: 0.5, y: 0.36, w: 0.7, behind: true },
    dumbbell: { file: "prop-dumbbell.svg", x: 0.15, y: 0.6, w: 0.5 },
  },
  decorations: Object.fromEntries(Object.keys(deco).map((k) => [k, `deco-${k}.svg`])),
  fallbackDecoration: "deco-gamma-trophy.svg",
  room: { background: "room.svg", crate: "crate.svg", snack: "snack.svg", rubble: "rubble.svg" },
  sounds: { wake: "wake.wav", snack: "snack.wav", flex: "flex.wav", smash: "smash.wav", celebrate: "celebrate.wav", unlock: "unlock.wav" },
}, null, 2));
console.log("placeholder pack written to", OUT);
