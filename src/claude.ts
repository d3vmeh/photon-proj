import Anthropic from "@anthropic-ai/sdk";
import type { Receipt } from "./db.js";

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
  "intent": "new_promise" | "status_query" | "flake" | "done" | "drop" | "reschedule" | "smalltalk",
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
- "new_promise": they just committed to something. Fill "promise". Reply should confirm and mention when you'll check in.
- "status_query": they're asking what's open / what they said about X. Use the context receipts; "promise" null; "refs" cites the ids.
- "flake": they're signaling they won't do a past promise ("skipped", "can't", "nah"). Quote the stored reason back, gently. "promise" null.
- "done": they completed something. "refs" cites the receipt(s) to close.
- "drop": they want to let a promise go for good. "refs" cites receipt(s).
- "reschedule": they want to push a promise to a new time ("tomorrow instead", "next week"). "refs" cites the receipt(s); "new_deadline_iso" is the new deadline.
- "smalltalk": greetings / ambiguous. Reply briefly, "promise" null.

Timezone handling:
- The user turn will specify a "now" (UTC) and a "timezone" (IANA, e.g. America/New_York).
- Interpret relative times ("tomorrow 4pm", "in 30 min") against the user's timezone, not UTC.
- ALWAYS return deadlines in ISO 8601 UTC (ending in Z).
- In replies, refer to times in the user's LOCAL phrasing ("Wed 4pm", "in 20 min"), never raw ISO strings.
- Never invent a deadline when none was stated.

Memory / streak awareness:
- recent_receipts may contain prior promises — including ones that were dropped, nudged but not closed, or done.
- When a NEW promise rhymes with a past one the user DROPPED or never closed out, gently name it.
  Example reply: "3rd time you've told me this one. want me to actually hold you this time, or are we pretending again?"
- When a new promise matches one they DID close, a light callback is nice: "last time you actually did it — let's repeat."
- Never fabricate history. Only reference receipts that appear in recent_receipts.
- Never be preachy or shame-y. Dry > moralistic.

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
        `#${r.id} [${r.status}] "${r.text}"` +
        (r.reason ? ` — reason: "${r.reason}"` : "") +
        (r.deadline ? ` — due ${r.deadline}` : "") +
        ` — saved ${r.created_at}`,
    )
    .join("\n");
}

export async function decide(opts: {
  userText: string;
  handle: string;
  now: Date;
  timezone: string;
  context: Receipt[];
}): Promise<Decision> {
  const { userText, handle, now, timezone, context } = opts;

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

export async function nudge(receipt: Receipt, timezone: string): Promise<string> {
  const dueLocal = receipt.deadline
    ? formatLocal(new Date(receipt.deadline), timezone)
    : null;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system:
      `You write one-line iMessage nudges for promises people made to themselves.\n` +
      `Style: warm, brief, a touch dry. No emojis unless the original text had them. <= 200 chars. No markdown.\n` +
      `Always quote the user's own reason verbatim in quotes when one exists.\n` +
      `Refer to times in the user's local phrasing ("4pm", "now"), never raw ISO strings.`,
    messages: [
      {
        role: "user",
        content:
          `Promise: "${receipt.text}"\n` +
          (receipt.reason ? `Their reason: "${receipt.reason}"\n` : "") +
          (dueLocal ? `Due (local): ${dueLocal}\n` : "") +
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
