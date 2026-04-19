import Database from "better-sqlite3";

export type Receipt = {
  id: number;
  handle: string;
  text: string;
  reason: string | null;
  deadline: string | null;
  tags: string | null;
  status: "open" | "done" | "dropped" | "nudged";
  created_at: string;
  nudged_at: string | null;
  nudge_count: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  reason       TEXT,
  deadline     TEXT,
  tags         TEXT,
  status       TEXT    NOT NULL DEFAULT 'open',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  nudged_at    TEXT,
  nudge_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_receipts_due
  ON receipts(deadline, status);
CREATE INDEX IF NOT EXISTS idx_receipts_handle
  ON receipts(handle, status);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

function migrate(db: Database.Database) {
  // Add nudge_count to pre-existing DBs (idempotent).
  const cols = db.prepare(`PRAGMA table_info(receipts)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "nudge_count")) {
    db.exec(`ALTER TABLE receipts ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0`);
  }
}

export function openDb(path = process.env.RECEIPTS_DB || "./receipts.db") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export type DB = ReturnType<typeof openDb>;

export function addReceipt(
  db: DB,
  r: Pick<Receipt, "handle" | "text"> & Partial<Pick<Receipt, "reason" | "deadline" | "tags">>,
): Receipt {
  const stmt = db.prepare(
    `INSERT INTO receipts (handle, text, reason, deadline, tags)
     VALUES (@handle, @text, @reason, @deadline, @tags)
     RETURNING *`,
  );
  return stmt.get({
    handle: r.handle,
    text: r.text,
    reason: r.reason ?? null,
    deadline: r.deadline ?? null,
    tags: r.tags ?? null,
  }) as Receipt;
}

export function listOpen(db: DB, handle: string, limit = 20): Receipt[] {
  return db
    .prepare(
      `SELECT * FROM receipts
       WHERE handle = ? AND status IN ('open','nudged')
       ORDER BY COALESCE(deadline, '9999') ASC, created_at ASC
       LIMIT ?`,
    )
    .all(handle, limit) as Receipt[];
}

export function findRelevant(db: DB, handle: string, query: string, limit = 5): Receipt[] {
  const like = `%${query.toLowerCase()}%`;
  return db
    .prepare(
      `SELECT * FROM receipts
       WHERE handle = ?
         AND (LOWER(text) LIKE ? OR LOWER(COALESCE(reason,'')) LIKE ? OR LOWER(COALESCE(tags,'')) LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(handle, like, like, like, limit) as Receipt[];
}

export function updateStatus(db: DB, id: number, status: Receipt["status"]) {
  db.prepare(`UPDATE receipts SET status = ? WHERE id = ?`).run(status, id);
}

export function rescheduleReceipt(db: DB, id: number, newDeadlineIso: string | null) {
  db.prepare(
    `UPDATE receipts
     SET deadline = ?, status = 'open', nudged_at = NULL, nudge_count = 0
     WHERE id = ?`,
  ).run(newDeadlineIso, id);
}

export function markNudged(db: DB, id: number, level: number) {
  db.prepare(
    `UPDATE receipts
     SET status = 'nudged',
         nudged_at = datetime('now'),
         nudge_count = ?
     WHERE id = ?`,
  ).run(level, id);
}

export function dueReceipts(db: DB, now = new Date()): Receipt[] {
  return db
    .prepare(
      `SELECT * FROM receipts
       WHERE status = 'open'
         AND deadline IS NOT NULL
         AND deadline <= ?
       ORDER BY deadline ASC`,
    )
    .all(now.toISOString()) as Receipt[];
}

export function escalationReceipts(
  db: DB,
  step2Ms: number,
  step3Ms: number,
  now = new Date(),
): Receipt[] {
  // nudge_count=1 and nudged_at <= now-step2Ms → need level 2
  // nudge_count=2 and nudged_at <= now-step3Ms → need level 3
  const step2Cut = new Date(now.getTime() - step2Ms).toISOString();
  const step3Cut = new Date(now.getTime() - step3Ms).toISOString();
  return db
    .prepare(
      `SELECT * FROM receipts
       WHERE status = 'nudged'
         AND (
           (nudge_count = 1 AND nudged_at <= ?)
           OR
           (nudge_count = 2 AND nudged_at <= ?)
         )
       ORDER BY nudged_at ASC`,
    )
    .all(step2Cut, step3Cut) as Receipt[];
}

export type WeeklyStats = {
  kept: number;
  dropped: number;
  open: number;
  total_made: number;
};

export function weeklyStats(db: DB, handle: string, now = new Date()): WeeklyStats {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)    AS kept,
         COALESCE(SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END), 0) AS dropped,
         COALESCE(SUM(CASE WHEN status IN ('open','nudged') THEN 1 ELSE 0 END), 0) AS open,
         COUNT(*) AS total_made
       FROM receipts
       WHERE handle = ? AND created_at >= ?`,
    )
    .get(handle, weekAgo) as WeeklyStats;
  return row;
}

export function distinctHandles(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT handle FROM receipts
       WHERE status IN ('open','nudged')`,
    )
    .all() as { handle: string }[];
  return rows.map((r) => r.handle);
}

export function openForHandle(db: DB, handle: string): Receipt[] {
  return db
    .prepare(
      `SELECT * FROM receipts
       WHERE handle = ? AND status IN ('open','nudged')
       ORDER BY COALESCE(deadline, '9999') ASC, created_at ASC`,
    )
    .all(handle) as Receipt[];
}

export function kvGet(db: DB, k: string): string | null {
  const row = db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(db: DB, k: string, v: string) {
  db.prepare(
    `INSERT INTO kv (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(k, v);
}
