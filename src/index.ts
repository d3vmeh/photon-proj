import { IMessageSDK, loggerPlugin, type Message } from "@photon-ai/imessage-kit";
import {
  openDb,
  addReceipt,
  listOpen,
  findRelevant,
  updateStatus,
  rescheduleReceipt,
  weeklyStats,
  type Receipt,
} from "./db.js";
import { decide } from "./claude.js";
import { startScheduler } from "./scheduler.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const OWNER = (process.env.RECEIPTS_OWNER_HANDLE || "").trim();
const TRIGGER = (process.env.RECEIPTS_TRIGGER_PREFIX || "").trim();
const SOLO = TRIGGER.length > 0;
const NUDGE_INTERVAL_MS = Number(process.env.RECEIPTS_NUDGE_MS || 10_000);
const TIMEZONE =
  (process.env.RECEIPTS_TIMEZONE || "").trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;
const STEP2_MS = Number(process.env.RECEIPTS_ESCALATE_STEP2_MS || 20 * 60 * 1000);
const STEP3_MS = Number(process.env.RECEIPTS_ESCALATE_STEP3_MS || 60 * 60 * 1000);
const DIGEST_ENABLED = (process.env.RECEIPTS_DIGEST_ENABLED || "true").toLowerCase() !== "false";
const DIGEST_HOUR = Number(process.env.RECEIPTS_DIGEST_HOUR || 8);

const db = openDb();
const sdk = new IMessageSDK({
  plugins: [loggerPlugin({ level: "info" })],
  watcher: {
    pollInterval: 2000,
    // In solo mode we accept our own texts (iPhone→same Apple ID→Mac),
    // but we only ACT on messages starting with the trigger prefix.
    excludeOwnMessages: !SOLO,
  },
});

function isOwner(sender: string): boolean {
  if (!OWNER) return true;
  return normalize(sender) === normalize(OWNER);
}

function normalize(handle: string): string {
  return handle.replace(/[\s\-()]/g, "").toLowerCase();
}

async function handle(msg: Message) {
  if (msg.isReaction || !msg.text) return;
  if (msg.isGroupChat) return;

  const raw = msg.text.trim();
  if (!raw) return;

  let text: string;
  if (SOLO) {
    if (!raw.startsWith(TRIGGER)) return;
    text = raw.slice(TRIGGER.length).trim();
    if (!text) return;
  } else {
    if (msg.isFromMe) return;
    text = raw;
  }

  if (!isOwner(msg.sender)) {
    console.log(`[receipts] ignoring non-owner: ${msg.sender}`);
    return;
  }

  const context = gatherContext(msg.sender, text);

  let decision;
  try {
    decision = await decide({
      userText: text,
      handle: msg.sender,
      now: new Date(),
      timezone: TIMEZONE,
      context,
      stats: weeklyStats(db, msg.sender),
    });
  } catch (err) {
    console.error("[receipts] claude failed:", err);
    await sdk.send(msg.sender, "hm, my brain glitched. try again in a sec?");
    return;
  }

  await applyDecision(msg.sender, decision);

  try {
    await sdk.send(msg.sender, decision.reply);
  } catch (err) {
    console.error("[receipts] send failed:", err);
  }
}

function gatherContext(sender: string, userText: string): Receipt[] {
  const open = listOpen(db, sender, 10);
  const matchedByWord = findRelevant(db, sender, userText, 5);
  const seen = new Set<number>();
  const merged: Receipt[] = [];
  for (const r of [...open, ...matchedByWord]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged.slice(0, 15);
}

async function applyDecision(sender: string, d: Awaited<ReturnType<typeof decide>>) {
  switch (d.intent) {
    case "new_promise":
      if (d.promise) {
        const saved = addReceipt(db, {
          handle: sender,
          text: d.promise.text,
          reason: d.promise.reason,
          deadline: d.promise.deadline_iso,
          tags: d.promise.tags,
        });
        console.log(`[receipts] saved #${saved.id}: "${saved.text}"`);
      }
      break;
    case "done":
      for (const id of d.refs) updateStatus(db, id, "done");
      break;
    case "drop":
      for (const id of d.refs) updateStatus(db, id, "dropped");
      break;
    case "reschedule":
      if (d.new_deadline_iso) {
        for (const id of d.refs) rescheduleReceipt(db, id, d.new_deadline_iso);
      }
      break;
    case "flake":
    case "status_query":
    case "smalltalk":
      break;
  }
}

async function main() {
  const stopScheduler = startScheduler(
    db,
    async (to, body) => {
      await sdk.send(to, body);
    },
    {
      intervalMs: NUDGE_INTERVAL_MS,
      timezone: TIMEZONE,
      escalation: { step2Ms: STEP2_MS, step3Ms: STEP3_MS },
      digest: { enabled: DIGEST_ENABLED, hourLocal: DIGEST_HOUR },
    },
  );

  await sdk.startWatching({
    onDirectMessage: handle,
    onError: (err) => console.error("[receipts] watcher error:", err),
  });

  console.log("[receipts] up.");
  if (SOLO) {
    console.log(`[receipts] SOLO MODE: only processing messages starting with "${TRIGGER}".`);
    console.log(`[receipts]   (text yourself from iPhone: "${TRIGGER} gonna stretch in 3 min bc my back hurts")`);
  } else {
    console.log("[receipts] text the Mac's iMessage account from another device to make a promise.");
  }
  if (OWNER) console.log(`[receipts] accepting messages from ${OWNER} only.`);
  console.log(`[receipts] timezone: ${TIMEZONE}`);
  console.log(`[receipts] nudge scheduler ticking every ${NUDGE_INTERVAL_MS / 1000}s.`);
  console.log(
    `[receipts] escalation: L2 after ${(STEP2_MS / 60000).toFixed(1)}m silent, L3 after ${(STEP3_MS / 60000).toFixed(1)}m.`,
  );
  if (DIGEST_ENABLED) {
    console.log(`[receipts] morning digest: ${String(DIGEST_HOUR).padStart(2, "0")}:00 ${TIMEZONE}`);
  }

  const shutdown = async () => {
    console.log("\n[receipts] shutting down...");
    stopScheduler();
    sdk.stopWatching();
    await sdk.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[receipts] fatal:", err);
  process.exit(1);
});
