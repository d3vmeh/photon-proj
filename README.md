# Receipts

**Text it your promises — it quotes you back when you're tempted to flake.**

An iMessage-native agent built on [`@photon-ai/imessage-kit`](https://github.com/photon-hq/imessage-kit) and Claude. No app. No UI. You text it like a friend; it holds onto what you said and surfaces your own words at the exact moment you're about to bail.

## The feel

https://x.com/d3vmeh/status/2045767966617461167?s=20

```
You (Mon 9pm):  I'll call my mom Wednesday. I keep putting it off and
                she deserves better.
Receipts:       Locked in. I'll nudge you Wed afternoon.

Receipts (Wed 4pm):  It's Wednesday. You said you'd call your mom —
                     "she deserves better."

You (Fri):      ugh skipped it
Receipts:       Pulling your receipt: "I keep putting it off and she
                deserves better." Still true? (yes = reschedule /
                no = let it go)
```

## What it's doing

- Every incoming iMessage runs through Claude (`claude-sonnet-4-6`). Output is structured JSON: intent (`new_promise` / `status_query` / `flake` / `done` / `drop` / `reschedule` / `smalltalk`), a reply, and — for a new commitment — the promise, the reason in the user's own words, an ISO deadline, and tags.
- Deadlines are stored UTC, interpreted against the user's local timezone, and phrased back in local language ("Wed 4pm", not ISO strings).
- Receipts live in local SQLite. Claude sees recent ones (open, done, dropped, nudged) every turn, so it can quote *"3rd time you've told me this one"* when the user re-promises something they flaked on.
- A scheduler polls every 10s and fires **three tiers of nudges**: a warm L1 at the deadline, a dryer L2 if you ghost it for 20 min, and a pointed L3 that pulls the receipt after an hour of silence.
- A **morning digest** lands at 8am local time with a roundup of what you owe yourself today.
- Weekly keep/drop stats are fed into every reply — Claude drops them in naturally when it fits ("you've kept 3 in a row, don't break it now").
- **Reschedule** is a first-class intent: "push the gym thing to Friday" reopens the receipt with a new deadline instead of creating a dupe.

## Setup

Requires macOS (the kit reads from `~/Library/Messages/chat.db`) and Node 18+.

```bash
npm install
cp .env.example .env
# open .env and set ANTHROPIC_API_KEY; optionally set RECEIPTS_OWNER_HANDLE
# to lock the agent to one phone/email.
npm start
```

Grant Terminal (or whatever's running `npm start`) **Full Disk Access** in
System Settings → Privacy & Security → Full Disk Access, and **Automation**
for Messages. Then text the Mac's iMessage account from your phone.

## Files

| File | What it does |
|---|---|
| `src/index.ts` | Main loop: subscribes to iMessages, routes to Claude, persists, replies |
| `src/claude.ts` | Intent classifier + nudge writer (Anthropic SDK, prompt-cached system prompt) |
| `src/db.ts` | SQLite schema + helpers for `receipts` |
| `src/scheduler.ts` | 60s polling loop for due receipts |

## Testing without a second device

Two options:

**1. Terminal REPL** — `npm run chat` opens a prompt that pipes your typed lines through the same Claude + DB pipeline as iMessage. Defaults to an in-memory DB so your real receipts aren't touched; set `RECEIPTS_CHAT_DB=./chat.db` to persist.

```
$ npm run chat
you> gonna stretch in 3 min bc my back is wrecked
(saved #1, due 2026-04-19T22:14:00.000Z)
bot> Locked in. I'll nudge you in 3.
[intent:new_promise]

you> .list
  #1 [open] "stretch for 10 min" — "my back is wrecked" due 2026-04-19T22:14:00.000Z

you> .due      # force-fire any overdue nudges
you> .quit
```

**2. Solo iMessage mode** — text your *own* email/number from your iPhone. Set `RECEIPTS_TRIGGER_PREFIX=/r` in `.env`; the agent will only act on messages starting with that prefix, and its own replies (which don't have the prefix) won't loop. Example from your iPhone: `/r gonna stretch in 3 min bc my back hurts`.

## Knobs

- `ANTHROPIC_API_KEY` — required
- `RECEIPTS_DB` — SQLite path (default `./receipts.db`)
- `RECEIPTS_OWNER_HANDLE` — if set, only messages from this handle are processed
- `RECEIPTS_TRIGGER_PREFIX` — enables solo mode; agent only acts on messages starting with this string
- `RECEIPTS_NUDGE_MS` — scheduler interval in ms (default 10000)
- `RECEIPTS_TIMEZONE` — IANA tz for interpreting "4pm tomorrow" (default: system)
- `RECEIPTS_ESCALATE_STEP2_MS` / `RECEIPTS_ESCALATE_STEP3_MS` — L2/L3 nudge gaps (default 20 min / 60 min; drop to 30000 / 90000 for demos)
- `RECEIPTS_DIGEST_ENABLED` — morning digest on/off (default `true`)
- `RECEIPTS_DIGEST_HOUR` — local hour 0–23 for the digest (default `8`)
- `RECEIPTS_CHAT_DB` — DB path for `npm run chat` (default `:memory:`)
