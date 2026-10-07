// Isolated demo: synthetic events go to a separate in-memory engine, never to the live session.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../web/ui.css";
import { post } from "../web/conn.js";
import { Controls, Progress, useFeed } from "../dashboard/main.js";

function Demo() {
  const feed = useFeed("demo");
  const [qty, setQty] = useState(5);
  const [months, setMonths] = useState(6);
  const [vote, setVote] = useState("hat");
  const [name, setName] = useState("");
  const [last, setLast] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const send = async (kind: string, extra: Record<string, unknown> = {}) => {
    const repeatId = `demo-fixed:${Date.now()}`;
    const r = await post("/api/demo/event", { kind, name: name || undefined, quantity: qty, months, repeatId, ...extra });
    setLast(repeatId);
    setResult(r.accepted ? `${kind}: accepted` : `${kind}: rejected (${String(r.reason)})`);
    return repeatId;
  };
  const resend = async () => {
    if (!last) return;
    const r = await post("/api/demo/event", { kind: "GIFT_BATCH", quantity: qty, repeatId: last });
    setResult(r.accepted ? "duplicate accepted (bug!)" : `duplicate ignored (${String(r.reason)})`);
  };
  const cmd = (command: string, arg?: string) => send("CHAT_COMMAND", { command, arg, userId: `demo-${Math.random().toString(36).slice(2, 8)}` });
  return (
    <>
      <div className="banner">DEMO SESSION: synthetic events only. Nothing here touches live totals, room upgrades or Twitch.</div>
      <div className="grid">
        <div className="card">
          <h2>Overlay preview</h2>
          <iframe src="/overlay?session=demo&bg=room" title="demo overlay" />
          <p className="muted">OBS uses <span className="mono">/overlay</span> (live). This preview is <span className="mono">/overlay?session=demo</span>.</p>
        </div>
        <div className="card">
          <h2>Synthetic chat</h2>
          <div className="row">
            {["wake", "feed", "flex", "smash", "hulk"].map((c) => <button key={c} onClick={() => cmd(c)}>!{c}</button>)}
            <input value={vote} onChange={(e) => setVote(e.target.value)} style={{ width: 90 }} />
            <button onClick={() => cmd("vote", vote)}>!vote</button>
          </div>
          <h2 style={{ marginTop: 14 }}>Synthetic support</h2>
          <div className="row"><label>Name <input value={name} placeholder="random" onChange={(e) => setName(e.target.value)} /></label></div>
          <div className="row">
            <button onClick={() => send("NEW_SUB")}>New sub</button>
            <label>months <input type="number" value={months} onChange={(e) => setMonths(Number(e.target.value))} /></label>
            <button onClick={() => send("RESUB_MESSAGE")}>Resub message</button>
          </div>
          <div className="row">
            <label>gifts <input type="number" value={qty} min={1} max={1000} onChange={(e) => setQty(Number(e.target.value))} /></label>
            <button onClick={() => send("GIFT_BATCH")}>Gift batch</button>
            <button onClick={() => send("ANON_GIFT")}>Anonymous gift batch</button>
            <button onClick={resend} disabled={!last}>Re-deliver last event (duplicate test)</button>
          </div>
          <div className="row">
            <button onClick={() => post("/api/demo/burst", { perSecond: 100, seconds: 60 })}>Burst: 100 commands/s for 60 s</button>
          </div>
          <p className="muted">{result}</p>
        </div>
        <Controls session="demo" feed={feed} />
        <Progress session="demo" feed={feed} />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Demo /></StrictMode>);
