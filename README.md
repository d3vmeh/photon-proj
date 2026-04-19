# Receipts

**Text it your promises — it quotes you back when you're tempted to flake.**

An iMessage-native agent built on [`@photon-ai/imessage-kit`](https://github.com/photon-hq/imessage-kit) and Claude. No app. No UI. You text it like a friend; it holds onto what you said and surfaces your own words at the exact moment you're about to bail.

## The feel

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

- Every incoming iMessage is run through Claude (`claude-sonnet-4-6`) with a stable cached system prompt.
- Claude returns structured JSON: intent (`new_promise` / `status_query` / `flake` / `done` / `drop` / `smalltalk`), a reply, and — if it's a new commitment — the promise text, the reason in the user's own words, and an ISO deadline.
- Receipts are written to a local SQLite DB.
- A polling scheduler checks every minute for anything past due and sends a nudge that always quotes the user's original reason back to them.
- When the user signals flaking, the agent retrieves the matching receipts and echoes the reason — no lectures, just the words they chose.

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
- `RECEIPTS_OWNER_HANDLE` — if set, only messages from this handle are processed. Useful on a shared Mac.
- `RECEIPTS_TRIGGER_PREFIX` — enables solo mode; agent only acts on messages starting with this string.
- `RECEIPTS_NUDGE_MS` — nudge scheduler interval in ms (default 10000). Drop to 2000 for demos.
- `RECEIPTS_CHAT_DB` — DB path for the `npm run chat` REPL (default `:memory:`).
