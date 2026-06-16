# claude-quiz — Autonomous Spaced-Repetition Quiz (v5)

A Claude-driven spaced-repetition quiz over two Notion databases. You quiz yourself by
**chatting in a Claude Project** (Android + web). A custom **MCP server on your home PC**
is the bridge: it owns all Notion I/O and runs the v5 **deterministic engine in code**
(state machine, streak rule, `Due` interval math). The chat-Claude only judges `score` +
`gap_notes` and authors content — it never computes scheduling or state.

See [`autonomous-quiz-system-spec-v5.md`](autonomous-quiz-system-spec-v5.md) (canonical design)
and [`BUILD-PLAN.md`](BUILD-PLAN.md) (architecture + decisions).

## What's here

| File | Role |
|---|---|
| [src/engine.ts](src/engine.ts) | Pure deterministic v5 engine (state machine, streak, `Due`/interval, date-only ISO, gap-history ring buffer, char-guard split). Unit-tested. |
| [src/schema.ts](src/schema.ts) | Canonical Notion property names + the display-only formulas. |
| [src/setup.ts](src/setup.ts) | One-time script that creates the two databases. |
| [src/notion.ts](src/notion.ts) | Thin Notion REST wrapper (property read/write helpers). |
| [src/tools.ts](src/tools.ts) | The six MCP tools' logic, wrapping the engine + Notion. |
| [src/server.ts](src/server.ts) | MCP server over Streamable HTTP (stateless). |
| [test/engine.test.ts](test/engine.test.ts) | Engine unit tests (`npm test`). |

## Prerequisites

- Node 22 (installed), a Notion internal integration token, and a Claude **Pro/Max** plan
  (needed to add a custom connector).
- Tailscale on this PC with **Funnel** enabled (for the public HTTPS URL).

## 1. Configure

```bash
cp .env.example .env
```

Fill in `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` (the Notion page the two databases will
be created under — share that page with your integration first; grab the ID from its URL).

## 2. Create the databases (one time)

```bash
npm install
npm run setup
```

This creates **🗺️ Topics** and **🗂️ Question Bank** to the v5 schema and prints three lines.
Paste them into `.env`:

```
TOPICS_DB_ID=…
QUESTION_BANK_DB_ID=…
QUESTION_TITLE_PROP_ID=…
```

Then, in Notion:

1. **Share both databases with your integration** (each DB → `•••` → Connections → add yours).
2. The Notion API can't set rollup **filters**, so finish two one-click steps in the UI:
   add a filter to **Mastered Count** (Status = Mastered) and **Weak Count** (Status = Weak).
   (`npm run setup` prints this reminder too.)

## 3. Run + verify the engine

```bash
npm test         # engine unit tests
npm run typecheck
npm start        # boots the MCP server on PORT (default 8787)
```

Sanity-check it's up: `curl http://localhost:8787/health` → `{"ok":true,...}`.

## 4. Expose it publicly (Tailscale Funnel)

Anthropic's cloud — not your phone — makes the MCP calls, so the server needs a **public**
HTTPS URL. A private tailnet won't do; Funnel gives a public `*.ts.net` URL.

```bash
tailscale funnel 8787
```

Copy the printed `https://<machine>.<tailnet>.ts.net` URL. Your MCP endpoint is that URL
**+ `/mcp`**. Keep this process (and `npm start`) running while you want remote access.

## 5. Wire it to Claude (authless connector)

1. On **claude.ai** (web) → Settings → Connectors → **Add custom connector**.
2. Name it (e.g. "Quiz") and paste the **`https://…ts.net/mcp`** URL. Auth: **None / authless**.
3. Create a **Project**, enable the connector for it, and paste the instruction prompt below.
4. Connectors added on web are usable from the **Android app** too (you just can't *add* new
   ones from the phone).

## 6. Seed + dry-run

In the Notion UI (or by asking Claude to `create_question`), add a topic row and a couple of
questions, then start a chat: *"Quiz me on SQL."* Confirm a graded answer advances `Due`
correctly in the Question Bank, from both web and Android.

---

## Project instruction prompt (paste into the Claude Project)

> You run a spaced-repetition quiz backed by the **Claude Quiz** connector. **Never compute
> scheduling, status, streaks, or due dates yourself — always call the tools.** Your only
> judgments are the 1–5 **score** and a short **gap_notes** line.
>
> **1–5 score anchors (use exactly these):**
> - **5** Perfect — hit all rubric points, no hints.
> - **4** Great — minor gaps/hesitation, fundamentally correct.
> - **3** Shaky — needed major hints, or missed a core requirement.
> - **2** Weak — fundamentally flawed, some understanding shown.
> - **1** Blank or completely incorrect.
>
> **Workflow per session:**
> 1. Call `get_topic(topic)`. If the user wants deep context, call `get_profile(profile_block_id)`.
> 2. Call `get_due_questions(topic)`. If none are due (or the user wants fresh ones), author a
>    new question with `create_question` — always supply a **Rubric** so it's gradeable.
> 3. Ask one question at a time (the `prompt` is ready to show). After the user answers,
>    **grade against that question's `rubric`** using the anchors above. Credit valid
>    alternative approaches that satisfy the same key points; don't invent requirements the
>    rubric doesn't state.
> 4. Call `submit_evaluation(question_id, score, gap_notes)`. Supply **only** score + notes —
>    the app computes Status, Streak, Last Asked, **Due**, and counts. Write gap_notes fresh
>    (≤150 chars); don't echo prior notes.
> 5. Only when a recurring pattern emerged across the session, call `update_topic` with a
>    compressed `weak_areas` and/or a ≤300-word `profile_summary` (overwrite, don't accumulate).
> 6. Give the user their score and concrete improvement advice.
>
> Don't double-submit an evaluation for the same question. If a tool returns an error, tell
> the user plainly rather than guessing the result.
>
> **TOOL-CALL HYGIENE (required):**
> - Pass **ONLY** the parameters defined in each tool's schema. Never add extra, invented, or
>   internal fields (e.g. no `_tool_call_id`, no `id`, no metadata wrappers). A stray parameter
>   can cause the call to be rejected with a "not registered" or "stale schema" error even when
>   the tool is fine.
> - Use the **exact** tool name and parameter names from the loaded schema; don't guess or
>   reformat them.
> - If a tool call fails, first re-issue it with a **clean payload** containing only
>   schema-defined parameters before concluding the tool itself is broken. Report the literal
>   error text to the user; don't infer success or failure.
> - Treat the connector's responses as the **source of truth** for `question_id` and status —
>   never fabricate IDs or outcomes.

---

## v5 invariants (don't regress — see BUILD-PLAN §7)

- Scheduling filters on the **written `Due` Date** property, never a formula (the API in this
  workspace rejects all formula filters with `400`). `Level` / `Next Review` are display-only.
- `Due` is computed from the **new** Status + **new** Streak, written **date-only ISO**.
- Interval: New/reset → today; Weak → +1d; Shaky → +3d; Mastered → +14×Streak days.
- Reaching Mastered needs two clean reps; score 3 → Shaky (demote); score 1–3 resets Streak.
- Gap Notes overwritten + clamped ≤150 chars; Gap History = capped ring buffer (3).
- Callout summary split across two rich-text objects on a word/sentence boundary, ~1,900-char guard.
- Dedup is titles-only via the Title property's **internal ID**.
- Writes aren't transactional; an accidental double-`submit_evaluation` is dropped within ~90s.

## Deploying on Debian 13 (xfce, x86-64)

The code is OS-agnostic (no Windows-specific calls). It runs on Debian as-is; you just need
Node 22 and a few setup steps.

**1. Install Node 22** (Debian 13's apt `nodejs` is too old). Use NodeSource:

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v22.x
```

**2. Get the code + install deps:**

```bash
git clone <your-repo> claude-quiz && cd claude-quiz
npm ci                # or: npm install
cp .env.example .env  # then fill it in
```

**3. Set the system timezone** — `Due`/"today" use the server's local date, so the box must
be on your timezone:

```bash
timedatectl                                  # check current zone
sudo timedatectl set-timezone Asia/Manila    # use your actual zone
```

**4. Create the DBs, test, run** (same as above):

```bash
npm run setup        # paste the printed IDs into .env, share both DBs with the integration
npm test
npm start            # listens on PORT (default 8787)
```

**5. Keep it running with systemd** (so it survives reboots/logout). Create
`/etc/systemd/system/claude-quiz.service`:

```ini
[Unit]
Description=claude-quiz MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/claude-quiz
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-quiz
systemctl status claude-quiz          # confirm it's running
curl http://localhost:8787/health
```

**6. Expose with Tailscale Funnel** (install Tailscale on Debian if needed):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel 8787            # prints your public https://…ts.net URL
```

Run Funnel as a background service too if you want it persistent:
`sudo tailscale funnel --bg 8787`. Your MCP endpoint is that URL **+ `/mcp`**.

## Notes

- **No Anthropic API key / billing** — the grading model is the chat client (your Claude plan).
- Optional Mastered-interval easing (`14 × max(Streak−1, 1)`): set `INTERVAL_EASING=true` in `.env`.
- Authless is fine to start (single-user, random Funnel URL). Move to OAuth later if you want.
