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
  nudged_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_due
  ON receipts(deadline, status);
CREATE INDEX IF NOT EXISTS idx_receipts_handle
  ON receipts(handle, status);
`;

export function openDb(path = process.env.RECEIPTS_DB || "./receipts.db") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
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

export function markNudged(db: DB, id: number) {
  db.prepare(
    `UPDATE receipts SET status = 'nudged', nudged_at = datetime('now') WHERE id = ?`,
  ).run(id);
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
