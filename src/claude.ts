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
  "intent": "new_promise" | "status_query" | "flake" | "done" | "drop" | "smalltalk",
  "reply": "<short SMS-friendly reply, <= 280 chars, no markdown>",
  "promise": {
    "text": "<the commitment, first-person, <= 140 chars>",
    "reason": "<why they said they wanted it, in their own phrasing, <= 200 chars>",
    "deadline_iso": "<ISO 8601 UTC, or null if none>",
    "tags": "<comma-separated short tags, or null>"
  } | null,
  "refs": [<integer receipt ids this reply is about, or empty>]
}

Intent rules:
- "new_promise": they just committed to something. Fill "promise". Reply should confirm and promise to nudge.
- "status_query": they're asking what's open / what they said about X. Use the context receipts; "promise" null; "refs" list the ids you cited.
- "flake": they're signaling they won't do a past promise ("skipped", "can't", "nah"). Quote the stored reason back, gently. "promise" null.
- "done": they completed something. "refs" cites the receipt(s) to close.
- "drop": they want to let a promise go. "refs" cites receipt(s) to drop.
- "smalltalk": greetings / ambiguous. Reply briefly, "promise" null.

Deadlines: interpret relative times against the "now" given in the user turn.
If no deadline is stated, set deadline_iso to null — do NOT invent one.
Never assume a promise is flaking unless the user says so. Never invent receipts.`;

export type ExtractedPromise = {
  text: string;
  reason: string | null;
  deadline_iso: string | null;
  tags: string | null;
};

export type Decision = {
  intent: "new_promise" | "status_query" | "flake" | "done" | "drop" | "smalltalk";
  reply: string;
  promise: ExtractedPromise | null;
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
  context: Receipt[];
}): Promise<Decision> {
  const { userText, handle, now, context } = opts;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `now: ${now.toISOString()}\n` +
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
    const parsed = JSON.parse(json) as Decision;
    if (!parsed.reply) throw new Error("missing reply");
    parsed.refs = parsed.refs ?? [];
    return parsed;
  } catch (err) {
    console.error("[claude] parse failure:", err, "raw:", raw);
    return {
      intent: "smalltalk",
      reply: "hm, got tangled up there. mind saying that again?",
      promise: null,
      refs: [],
    };
  }
}

function stripFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : s;
}

export async function nudge(receipt: Receipt): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system:
      `You write one-line iMessage nudges for promises people made to themselves.\n` +
      `Style: warm, brief, a touch dry. No emojis unless the original text had them. <= 200 chars. No markdown.\n` +
      `Always quote the user's own reason verbatim in quotes when one exists.`,
    messages: [
      {
        role: "user",
        content:
          `Promise: "${receipt.text}"\n` +
          (receipt.reason ? `Their reason: "${receipt.reason}"\n` : "") +
          (receipt.deadline ? `Due: ${receipt.deadline}\n` : "") +
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
