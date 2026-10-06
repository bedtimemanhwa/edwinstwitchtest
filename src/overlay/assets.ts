// Loads the active asset pack. Game logic never names a file: everything goes through the manifest,
// so a streamer's own Hulk art can replace the placeholders without code changes (docs/ASSETS.md).
export interface PropSpec { file: string; x: number; y: number; w: number; behind?: boolean }
export interface Manifest {
  name: string;
  character: { idle: string; sleeping: string; flex: string; width: number; height: number };
  props: Record<string, PropSpec>;
  decorations: Record<string, string>;
  fallbackDecoration: string;
  room: { background: string; crate: string; snack: string; rubble: string };
  sounds: Record<string, string>;
}

export interface Assets {
  manifest: Manifest;
  img: (file: string | undefined) => HTMLImageElement | null;
  sound: (key: string) => HTMLAudioElement | null;
}

export async function loadAssets(): Promise<Assets> {
  const manifest = (await (await fetch("/pack/manifest.json")).json()) as Manifest;
  const images = new Map<string, HTMLImageElement>();
  const sounds = new Map<string, HTMLAudioElement>();
  const files = new Set<string>([
    manifest.character.idle, manifest.character.sleeping, manifest.character.flex,
    ...Object.values(manifest.props).map((p) => p.file), ...Object.values(manifest.decorations), manifest.fallbackDecoration,
    ...Object.values(manifest.room),
  ]);
  await Promise.all([...files].map((f) => new Promise<void>((res) => {
    const im = new Image();
    im.onload = () => { images.set(f, im); res(); };
    im.onerror = () => res(); // a missing file just isn't drawn
    im.src = `/pack/files/${encodeURIComponent(f)}`;
  })));
  for (const [k, f] of Object.entries(manifest.sounds)) {
    const a = new Audio(`/pack/files/${encodeURIComponent(f)}`);
    a.preload = "auto";
    sounds.set(k, a);
  }
  return { manifest, img: (f) => (f ? images.get(f) ?? null : null), sound: (k) => sounds.get(k) ?? null };
}
