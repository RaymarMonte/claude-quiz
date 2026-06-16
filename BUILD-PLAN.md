# Build Plan & Handover — Autonomous Quiz System (v5)

> **Purpose:** Hand-over doc so any new session can continue building without re-deriving decisions.
> **Read first:** [`autonomous-quiz-system-spec-v5.md`](autonomous-quiz-system-spec-v5.md) — the canonical design. This file is the *implementation plan* layered on top of it.
> **Status:** Planning complete. No code written yet. Folder contains only the v4/v5 spec docs + this file. Not yet a git repo.
> **Last updated:** 2026-06-16

---

## 1. What we're building (one paragraph)

A Claude-driven spaced-repetition quiz system over two Notion databases (Topics DB + Question Bank DB, per the v5 spec). The user interacts **by chatting in a Claude Project** (Claude Android app + web). A **custom MCP server** running on the user's **home PC** is the bridge: it owns all Notion I/O and — critically — runs the v5 **deterministic engine in code** (state machine, streak rule, `Due` interval math). The chat-Claude only ever judges `score` + `gap_notes` and authors generated content; it never computes scheduling/state. This preserves v5's core principle ("anything that's a lookup is computed in code, not by the model").

---

## 2. Architecture (decided)

**Option B — MCP server + thin project prompt.** (Option A, "pure prompt + Notion connector with the model doing the math," was rejected because it abandons v5's determinism.)

```
 Claude Android app / web
        │  (user chats in a Project)
        ▼
 Anthropic cloud  ── makes MCP tool calls from THE CLOUD ──┐
        ▲                                                  │
        │ model = Claude (grading happens here)            │ public HTTPS
        │                                                  ▼
        └──────────────────────────────────────── Custom MCP server (home PC)
                                                   • deterministic v5 engine (CODE)
                                                   • Notion REST I/O
                                                   • holds Notion integration token
                                                         │
                                                         ▼
                                                   Notion workspace (2 DBs)
```

### Key facts that drove the design
- **The grading model IS Claude-in-the-chat.** So **no Anthropic API key is needed** and there's no separate API billing — it runs on the user's Claude subscription.
- **Custom remote MCP connectors do NOT require OAuth.** An **authless (`none`) connector is supported**. Static bearer tokens / `?token=` URL params are explicitly **not** supported — so the only auth choices are "authless" or "full OAuth," nothing in between. (Source: Claude connector authentication docs.)
- **Connectors work inside Projects and on mobile.** iOS/Android can *use* a connector added via claude.ai web (can't *add* new ones from the phone). Individual Pro/Max plans can add their own connectors.
- **Networking gotcha:** when the user taps a question on their phone, the phone talks to Anthropic's cloud, and **Anthropic's servers** make the MCP call — NOT the phone. Therefore the home server **must have a public HTTPS endpoint**. A private Tailscale tailnet does **not** work (Anthropic's servers aren't on it). Tailscale **Funnel** (public `*.ts.net` URL) does.

### Exposure decision
The home server needs a public HTTPS URL by *some* means. **Tailscale Funnel** is the chosen default (user already uses Tailscale; TLS + no port-forwarding). Interchangeable alternatives if ever wanted: Cloudflare Tunnel, ngrok, or port-forward+DuckDNS+Caddy. Escape hatch: host the MCP server on a cloud box (Fly.io/Render/Railway/VPS) — then no tunnel, but the Notion token lives in the cloud instead of on the user's hardware.

---

## 3. Decisions locked in

| Decision | Choice | Notes |
|---|---|---|
| Interface | Claude Project (chat), Android + web | Driven by project instruction prompt |
| Architecture | Option B: custom MCP server | Keeps v5 in-code determinism |
| DB creation | Code (one-time setup script) | Repeatable, version-controlled |
| Language/runtime | **TypeScript** on Node 22 | Node already installed |
| Server location | Home PC | User's hardware holds the Notion token |
| Public exposure | **Tailscale Funnel** | Public `*.ts.net` HTTPS URL |
| Connector auth | **Authless to start**, OAuth later | Single-user, low-stakes; behind random Funnel URL |
| Anthropic API key | **Not used** | Model is the chat client |

---

## 4. Environment (verified on this PC, 2026-06-16)

- **Node** v22.22.3 / **npm** 10.9.8 — ✅ installed
- **Python** — ❌ not installed (not needed)
- **git** 2.51.2.windows.1 — ✅ (repo not yet initialized)
- OS: Windows 10 IoT Enterprise LTSC 2021. Shell: PowerShell primary; Bash tool available.
- Project dir: `c:\Users\Connie\Projects\claude-quiz`

---

## 5. What's needed from the user / PC

| # | Item | Status |
|---|---|---|
| 1 | Notion integration token | ✅ user has it (used for v5 validation) |
| 2 | Both DBs created + **shared with the integration** | ⬜ setup script creates; user clicks "share to integration" once each |
| 3 | Claude **Pro/Max** plan (needed to add a custom connector) | ⬜ confirm |
| 4 | Node 22 | ✅ |
| 5 | **Tailscale on the PC, Funnel + MagicDNS/HTTPS enabled** in tailnet admin | ⬜ user enables |
| 6 | PC stays on while remote access is wanted | ⬜ homelab reality |
| 7 | Anthropic API key | ❌ not needed |

**Secrets handling:** Notion token in a gitignored `.env`. Never commit it; never put it in the spec or any tracked file.

---

## 6. MCP tool surface (the contract)

The chat-Claude is kept "thin" — it calls these tools and supplies only judgment/content. All scheduling/state math is server-side.

| Tool | Model supplies | Server does |
|---|---|---|
| `get_topic(topic)` | topic name/id | Read Topics row → Level, Weak Areas, Last Quizzed, counts, Profile Block ID |
| `get_profile(block_id)` | block id | (Conditional) read the Profile Callout block |
| `get_due_questions(topic)` | topic id | Query Question Bank `Topic = X AND Due on_or_before today` → Prompt + Prompt Continued + Rubric. **Filters on the real `Due` Date property, never a formula.** |
| `submit_evaluation(question_id, score, gap_notes)` | score (1–5) + gap_notes only | Run state machine + streak rule; compute `Due = Last Asked + interval` (date-only ISO); write Last Score, Status, Last Asked, Due, Times Asked +1, Streak, Gap Notes (clamped, overwrite), Gap History (prepend+prune) |
| `create_question(topic, title, prompt, rubric, difficulty)` | generated content | Titles-only dedup (use Title property's **internal ID**), insert with `Source=Generated`, `Status=New`, `Due=today` |
| `update_topic(topic, weak_areas?, profile_summary?)` | compressed content (gated) | Overwrite Weak Areas; char-guard + boundary-safe two-object split; PATCH the Profile Callout by stored Block ID |

A separate **one-time setup script** (not an MCP tool) creates the two DBs and prints their IDs + the Title property internal ID.

---

## 7. v5 invariants the engine MUST honor (don't regress these)

- **Filter scheduling on the written `Due` Date property** — NOT on any formula. (Notion API in this workspace returns `400 "Unable to filter based on a formula of unknown type"` for *any* formula filter — validated empirically; see spec §Validation log.) Formulas (`Level`, `Next Review`) are **display/read-only**.
- **Compute `Due` from the NEW Status and NEW Streak** (after applying state machine + streak rule), not the old ones.
- **Write date-only ISO (`YYYY-MM-DD`)** for `Due`, `Last Asked`, `Last Quizzed` — prevents time-creep (Edge A).
- **Interval table:** New/reset → today; Weak → +1d; Shaky → +3d; Mastered → +14×Streak days. (Optional easing: `14×max(Streak−1,1)`.)
- **State machine:** reaching Mastered needs two clean reps (New/Weak → Shaky → Mastered). Score 3 → Shaky from any status (demote from Mastered). See spec table.
- **Streak:** score 1–3 → 0; score 4–5 → +1.
- **Gap Notes** overwritten (≤150 chars, clamp in code). **Gap History** = capped ring buffer (~3), read-prepend-prune-write — the one deliberate exception to overwrite-only.
- **Char-guard:** Callout summary split across **two rich-text objects**, split on a word/sentence boundary, code-side length check (~1,900) before PATCH.
- **Dedup:** titles-only query via the Title property's **internal ID** (not the string `"Title"`).
- **No atomicity:** writes aren't transactional; guard against double-fire of `submit_evaluation` (ignore a second identical call in the same question turn) or accept double-count.

---

## 8. Build sequence

1. **Scaffold** — `git init`, TS Node project, deps: `@notionhq/client` + an MCP server SDK (Streamable HTTP transport). `.env` (gitignored) for `NOTION_TOKEN`. `.gitignore`, `tsconfig`, npm scripts.
2. **One-time setup script** — creates Topics DB + Question Bank DB to exact v5 schema (Due Date prop, rollups, display-only formulas). Prints DB IDs + Title property internal ID. User then shares both DBs with the integration.
3. **Deterministic engine (v5 core)** — state machine, streak rule, `Due`/interval math, date-only ISO, gap-history ring buffer, char-guard split. Pure functions, unit-testable.
4. **MCP tool surface** — implement the §6 tools wrapping the engine + Notion client.
5. **Expose** — run server; `tailscale funnel` it; capture the public URL.
6. **Wire to Claude** — add URL as custom connector (authless); create Project; paste instruction prompt (1–5 anchors + 7-step workflow + "never compute state, always call the tools").
7. **Seed + dry-run** — add a couple topics/questions; take a test quiz from web *and* Android; confirm `Due` advances correctly.

Phases 1–4 are the real engineering; 5–7 are wiring.

---

## 9. Open items / next decision

- Confirm Claude **Pro/Max** plan (item 5.3).
- Pick the **MCP server SDK** at scaffold time (TypeScript MCP SDK with Streamable HTTP).
- **Immediate next step when building resumes:** Phase 1 (scaffold) + Phase 2 (DB setup script). Alternative the user was offered: draft the full instruction prompt + tool spec first for review before any code.

---

## 10. Sources (Claude connector facts)

- Get started with custom connectors (remote MCP) — https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Connector authentication docs (authless supported; no static tokens) — https://claude.com/docs/connectors/building/authentication
- Deploying custom agents on Claude.ai and mobile — https://medium.com/@george.vetticaden/the-missing-mcp-playbook-deploying-custom-agents-on-claude-ai-and-claude-mobile-05274f60a970
