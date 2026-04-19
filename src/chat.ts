import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  openDb,
  addReceipt,
  listOpen,
  findRelevant,
  updateStatus,
  rescheduleReceipt,
  completeDraft,
  dueReceipts,
  markNudged,
  weeklyStats,
  openForHandle,
  type Receipt,
} from "./db.js";
import { decide, nudge, writeDigest } from "./claude.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const HANDLE = "+15550000REPL";
const DB_PATH = process.env.RECEIPTS_CHAT_DB || ":memory:";
const TIMEZONE =
  (process.env.RECEIPTS_TIMEZONE || "").trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;
const db = openDb(DB_PATH);

function context(text: string): Receipt[] {
  const open = listOpen(db, HANDLE, 10);
  const rel = findRelevant(db, HANDLE, text, 5);
  const seen = new Set<number>();
  const merged: Receipt[] = [];
  for (const r of [...open, ...rel]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged.slice(0, 15);
}

function printList() {
  const rows = db
    .prepare(`SELECT * FROM receipts WHERE handle = ? ORDER BY id DESC`)
    .all(HANDLE) as Receipt[];
  if (rows.length === 0) {
    console.log("  (no receipts yet)\n");
    return;
  }
  for (const r of rows) {
    const due = r.deadline ? ` due ${r.deadline}` : "";
    const reason = r.reason ? ` — "${r.reason}"` : "";
    console.log(`  #${r.id} [${r.status}] "${r.text}"${reason}${due}`);
  }
  console.log();
}

async function fireDue() {
  const due = dueReceipts(db);
  if (due.length === 0) {
    console.log("  (nothing overdue)\n");
    return;
  }
  for (const r of due) {
    const level = Math.min(3, r.nudge_count + 1) as 1 | 2 | 3;
    const text = await nudge(r, TIMEZONE, level);
    markNudged(db, r.id, level);
    console.log(`  L${level} nudge #${r.id} → ${text}`);
  }
  console.log();
}

async function showDigest() {
  const open = openForHandle(db, HANDLE);
  if (open.length === 0) {
    console.log("  (no open receipts — nothing to brief on)\n");
    return;
  }
  const text = await writeDigest(open, TIMEZONE, weeklyStats(db, HANDLE));
  console.log(`  morning digest → ${text}\n`);
}

function showStats() {
  const s = weeklyStats(db, HANDLE);
  console.log(`  7-day: kept=${s.kept} dropped=${s.dropped} open=${s.open} total=${s.total_made}\n`);
}

const HELP = `
commands:
  .help        show this
  .list        show all receipts
  .stats       show 7-day keep/drop stats
  .due         force-fire any overdue nudges (skips the wait)
  .digest      generate the morning digest now (skips the clock)
  .quit        exit (also Ctrl-D)
  anything else is treated as an incoming iMessage.
`;

async function main() {
  const rl = readline.createInterface({ input, output });
  console.log(`receipts chat REPL. db: ${DB_PATH}. type .help for commands.`);

  while (true) {
    let line: string;
    try {
      line = await rl.question("you> ");
    } catch {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === ".quit" || trimmed === ".exit") break;
    if (trimmed === ".help") { console.log(HELP); continue; }
    if (trimmed === ".list") { printList(); continue; }
    if (trimmed === ".stats") { showStats(); continue; }
    if (trimmed === ".due") { await fireDue(); continue; }
    if (trimmed === ".digest") { await showDigest(); continue; }

    let d;
    try {
      d = await decide({
        userText: trimmed,
        handle: HANDLE,
        now: new Date(),
        timezone: TIMEZONE,
        context: context(trimmed),
        stats: weeklyStats(db, HANDLE),
      });
    } catch (err) {
      console.error("claude error:", err);
      continue;
    }

    if (d.intent === "new_promise" && d.promise) {
      const saved = addReceipt(db, {
        handle: HANDLE,
        text: d.promise.text,
        reason: d.promise.reason,
        deadline: d.promise.deadline_iso,
        tags: d.promise.tags,
      });
      console.log(`(saved #${saved.id}${saved.deadline ? `, due ${saved.deadline}` : ""})`);
    }
    if (d.intent === "ask_reason" && d.promise) {
      const draft = addReceipt(db, {
        handle: HANDLE,
        text: d.promise.text,
        reason: null,
        deadline: d.promise.deadline_iso,
        tags: d.promise.tags,
      });
      db.prepare(`UPDATE receipts SET status = 'draft' WHERE id = ?`).run(draft.id);
      console.log(`(draft #${draft.id} awaiting reason)`);
    }
    if (d.intent === "complete_draft") {
      for (const id of d.refs) {
        const reason = d.promise?.reason;
        if (!reason) continue;
        completeDraft(db, id, reason, {
          deadline: d.promise?.deadline_iso ?? null,
          tags: d.promise?.tags ?? null,
          text: d.promise?.text ?? null,
        });
        console.log(`(filled draft #${id})`);
      }
    }
    if (d.intent === "done") d.refs.forEach((id) => updateStatus(db, id, "done"));
    if (d.intent === "drop") d.refs.forEach((id) => updateStatus(db, id, "dropped"));
    if (d.intent === "reschedule" && d.new_deadline_iso) {
      d.refs.forEach((id) => rescheduleReceipt(db, id, d.new_deadline_iso!));
      console.log(`(rescheduled ${d.refs.join(",")} → ${d.new_deadline_iso})`);
    }

    console.log(`bot> ${d.reply}`);
    const meta = [`intent:${d.intent}`];
    if (d.refs.length) meta.push(`refs:${d.refs.join(",")}`);
    console.log(`[${meta.join(" ")}]\n`);
  }

  rl.close();
  db.close();
  console.log("bye.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
