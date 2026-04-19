import { dueReceipts, markNudged, type DB } from "./db.js";
import { nudge } from "./claude.js";

export type Sender = (handle: string, text: string) => Promise<void>;

export function startScheduler(db: DB, send: Sender, intervalMs = 60_000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = dueReceipts(db);
      for (const r of due) {
        try {
          const text = await nudge(r);
          await send(r.handle, text);
          markNudged(db, r.id);
        } catch (err) {
          console.error(`[scheduler] nudge failed for #${r.id}:`, err);
        }
      }
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
