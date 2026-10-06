// Streamer dashboard: scene and timer controls, Twitch status, settings, progress and the observed session summary.
// Every value rendered here is plain React text (escaped); nothing is injected as HTML.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../web/ui.css";
import { connect, fmtClock, pageToken, post, type Feed } from "../web/conn.js";
import { SELECTABLE_MODES, type Mode, type Settings, type SessionKind } from "../shared/types.js";
import { decoName } from "../overlay/renderer.js";

export function useFeed(session: SessionKind): Feed {
  const [, force] = useState(0);
  const [feed] = useState(() => connect(session, "dashboard", () => force((n) => n + 1), pageToken()));
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500); // countdown display
    return () => clearInterval(id);
  }, []);
  return feed;
}

export function Controls({ session, feed }: { session: SessionKind; feed: Feed }) {
  const s = feed.snapshot;
  const [dur, setDur] = useState<Record<string, number>>({});
  if (!s) return <div className="card">Connecting...</div>;
  const act = (body: Record<string, unknown>) => post(`/api/${session}/action`, body);
  const remaining = s.countdown.endsAt !== null ? s.countdown.endsAt - (Date.now() + feed.offset) : s.countdown.remainingMs;
  const settings = feed.dashboard?.settings;
  const defaultDur = (m: Mode) => settings ? (m === "INTRO" ? settings.countdowns.introSec : m === "OUTRO" ? settings.countdowns.outroSec : m === "BRB" ? settings.countdowns.brbSec : 0) : 0;
  return (
    <div className="card">
      <h2>Scene</h2>
      <div className="row">
        <span className="clock">{s.mode}</span>
        {s.countdown.endsAt !== null || s.countdown.remainingMs !== null ? <span className="clock muted">{fmtClock(remaining)}</span> : null}
        {s.paused && <span className="pill warn">Paused</span>}
        {s.stopped && <span className="pill bad">Stopped</span>}
      </div>
      {SELECTABLE_MODES.map((m) => (
        <div className="row" key={m}>
          <button className={s.mode === m ? "on" : ""} style={{ minWidth: 90 }} onClick={() => act({ action: "setMode", mode: m, durationSec: m === "LIVE" ? 0 : dur[m] ?? defaultDur(m) })}>{m}</button>
          {m !== "LIVE" && (
            <label>countdown (s) <input type="number" min={0} value={dur[m] ?? defaultDur(m)} onChange={(e) => setDur({ ...dur, [m]: Number(e.target.value) })} /></label>
          )}
          <span className="muted">{m === "INTRO" ? "sleeping Hulk, wake meter" : m === "LIVE" ? "small companion" : m === "BRB" ? "full room, all commands" : "goodnight, then a quiet end card"}</span>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => act({ action: "start", mode: "INTRO" })}>Start session (intro)</button>
        <button onClick={() => act({ action: "pause" })}>Pause</button>
        <button onClick={() => act({ action: "resume" })}>Resume</button>
        <button onClick={() => { if (confirm("End the session? Room upgrades are kept.")) void act({ action: "endSession" }); }}>End session</button>
      </div>
      <div className="row">
        <button className="danger big" onClick={() => act({ action: "emergencyStop" })}>EMERGENCY STOP</button>
        <span className="muted">Stops every effect and blocks commands until Resume.</span>
      </div>
      <div className="row">
        <button onClick={() => act({ action: "clearQueue" })}>Clear animation queue ({feed.dashboard?.queueLength ?? 0})</button>
        <button onClick={() => act({ action: "resetVotes" })}>New prop vote</button>
      </div>
    </div>
  );
}

function Twitch({ feed }: { feed: Feed }) {
  const t = feed.dashboard?.twitch;
  if (!t) return null;
  const cls = t.state === "connected" ? "ok" : t.state === "error" || t.state === "not-configured" ? "bad" : "warn";
  return (
    <div className="card">
      <h2>Twitch</h2>
      <div className="row"><span className={`pill ${cls}`}>{t.state}</span>{t.account && <b>{t.account.login}</b>}{t.chatOnly && <span className="pill warn">chat only</span>}</div>
      {t.lastError && <p className="muted">{t.lastError}</p>}
      {!t.configured && <p>Add <span className="mono">TWITCH_CLIENT_ID</span> and <span className="mono">TWITCH_CLIENT_SECRET</span> to <span className="mono">.env</span> and restart. The demo works without them.</p>}
      {t.configured && (
        <>
          <p className="muted">OAuth redirect URL to register in the Twitch console: <span className="mono">{t.redirectUri}</span></p>
          <div className="row">
            <a href={`/auth/login?token=${encodeURIComponent(pageToken())}`}><button>{t.account ? "Sign in again" : "Sign in with Twitch"}</button></a>
            <button onClick={() => post("/api/twitch/reconnect", {})}>Reconnect</button>
            {t.account && <button onClick={() => post("/api/twitch/logout", {})}>Sign out</button>}
          </div>
          {t.missingScopes.length > 0 && <p className="pill bad">Missing permissions: {t.missingScopes.join(", ")}. Sign in again.</p>}
          {t.subscriptions.length > 0 && (
            <table><thead><tr><th>Event</th><th>Status</th></tr></thead><tbody>
              {t.subscriptions.map((x) => <tr key={x.type}><td className="mono">{x.type}</td><td>{x.status}</td></tr>)}
            </tbody></table>
          )}
          {t.gaps.length > 0 && <p className="muted">Connection gaps (events in a gap are not replayed): {t.gaps.map((g) => `${new Date(g.from).toLocaleTimeString()}–${g.to ? new Date(g.to).toLocaleTimeString() : "now"}`).join(", ")}</p>}
        </>
      )}
    </div>
  );
}

function SettingsCard({ session, feed }: { session: SessionKind; feed: Feed }) {
  const cur = feed.dashboard?.settings;
  const [draft, setDraft] = useState<Settings | null>(null);
  const [msg, setMsg] = useState("");
  const s = draft ?? cur;
  if (!s) return null;
  const set = (fn: (d: Settings) => void) => { const d = structuredClone(s); fn(d); setDraft(d); };
  const save = async () => {
    const r = await post(`/api/${session}/action`, { action: "updateSettings", settings: s });
    setMsg(r.error ? `Not saved: ${String(r.error).slice(0, 200)}` : "Saved.");
    if (!r.error) setDraft(null);
  };
  return (
    <div className="card">
      <h2>Settings</h2>
      <table><thead><tr><th>Command</th><th>Text</th><th>Cooldown (s)</th><th>Energy</th><th>On</th></tr></thead><tbody>
        {(Object.keys(s.commands) as (keyof Settings["commands"])[]).map((k) => (
          <tr key={k}>
            <td>{k}</td>
            <td><input value={s.commands[k].name} onChange={(e) => set((d) => { d.commands[k].name = e.target.value; })} style={{ width: 100 }} /></td>
            <td><input type="number" value={s.commands[k].cooldownSec} onChange={(e) => set((d) => { d.commands[k].cooldownSec = Number(e.target.value); })} /></td>
            <td>{["wake", "flex", "smash"].includes(k) ? <input type="number" value={s.commands[k].amount} onChange={(e) => set((d) => { d.commands[k].amount = Number(e.target.value); })} /> : <span className="muted">-</span>}</td>
            <td><input type="checkbox" checked={s.commands[k].enabled} onChange={(e) => set((d) => { d.commands[k].enabled = e.target.checked; })} /></td>
          </tr>
        ))}
      </tbody></table>
      <div className="row">
        {(["wake", "flex", "smash"] as const).map((k) => <label key={k}>{k} threshold <input type="number" value={s.thresholds[k]} onChange={(e) => set((d) => { d.thresholds[k] = Number(e.target.value); })} /></label>)}
      </div>
      <div className="row">
        <label>Support milestone every <input type="number" value={s.milestoneSize} onChange={(e) => set((d) => { d.milestoneSize = Number(e.target.value); })} /> units</label>
      </div>
      <div className="row">
        <label>Intro (s) <input type="number" value={s.countdowns.introSec} onChange={(e) => set((d) => { d.countdowns.introSec = Number(e.target.value); })} /></label>
        <label>Outro (s) <input type="number" value={s.countdowns.outroSec} onChange={(e) => set((d) => { d.countdowns.outroSec = Number(e.target.value); })} /></label>
        <label>BRB (s, 0 = none) <input type="number" value={s.countdowns.brbSec} onChange={(e) => set((d) => { d.countdowns.brbSec = Number(e.target.value); })} /></label>
      </div>
      <div className="row">
        <label>Volume <input type="range" min={0} max={1} step={0.05} value={s.sound.volume} onChange={(e) => set((d) => { d.sound.volume = Number(e.target.value); })} /></label>
        <label><input type="checkbox" checked={s.sound.muted} onChange={(e) => set((d) => { d.sound.muted = e.target.checked; })} /> Mute</label>
        <label><input type="checkbox" checked={s.reducedMotion} onChange={(e) => set((d) => { d.reducedMotion = e.target.checked; })} /> Reduced motion</label>
      </div>
      <div className="row">
        <label><input type="checkbox" checked={s.chatReplies.enabled} onChange={(e) => set((d) => { d.chatReplies.enabled = e.target.checked; })} /> Reply to !hulk in chat (needs sign-in with the chat-write permission)</label>
        <label>at most every <input type="number" value={s.chatReplies.minIntervalSec} onChange={(e) => set((d) => { d.chatReplies.minIntervalSec = Number(e.target.value); })} /> s</label>
      </div>
      <div className="row">
        <label>Vote options </label>
        {s.voteOptions.map((o, i) => <input key={o.id} value={o.label} style={{ width: 130 }} onChange={(e) => set((d) => { d.voteOptions[i].label = e.target.value; })} title={`id: ${o.id}`} />)}
      </div>
      <div className="row"><label>Prompt <input value={s.prompt} style={{ width: 420 }} onChange={(e) => set((d) => { d.prompt = e.target.value; })} /></label></div>
      <div className="row"><button className="on" onClick={save} disabled={!draft}>Save settings</button>{draft && <button onClick={() => setDraft(null)}>Discard</button>}<span className="muted">{msg}</span></div>
    </div>
  );
}

export function Progress({ session, feed }: { session: SessionKind; feed: Feed }) {
  const s = feed.snapshot, st = feed.dashboard?.stats;
  if (!s) return null;
  const reset = () => {
    const typed = prompt("This permanently removes every room upgrade and support unit. Type RESET to confirm.");
    if (typed === "RESET") void post(`/api/${session}/action`, { action: "resetProgress", confirm: "RESET" });
  };
  return (
    <div className="card">
      <h2>Room progress (permanent)</h2>
      <p>Support units: <b>{s.room.supportUnits}</b> · upgrades: <b>{s.room.unlocks.length}</b> · next at <b>{s.room.nextMilestoneAt}</b></p>
      <p className="muted">{s.room.unlocks.map(decoName).join(", ") || "No upgrades yet."}</p>
      <button className="danger" onClick={reset}>Reset permanent progress...</button>
      {st && (
        <>
          <h2 style={{ marginTop: 18 }}>This session (observed)</h2>
          <p>Unique command participants: <b>{st.uniqueParticipants}</b> · rejected (cooldown, wrong scene...): {st.rejected}</p>
          <table><thead><tr><th>Mode</th><th>Commands</th><th>People</th><th>New subs</th><th>Gift batches (units)</th><th>Resub messages</th></tr></thead><tbody>
            {Object.entries(st.perMode).map(([m, v]) => v && (
              <tr key={m}><td>{m}</td><td>{v.accepted}</td><td>{v.participants}</td><td>{v.newSubs}</td><td>{v.giftBatches} ({v.giftedUnits})</td><td>{v.resubMessages}</td></tr>
            ))}
          </tbody></table>
          <p className="muted">Observed during this session only. Resub messages are acknowledgements, not a count of renewals. Use these to compare sessions; they don't prove that the overlay caused any subscription.</p>
        </>
      )}
    </div>
  );
}

function Dashboard() {
  const feed = useFeed("live");
  const obsUrl = `${location.origin}/overlay`;
  return (
    <>
      <div className="top">
        <h1>Hulk's Hangout</h1>
        <span className={`pill ${feed.connected ? "ok" : "bad"}`}>{feed.connected ? "server connected" : "server offline"}</span>
        <span className="pill ok">LIVE session</span>
        <span className="muted">OBS browser source (1920x1080): <span className="mono">{obsUrl}</span></span>
        <button onClick={() => navigator.clipboard?.writeText(obsUrl)}>Copy</button>
        <a href="/demo" target="_blank" rel="noreferrer"><button>Open isolated demo / effect preview</button></a>
      </div>
      <div className="grid">
        <Controls session="live" feed={feed} />
        <Twitch feed={feed} />
        <Progress session="live" feed={feed} />
        <SettingsCard session="live" feed={feed} />
      </div>
    </>
  );
}

if (document.getElementById("root") && location.pathname.startsWith("/dashboard")) {
  createRoot(document.getElementById("root")!).render(<StrictMode><Dashboard /></StrictMode>);
}
