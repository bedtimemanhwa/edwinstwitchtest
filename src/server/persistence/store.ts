// SQLite persistence (node:sqlite, no native build step).
// The important rule lives in applyReward(): the processed-event ledger insert, the room update,
// the celebration outbox rows and the session snapshot commit in ONE transaction. A duplicate
// EventSub message id makes the whole thing a no-op, before or after a restart.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Settings, defaultSettings, type Effect } from "../../shared/types.js";

export interface RoomRow { supportUnits: number; unlocks: string[]; milestonesAwarded: number }

const MIGRATIONS: string[] = [
  // 1: core tables
  `CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
   CREATE TABLE room (id INTEGER PRIMARY KEY CHECK (id = 1), support_units INTEGER NOT NULL, unlocks TEXT NOT NULL, milestones_awarded INTEGER NOT NULL);
   CREATE TABLE processed_events (message_id TEXT PRIMARY KEY, kind TEXT NOT NULL, received_at INTEGER NOT NULL);
   CREATE TABLE session_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, saved_at INTEGER NOT NULL);
   CREATE TABLE effects (id TEXT PRIMARY KEY, json TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL);
   CREATE INDEX effects_end ON effects(end_at);
   INSERT INTO room VALUES (1, 0, '[]', 0);`,
  // 2: observed-session metrics (user ids only, no chat text)
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER);
   CREATE TABLE session_metrics (session_id TEXT NOT NULL, mode TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, quantity INTEGER NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX metrics_session ON session_metrics(session_id, mode, kind);`,
];

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    let v = row?.version ?? 0;
    if (!row) this.db.exec("INSERT INTO schema_version VALUES (0)");
    for (; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.prepare("UPDATE schema_version SET version = ?").run(v + 1);
      });
    }
  }

  /** Run fn in a transaction (nested calls join the outer one). */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ------------------------------------------------------------ settings
  loadSettings(): Settings {
    const row = this.db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string } | undefined;
    if (!row) return defaultSettings();
    const parsed = Settings.safeParse(JSON.parse(row.json));
    return parsed.success ? parsed.data : defaultSettings();
  }
  saveSettings(s: Settings): void {
    this.db.prepare("INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(JSON.stringify(s));
  }

  // ------------------------------------------------------------ room (permanent progress)
  loadRoom(): RoomRow {
    const r = this.db.prepare("SELECT support_units, unlocks, milestones_awarded FROM room WHERE id = 1").get() as
      { support_units: number; unlocks: string; milestones_awarded: number };
    return { supportUnits: r.support_units, unlocks: JSON.parse(r.unlocks), milestonesAwarded: r.milestones_awarded };
  }
  private saveRoom(room: RoomRow): void {
    this.db.prepare("UPDATE room SET support_units = ?, unlocks = ?, milestones_awarded = ? WHERE id = 1")
      .run(room.supportUnits, JSON.stringify(room.unlocks), room.milestonesAwarded);
  }
  resetRoom(): void {
    this.tx(() => this.saveRoom({ supportUnits: 0, unlocks: [], milestonesAwarded: 0 }));
  }

  // ------------------------------------------------------------ the exactly-once reward transaction
  hasProcessed(messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed_events WHERE message_id = ?").get(messageId);
  }

  /**
   * Record a reward event and everything it changes, atomically.
   * Returns false (and changes nothing) when this message id was already processed.
   */
  applyReward(args: {
    messageId: string; kind: string; at: number; room: RoomRow; effects: Effect[]; sessionJson: string;
    metric: { sessionId: string; mode: string; kind: string; userId: string | null; quantity: number };
  }): boolean {
    return this.tx(() => {
      const ins = this.db.prepare("INSERT INTO processed_events (message_id, kind, received_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING")
        .run(args.messageId, args.kind, args.at);
      if (Number(ins.changes) === 0) return false;
      this.saveRoom(args.room);
      const put = this.db.prepare("INSERT OR REPLACE INTO effects (id, json, start_at, end_at) VALUES (?, ?, ?, ?)");
      for (const e of args.effects) put.run(e.id, JSON.stringify(e), e.startAt, e.endAt);
      this.saveSessionInner(args.sessionJson, args.at);
      this.addMetricInner(args.metric, args.at);
      return true;
    });
  }

  // ------------------------------------------------------------ effects outbox
  loadPendingEffects(now: number): Effect[] {
    const rows = this.db.prepare("SELECT json FROM effects WHERE end_at > ? ORDER BY start_at").all(now) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Effect);
  }
  replaceEffects(effects: Effect[]): void {
    this.tx(() => {
      this.db.exec("DELETE FROM effects");
      const put = this.db.prepare("INSERT INTO effects (id, json, start_at, end_at) VALUES (?, ?, ?, ?)");
      for (const e of effects) put.run(e.id, JSON.stringify(e), e.startAt, e.endAt);
    });
  }
  pruneEffects(now: number): void {
    this.db.prepare("DELETE FROM effects WHERE end_at <= ?").run(now);
  }

  // ------------------------------------------------------------ session snapshot
  loadSession(): string | null {
    const r = this.db.prepare("SELECT json FROM session_state WHERE id = 1").get() as { json: string } | undefined;
    return r?.json ?? null;
  }
  saveSession(json: string, at: number): void {
    this.tx(() => this.saveSessionInner(json, at));
  }
  private saveSessionInner(json: string, at: number): void {
    this.db.prepare("INSERT INTO session_state (id, json, saved_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at")
      .run(json, at);
  }

  // ------------------------------------------------------------ metrics
  startSession(id: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO sessions (id, started_at) VALUES (?, ?)").run(id, at);
  }
  endSession(id: string, at: number): void {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(at, id);
  }
  addMetric(m: { sessionId: string; mode: string; kind: string; userId: string | null; quantity: number }, at: number): void {
    this.addMetricInner(m, at);
  }
  private addMetricInner(m: { sessionId: string; mode: string; kind: string; userId: string | null; quantity: number }, at: number): void {
    this.db.prepare("INSERT INTO session_metrics (session_id, mode, kind, user_id, quantity, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(m.sessionId, m.mode, m.kind, m.userId, m.quantity, at);
  }
  /** Per-mode summary of one observed session. */
  sessionSummary(sessionId: string): { mode: string; kind: string; n: number; qty: number; users: number }[] {
    return this.db.prepare(
      "SELECT mode, kind, COUNT(*) AS n, SUM(quantity) AS qty, COUNT(DISTINCT user_id) AS users FROM session_metrics WHERE session_id = ? GROUP BY mode, kind",
    ).all(sessionId) as { mode: string; kind: string; n: number; qty: number; users: number }[];
  }
  uniqueParticipants(sessionId: string): number {
    const r = this.db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM session_metrics WHERE session_id = ? AND kind = 'command'").get(sessionId) as { n: number };
    return r.n;
  }

  /** Keep the ledger bounded: EventSub only redelivers recent messages. */
  pruneProcessed(olderThan: number): void {
    this.db.prepare("DELETE FROM processed_events WHERE received_at < ?").run(olderThan);
  }

  close(): void {
    this.db.close();
  }
}
