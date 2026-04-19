import {
  dueReceipts,
  escalationReceipts,
  markNudged,
  weeklyStats,
  distinctHandles,
  openForHandle,
  kvGet,
  kvSet,
  type DB,
} from "./db.js";
import { nudge, writeDigest } from "./claude.js";

export type Sender = (handle: string, text: string) => Promise<void>;

export type SchedulerConfig = {
  intervalMs: number;
  timezone: string;
  escalation: { step2Ms: number; step3Ms: number };
  digest: { enabled: boolean; hourLocal: number };
};

export function startScheduler(db: DB, send: Sender, cfg: SchedulerConfig) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fireNudges(db, send, cfg);
      if (cfg.digest.enabled) await maybeFireDigest(db, send, cfg);
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(tick, cfg.intervalMs);
  return () => clearInterval(handle);
}

async function fireNudges(db: DB, send: Sender, cfg: SchedulerConfig) {
  // Level 1: deadline just passed.
  for (const r of dueReceipts(db)) {
    try {
      const text = await nudge(r, cfg.timezone, 1);
      await send(r.handle, text);
      markNudged(db, r.id, 1);
    } catch (err) {
      console.error(`[scheduler] L1 nudge failed for #${r.id}:`, err);
    }
  }
  // Level 2 / 3: escalation for silent receipts.
  for (const r of escalationReceipts(db, cfg.escalation.step2Ms, cfg.escalation.step3Ms)) {
    const level = (r.nudge_count + 1) as 2 | 3;
    try {
      const text = await nudge(r, cfg.timezone, level);
      await send(r.handle, text);
      markNudged(db, r.id, level);
    } catch (err) {
      console.error(`[scheduler] L${level} nudge failed for #${r.id}:`, err);
    }
  }
}

async function maybeFireDigest(db: DB, send: Sender, cfg: SchedulerConfig) {
  const now = new Date();
  const local = localParts(now, cfg.timezone);
  if (local.hour !== cfg.digest.hourLocal) return;
  // minute window: only fire in the first tick of that hour
  // — cheap de-dupe per local date.

  const dateKey = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;

  for (const h of distinctHandles(db)) {
    const k = `digest:${h}:${dateKey}`;
    if (kvGet(db, k)) continue;
    const open = openForHandle(db, h);
    if (open.length === 0) {
      kvSet(db, k, "skipped-empty");
      continue;
    }
    try {
      const stats = weeklyStats(db, h);
      const text = await writeDigest(open, cfg.timezone, stats);
      await send(h, text);
      kvSet(db, k, "sent");
      console.log(`[scheduler] digest sent to ${h}`);
    } catch (err) {
      console.error(`[scheduler] digest failed for ${h}:`, err);
    }
  }
}

function localParts(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}
