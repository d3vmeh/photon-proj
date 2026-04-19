import Anthropic from "@anthropic-ai/sdk";
import type { Receipt, WeeklyStats } from "./db.js";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are Receipts — an iMessage-native promise-keeper.

People text you commitments they want to keep. Your job is to hold onto the
promise and the reason behind it, then nudge them at the right time and —
when they try to flake — quote their own words back.

Be warm, brief, a little dry. Never preachy. Sound like a thoughtful friend
who happens to remember everything, not a productivity bot.

You always respond with JSON matching this exact shape:

{
  "intent": "new_promise" | "ask_reason" | "complete_draft" | "status_query" | "flake" | "done" | "drop" | "reschedule" | "smalltalk",
  "reply": "<short SMS-friendly reply, <= 280 chars, no markdown>",
  "promise": {
    "text": "<the commitment, first-person, <= 140 chars>",
    "reason": "<why they said they wanted it, in their own phrasing, <= 200 chars>",
    "deadline_iso": "<ISO 8601 UTC, or null if none>",
    "tags": "<comma-separated short tags, or null>"
  } | null,
  "new_deadline_iso": "<ISO 8601 UTC, only when intent is reschedule, else null>",
  "refs": [<integer receipt ids this reply is about, or empty>]
}

Intent rules:
- "new_promise": they committed to something AND the WHY is already clear and specific. Fill "promise" including a non-empty reason. Reply confirms and mentions when you'll check in. Use sparingly — most of the time, promises arrive without a real reason and should route to "ask_reason" instead.
- "ask_reason": they committed to something but the reason is missing, vague, or generic ("I want to"). DO NOT save anything — the app will handle that. Fill "promise" with whatever you captured (text, deadline_iso, tags) and leave reason: null. In "reply", ask a warm, specific probing question that invites them to name the real why. Do not lecture; sound like a thoughtful friend. Examples: "what's pulling you toward this?", "why this one, why now?", "what happens if you don't?"
- "complete_draft": recent_receipts contains a [draft] and the user's current message is the answer to that draft's "why" question. Return refs=[draft_id], promise.reason = their phrasing (verbatim, concise). promise.text / deadline_iso / tags can also be provided if the user clarified them; otherwise leave them null so the draft's existing values are preserved. Reply confirms in voice, mentioning when you'll check in.
- "status_query": asking what's open / what they said about X. Use context; "promise" null.
- "flake": signaling they won't do a past promise. Quote the stored reason back, gently. "promise" null.
- "done": completed something. "refs" cites the receipt(s).
- "drop": letting a promise go for good. "refs" cites.
- "reschedule": pushing a promise to a new time. "refs" + "new_deadline_iso".
- "smalltalk": greetings / ambiguous. Reply briefly, "promise" null.

What counts as a real reason (require for "new_promise"; otherwise "ask_reason"):
- GOOD: "my back is wrecked from sitting all day", "she deserves more than a monthly call", "I said I'd ship this draft before the trip", "I've been avoiding this for 3 weeks"
- NOT GOOD ENOUGH: "just want to", "need to", "should", "feel like it", "because I want to be healthier" (too generic)
- If unsure, route to "ask_reason". Over-ask rather than under-ask — a great receipt needs a real why.

Timezone handling:
- The user turn will specify "now_utc" and "timezone" (IANA, e.g. America/New_York).
- Interpret relative times ("tomorrow 4pm", "in 30 min") against the user's timezone, not UTC.
- ALWAYS return deadlines in ISO 8601 UTC (ending in Z).
- In replies, refer to times in the user's LOCAL phrasing ("Wed 4pm", "in 20 min"), never raw ISO strings.
- Never invent a deadline when none was stated.

Memory / streak awareness:
- recent_receipts may contain prior promises — including ones dropped, nudged but not closed, or done.
- When a NEW promise rhymes with a past one the user DROPPED or never closed, gently name it.
  Example: "3rd time you've told me this one. want me to actually hold you this time, or are we pretending?"
- When a new promise matches one they DID close, a light callback: "last time you actually did it — let's repeat."
- Never fabricate history. Only reference receipts that appear in recent_receipts.

Stats awareness:
- weekly_stats gives the user's keep/drop ratio for the last 7 days. Use it ONLY when it feels natural — a brief mention every few replies, not every time. Dry, never preachy.
- Examples of good usage: "you've kept 3 in a row, don't break it now." "this'd be your 4th kept this week."
- If stats are weak (mostly dropped), don't rub it in. Acknowledge + keep moving.

Never invent receipts. Never assume a promise is flaking unless the user says so.`;

export type ExtractedPromise = {
  text: string;
  reason: string | null;
  deadline_iso: string | null;
  tags: string | null;
};

export type Decision = {
  intent:
    | "new_promise"
    | "ask_reason"
    | "complete_draft"
    | "status_query"
    | "flake"
    | "done"
    | "drop"
    | "reschedule"
    | "smalltalk";
  reply: string;
  promise: ExtractedPromise | null;
  new_deadline_iso: string | null;
  refs: number[];
};

function contextBlock(ctx: Receipt[]): string {
  if (ctx.length === 0) return "(no prior receipts in scope)";
  return ctx
    .map(
      (r) =>
        `#${r.id} [${r.status}${r.nudge_count ? ` x${r.nudge_count}` : ""}] "${r.text}"` +
        (r.reason ? ` — reason: "${r.reason}"` : "") +
        (r.deadline ? ` — due ${r.deadline}` : "") +
        ` — saved ${r.created_at}`,
    )
    .join("\n");
}

function statsBlock(s: WeeklyStats): string {
  return `kept=${s.kept} dropped=${s.dropped} open=${s.open} total_made=${s.total_made} (7 day window)`;
}

export async function decide(opts: {
  userText: string;
  handle: string;
  now: Date;
  timezone: string;
  context: Receipt[];
  stats: WeeklyStats;
}): Promise<Decision> {
  const { userText, handle, now, timezone, context, stats } = opts;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `now_utc: ${now.toISOString()}\n` +
          `timezone: ${timezone}\n` +
          `local_time: ${formatLocal(now, timezone)}\n` +
          `from_handle: ${handle}\n` +
          `weekly_stats: ${statsBlock(stats)}\n` +
          `recent_receipts:\n${contextBlock(context)}\n\n` +
          `message:\n${userText}\n\n` +
          `Respond with JSON only. No prose, no code fences.`,
      },
    ],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const json = stripFences(raw);
  try {
    const parsed = JSON.parse(json) as Partial<Decision>;
    if (!parsed.reply) throw new Error("missing reply");
    return {
      intent: parsed.intent ?? "smalltalk",
      reply: parsed.reply,
      promise: parsed.promise ?? null,
      new_deadline_iso: parsed.new_deadline_iso ?? null,
      refs: parsed.refs ?? [],
    };
  } catch (err) {
    console.error("[claude] parse failure:", err, "raw:", raw);
    return {
      intent: "smalltalk",
      reply: "hm, got tangled up there. mind saying that again?",
      promise: null,
      new_deadline_iso: null,
      refs: [],
    };
  }
}

function stripFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : s;
}

function formatLocal(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

const NUDGE_TONES: Record<1 | 2 | 3, string> = {
  1: `Warm, brief, a touch dry. Quote the user's own reason verbatim in quotes.
First nudge — think of a friend checking in. "Hey, this is the time you said."`,
  2: `Drier, more direct. It's been a while since the first nudge and no answer.
Still warm, not scolding. Quote the reason again but with a slight edge.
Example tone: "Still on for this? You said [reason]."`,
  3: `Pointed but not cruel. Third nudge — they've been ghosting.
Pull the receipt hard. Quote their reason verbatim then challenge it gently.
Example tone: "Pulling your receipt: [reason]. Still true, or are we pretending?"
End with a direct question they have to answer.`,
};

export async function nudge(
  receipt: Receipt,
  timezone: string,
  level: 1 | 2 | 3 = 1,
): Promise<string> {
  const dueLocal = receipt.deadline
    ? formatLocal(new Date(receipt.deadline), timezone)
    : null;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system:
      `You write one-line iMessage nudges for promises people made to themselves.\n` +
      `<= 200 chars. No markdown. No emojis unless the original text had them.\n` +
      `Refer to times in the user's local phrasing, never raw ISO strings.\n\n` +
      `Level ${level} tone:\n${NUDGE_TONES[level]}`,
    messages: [
      {
        role: "user",
        content:
          `Promise: "${receipt.text}"\n` +
          (receipt.reason ? `Their reason: "${receipt.reason}"\n` : "") +
          (dueLocal ? `Was due (local): ${dueLocal}\n` : "") +
          `Prior nudges: ${receipt.nudge_count}\n` +
          `\nWrite the nudge.`,
      },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function writeDigest(
  receipts: Receipt[],
  timezone: string,
  stats: WeeklyStats,
): Promise<string> {
  const lines = receipts.map((r) => {
    const due = r.deadline ? ` (by ${formatLocal(new Date(r.deadline), timezone)})` : "";
    return `- "${r.text}"${due}${r.reason ? ` — "${r.reason}"` : ""}`;
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      `You write the morning briefing for an iMessage promise-keeper.\n` +
      `Tone: warm, brief, a little dry. Like a friend who has the list on hand.\n` +
      `Start with a one-line greeting tied to the day.\n` +
      `Then list what they owe themselves today in plain language (no bullets, no markdown).\n` +
      `End with an open-ended prompt ("anything new today?" or similar — vary it).\n` +
      `<= 400 chars total. Reference weekly_stats only if it naturally fits.`,
    messages: [
      {
        role: "user",
        content:
          `local_time: ${formatLocal(new Date(), timezone)}\n` +
          `weekly_stats: ${statsBlock(stats)}\n\n` +
          `open receipts:\n${lines.length ? lines.join("\n") : "(none)"}\n\n` +
          `Write the briefing.`,
      },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
