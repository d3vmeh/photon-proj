import { openDb, weeklyStats, type Receipt } from "./db.js";

const TIMEZONE =
  (process.env.RECEIPTS_TIMEZONE || "").trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;

const db = openDb();

function fmtLocal(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function relativeFromNow(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const pick =
    mins < 60 ? `${mins}m` : hrs < 36 ? `${hrs}h` : `${days}d`;
  return diffMs < 0 ? `${pick} overdue` : `in ${pick}`;
}

function statusBadge(r: Receipt): string {
  const base = r.status.toUpperCase();
  if (r.nudge_count) return `${base}×${r.nudge_count}`;
  return base;
}

function printHeader() {
  console.log("┌" + "─".repeat(70) + "┐");
  console.log(`│ RECEIPTS · timezone: ${TIMEZONE.padEnd(47)} │`);
  console.log("└" + "─".repeat(70) + "┘");
  console.log();
}

function printHandles() {
  const rows = db
    .prepare(
      `SELECT handle, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('open','nudged','draft') THEN 1 ELSE 0 END) AS open
       FROM receipts
       GROUP BY handle
       ORDER BY total DESC`,
    )
    .all() as { handle: string; total: number; open: number }[];
  if (rows.length === 0) {
    console.log("no receipts yet.\n");
    return;
  }
  console.log("handles");
  console.log("───────");
  for (const r of rows) {
    console.log(`  ${r.handle.padEnd(40)}  total ${r.total}  open ${r.open}`);
  }
  console.log();
}

function printStatsFor(handle: string) {
  const week = weeklyStats(db, handle);
  const month = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS kept,
         SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) AS dropped,
         COUNT(*) AS total
       FROM receipts
       WHERE handle = ? AND created_at >= datetime('now','-30 day')`,
    )
    .get(handle) as { kept: number; dropped: number; total: number };
  const keepRate =
    week.kept + week.dropped === 0
      ? "—"
      : `${Math.round((100 * week.kept) / (week.kept + week.dropped))}%`;
  console.log(`stats for ${handle}`);
  console.log("─".repeat(`stats for ${handle}`.length));
  console.log(`  7-day:  kept ${week.kept}  dropped ${week.dropped}  open ${week.open}  keep-rate ${keepRate}`);
  console.log(`  30-day: kept ${month.kept ?? 0}  dropped ${month.dropped ?? 0}  total ${month.total ?? 0}`);
  console.log();
}

function printOpen(handle: string) {
  const rows = db
    .prepare(
      `SELECT * FROM receipts
       WHERE handle = ? AND status IN ('open','nudged','draft')
       ORDER BY COALESCE(deadline, '9999') ASC, created_at ASC`,
    )
    .all(handle) as Receipt[];
  if (rows.length === 0) {
    console.log(`  (nothing open for ${handle})\n`);
    return;
  }
  console.log(`open receipts for ${handle}`);
  console.log("─".repeat(`open receipts for ${handle}`.length));
  for (const r of rows) {
    const due = r.deadline ? `${fmtLocal(r.deadline)} (${relativeFromNow(r.deadline)})` : "no deadline";
    console.log(`  #${r.id} [${statusBadge(r)}] ${due}`);
    console.log(`     "${r.text}"`);
    if (r.reason) console.log(`     — "${r.reason}"`);
    if (r.tags) console.log(`     tags: ${r.tags}`);
  }
  console.log();
}

function printHistory(handle: string, limit = 15) {
  const rows = db
    .prepare(
      `SELECT * FROM receipts
       WHERE handle = ? AND status IN ('done','dropped')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(handle, limit) as Receipt[];
  if (rows.length === 0) return;
  console.log(`recent history for ${handle}`);
  console.log("─".repeat(`recent history for ${handle}`.length));
  for (const r of rows) {
    console.log(`  #${r.id} ${r.status.padEnd(7)} "${r.text}"${r.reason ? ` — "${r.reason}"` : ""}`);
  }
  console.log();
}

function printFlakeTags() {
  const rows = db
    .prepare(
      `SELECT tags, COUNT(*) AS n
       FROM receipts
       WHERE status = 'dropped' AND tags IS NOT NULL
       GROUP BY tags
       HAVING n > 0
       ORDER BY n DESC
       LIMIT 5`,
    )
    .all() as { tags: string; n: number }[];
  if (rows.length === 0) return;
  console.log("most-flaked tags");
  console.log("────────────────");
  for (const r of rows) console.log(`  ${r.tags.padEnd(40)} ${r.n}`);
  console.log();
}

function main() {
  printHeader();
  printHandles();

  const handles = db
    .prepare(
      `SELECT DISTINCT handle FROM receipts ORDER BY handle`,
    )
    .all() as { handle: string }[];

  for (const { handle } of handles) {
    printStatsFor(handle);
    printOpen(handle);
    printHistory(handle);
  }

  printFlakeTags();

  db.close();
}

main();
