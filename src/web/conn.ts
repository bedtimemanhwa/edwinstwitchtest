// Browser-side WebSocket connection to the local server, with automatic reconnect.
import type { DashboardInfo, ServerMessage, SessionKind, Snapshot } from "../shared/types.js";

export interface Feed {
  snapshot: Snapshot | null;
  dashboard: DashboardInfo | null;
  /** Server clock minus local clock, so countdowns and effects line up across machines and reloads. */
  offset: number;
  connected: boolean;
}

export function connect(session: SessionKind, role: "overlay" | "dashboard", onUpdate: (f: Feed) => void, token?: string): Feed {
  const feed: Feed = { snapshot: null, dashboard: null, offset: 0, connected: false };
  let delay = 500;
  const open = () => {
    const q = new URLSearchParams({ session, role, ...(token ? { token } : {}) });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${q}`);
    ws.onopen = () => { feed.connected = true; delay = 500; onUpdate(feed); };
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as ServerMessage;
      if (msg.t !== "snapshot") return;
      feed.snapshot = msg.snapshot;
      feed.offset = msg.snapshot.serverNow - Date.now();
      if (msg.dashboard) feed.dashboard = msg.dashboard;
      onUpdate(feed);
    };
    ws.onclose = () => {
      feed.connected = false;
      onUpdate(feed);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();
  return feed;
}

export const pageToken = (): string => (document.querySelector('meta[name="hh-token"]') as HTMLMetaElement | null)?.content ?? "";

export async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-HH-Token": pageToken() }, body: JSON.stringify(body) });
  return (await r.json()) as Record<string, unknown>;
}

export const fmtClock = (ms: number | null): string => {
  if (ms === null) return "--:--";
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
