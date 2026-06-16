# 🧠 Autonomous Quiz System — Design Spec (v4)

A two-database Notion system for spaced-repetition interview/skill prep, driven by Claude. Optimized for **autonomy** (the model never computes scheduling or state on the fly), **token efficiency** (property-level reads/writes, no block surgery), and **determinism** (anything that's a lookup is computed in code, not by the model).

---

## Changes since v3

- **Next Review formula** — added an explicit `Status == "New" → now()` guard (Edge D) so a manually-reset row with a stale `Last Asked` still surfaces as due regardless of the empty-check.
- **Time-creep killed at the source** (Edge A) — code writes `Last Asked` as a **date-only ISO string** (`YYYY-MM-DD`), never a datetime. This midnight-anchors every derived interval; no formula change is needed for it.
- **Level formula** — guarded against `round(empty)` on a fresh topic where every question is still `New` and `Avg Score` is empty.
- **Rubric** (Edge B) — new per-question grading ground-truth so the score is anchored to fixed criteria instead of the model's parametric knowledge. Optional, with graceful fallback.
- **Score anchors** (Edge C) — standardized 1–5 definitions moved into the system prompt; the state machine pivots entirely on this number, so it must mean the same thing every session.
- **Gap-notes / pattern-synthesis tension resolved** — `Gap Notes` stays overwrite-only, but an optional **capped `Gap History` ring buffer** restores the longitudinal signal that recurring-mistake detection actually needs. `Weak Areas` synthesis language is re-scoped to be honest about what data it sees.
- **API notes** — `filter_properties` requires the internal Title **property ID**; concrete callout PATCH payload with boundary-split; a validation step (with a written-`Due` fallback) for `now()`-based date filtering; explicit non-atomic-write / idempotency caveat.

---

## Database 1: 🗺️ Topics DB (the map + profiles)

One row per topic.

| Property | Type | Notes |
|---|---|---|
| **Topic** | Title | e.g. "SQL", "System Design" |
| **Category** | Select | Technical / Behavioral / … |
| **Last Quizzed** | Date | Set on every session (write **date-only** ISO) |
| **Weak Areas** | Text | Short comma list, synthesized from question gap signal (see rules) |
| **Status** | Select (optional) | Active / Paused |
| **Profile Block ID** | Text | Block ID of the single Callout block in the page body (so the AI PATCHes it directly, no child-listing) |
| **Avg Score** | Rollup | Average of `Last Score` across related questions (excl. New) |
| **Mastered Count** | Rollup | Count of related questions where `Status = Mastered` (filtered rollup) |
| **Weak Count** | Rollup | Count of related questions where `Status = Weak` (filtered rollup) |
| **Total Questions** | Rollup | Count of related questions |
| **Level** | Formula | Derived 1–5 estimate — see formula. Replaces a manual Number to prevent drift. |

### Level formula (derived, zero-write)

Guarded so a fresh topic (all questions `New`, `Avg Score` empty) renders a sane floor instead of `round(empty)`.

**Simple default:**

```
round(if(empty(prop("Avg Score")), 1, prop("Avg Score")))
```

**Weighted option** (rewards accuracy + coverage — tune weights):

```
round(min(5, max(1,
  (if(empty(prop("Avg Score")), 1, prop("Avg Score"))) * 0.6
  + (prop("Mastered Count") / max(prop("Total Questions"), 1)) * 5 * 0.4
)))
```

> If you'd rather a brand-new topic read blank than `1`, swap the fallback for `prop("Avg Score")` and accept that the cell shows empty until the first non-New answer lands.

### Topic page body = ONE Callout block (the Profile, ≤300 words)

Contents: recurring mistake patterns · concepts mastered · priorities for next sessions.

- **First line:** "Summarize, don't accumulate — compress on every update."
- Updated in place via the block PATCH endpoint using the stored **Profile Block ID**. No delete/insert.
- Read **conditionally** (only when deep context is needed), not on every lookup.
- **Char-guard** (see Vulnerability 3): a single rich-text object caps at 2,000 chars. Split the summary across **two rich-text objects** inside the same Callout so the ceiling effectively doubles while the one-Block-ID overwrite design is preserved. Also enforce a **code-side length check** before the PATCH — if combined length > ~1,900, truncate at a sentence boundary or re-summarize. The split *between the two objects* must also land on a word/sentence boundary, never mid-word. Keep "under 1,500 characters" in the system prompt as a brevity nudge, not the only guard.

---

## Database 2: 🗂️ Question Bank DB

One row per question.

| Property | Type | Notes |
|---|---|---|
| **Question** | Title | Short descriptive label, e.g. "Design Twitter — Data Model" (also the dedup key) |
| **Prompt** | Text | Full prompt, up to 2,000 chars |
| **Prompt Continued** | Text | Overflow for 2k–4k-char prompts — fetched in the same query call, no body fetch |
| **Rubric** | Text (≤2k) | **Grading ground-truth.** Key points / constraints / acceptable-answer criteria. Fed to the model at eval time alongside the prompt. Optional — see fallback. |
| **Topic** | Relation → Topics DB | Single relation |
| **Difficulty** | Select | Easy / Medium / Hard |
| **Status** | Select | New / Weak / Shaky / Mastered |
| **Streak** | Number | Consecutive good reps. Drives interval growth. Resets on lapse. |
| **Gap History** | Text (optional) | **Capped ring buffer** of the last ~3 gap notes for *this* question, newest first. Code-managed: read, prepend new note, prune to N, write. Enables per-question recurrence detection without destroying history. See note below. |
| **Times Asked** | Number | Analytics only — no longer drives intervals. Read-then-write increment. |
| **Last Asked** | Date | Set on every ask. **Write date-only ISO (`YYYY-MM-DD`)** — see Edge A. |
| **Last Score** | Number (1–5) | Most recent score |
| **Gap Notes** | Text | 1–2 lines max, **overwritten** (never appended), clamped ≤150 chars in code |
| **Source** | Select (optional) | Manual / Generated — aids dedup cleanup |
| **Next Review** | Formula | Due-date, derived from `Last Asked` + `Status` + `Streak`. Self-maintaining. |

### Next Review formula (Streak-based; New-guarded)

```
if(prop("Status") == "New", now(),
if(empty(prop("Last Asked")), now(),
  dateAdd(prop("Last Asked"),
    if(prop("Status") == "Mastered", 14 * max(prop("Streak"), 1),
    if(prop("Status") == "Shaky", 3,
    if(prop("Status") == "Weak", 1, 0))),
  "days")))
```

- **New** (by status *or* empty `Last Asked`) → `now()` → always due. The dual guard means a manually-reset row with a stale `Last Asked` still surfaces (Edge D).
- **Time-creep** (Edge A) is prevented by the *code* writing `Last Asked` as date-only ISO. With no time component, `dateAdd(..., "days")` stays midnight-anchored, so a question answered at 9 PM is due first thing the next due-day, not 9 PM-and-drifting-later. No `formatDate` wrapping is required if the write is clean; if you can't guarantee a date-only write, wrap the `Last Asked` references in a date-stripping formula instead.
- **Mastered** interval is linear in `Streak` (14 / 28 / 42 …) — deliberately tame for time-boxed interview prep; avoids the multi-month intervals geometric ease factors produce.
- *Optional:* use `14 * max(prop("Streak") - 1, 1)` if you want the first post-relearn Mastered rep to return to 14d rather than jumping to 28d. (This also softens the Mastered→3→Shaky recovery cost — see the sensitivity note in Rules.)

| Status | Next Review = Last Asked + |
|---|---|
| New | due now |
| Weak | 1 day |
| Shaky | 3 days |
| Mastered | 14 × Streak days |

---

## Rules (deterministic — computed in CODE, not by the model)

The model only ever judges two things: **the score and the gap notes.** Everything below is a lookup the code performs after the tool call, eliminating an entire class of LLM lookup-table errors.

### Status state machine (old Status + Score → new Status)

The Status bucket is the memory; reaching Mastered requires two clean reps (New/Weak → Shaky → Mastered).

| Old Status | Score 1–2 | Score 3 | Score 4–5 |
|---|---|---|---|
| **New** | Weak | Shaky | Shaky |
| **Weak** | Weak | Shaky | Shaky |
| **Shaky** | Weak | Shaky | Mastered |
| **Mastered** | Weak | Shaky (demote) | Mastered |

> **Sensitivity note:** a single Mastered→3 demotes to Shaky and then needs two clean reps to re-Master (~17+ days minimum). For interview prep that's arguably correct — don't trust a wobble — but you'll feel it on a bad grinding day. The optional `14 * max(Streak - 1, 1)` interval above eases re-entry.

### Streak rule

- Score 1–3 → `Streak = 0` (lapse / no advance resets spacing)
- Score 4–5 → `Streak = current + 1`
- New questions default `Streak = 0`.

### Other code-derived writes (per answer)

`Last Score` = score · `Last Asked` = today (**date-only ISO**) · `Times Asked += 1` (read-then-write) · `Gap History` prepend+prune (if enabled) · `Next Review` & `Level` recompute themselves via formula.

### Gap Notes vs. Gap History — what actually retains signal

`Gap Notes` is **last-write-wins** (one line, overwritten) — cheap and current, but it destroys longitudinal material on every write. That means pure `Gap Notes` cannot, on its own, support genuine "recurring mistake" detection: at any instant each question holds exactly one note, so the only cross-time signal is whatever's in the session context plus the lossy Profile summary.

Two honest options:

1. **Default (lean):** accept that `Weak Areas` synthesis is **session-scoped + profile-informed**, not a true mining of historical mistakes. Don't over-claim it.
2. **Upgrade (recommended if you want real recurrence):** enable the optional **`Gap History`** ring buffer (last ~3 notes per question, capped). This is a *bounded* read-then-write append — a deliberate, size-limited exception to the otherwise-overwrite philosophy, placed exactly where longitudinal signal is needed. Per-question recurrence ("user keeps missing indexing on this one") becomes detectable without unbounded growth.

### Weak Areas synthesis (Topic) — gated

On a Topic write: scan the **current `Gap Notes` of the topic's questions** (and their `Gap History`, if enabled), extract recurring themes, and **overwrite** `Weak Areas` as a compressed comma list. Never append. Be honest in the prompt about the scope of what's being scanned.

### Profile body update — gated

Only when something pattern-worthy emerged. Overwrite the single Callout block in place; recompress to ≤300 words; obey the char-guard (including the boundary-safe split between the two rich-text objects).

### Question generation + dedup

Before inserting a generated question, query existing questions for that Topic **fetching titles only** (see Vulnerability 2) and skip/merge near-duplicates by label. When generating, produce **Prompt (+ Prompt Continued if needed) + Rubric together** so the new question is gradeable from day one. Tag new ones `Source = Generated`.

> **Caveat:** title-only dedup catches lexical repeats, not semantic twins ("Twitter timeline" vs "feed fanout"). Acceptable trade for a cheap guard.

---

## Grading: Rubric + score anchors (the model's only real freedom)

Because the entire state machine pivots on the 1–5 score, the score must mean the same thing every session. Two mechanisms keep it stable:

### Per-question Rubric (in the data)

When a question is queried, feed the model **Prompt + Prompt Continued + Rubric**. The eval instruction becomes: *"Evaluate the user's answer against this Rubric. Credit valid alternative approaches that satisfy the same key points; do not invent requirements the Rubric doesn't state."* This anchors grading to fixed criteria and curbs both penalizing-unconventional-but-correct answers and hallucinating requirements.

- **Optional with graceful fallback:** if `Rubric` is empty (e.g. an un-annotated manual question), the model grades on general principles for that domain. Behavioral questions often need no rubric; system-design / technical questions benefit most.
- **No extra call:** `Rubric` rides along in the same query that already pulls `Prompt` + `Prompt Continued`. The only cost is a modest prompt-token increase, which buys reproducibility.
- **Generated questions:** the rubric is itself model-authored, so it's only as good as generation — but it still guarantees the *same* criteria are applied on every future review of that question.

### Standardized 1–5 anchors (in the system prompt)

| Score | Meaning |
|---|---|
| **5** | Perfect. Hit all constraints / rubric points with no hints. |
| **4** | Great. Minor gaps or hesitation, fundamentally correct. |
| **3** | Shaky. Needed major hints, or missed a core requirement. *(Lands on Shaky from every prior status — a demote from Mastered — and resets Streak to 0.)* |
| **2** | Weak. Fundamentally flawed approach, some understanding shown. |
| **1** | Blank or completely incorrect. |

> Note: `1` currently merges "skipped/blank" and "confident-but-wrong." If you later want to distinguish avoidance from misconception, split these — but it's fine to leave merged for a single-user tool.

---

## Tools (two-tool split)

### `submit_evaluation` — the lean per-question write path

Only the score and notes; the model judges nothing else. Status/Streak/dates are derived in code afterward.

```json
{
  "name": "submit_evaluation",
  "description": "Record the user's score and gap notes for the current question. Status, streak, dates and counts are computed by the application — do NOT supply them. Gap notes are written fresh each time and overwrite the previous notes.",
  "input_schema": {
    "type": "object",
    "properties": {
      "score": {"type": "integer", "enum": [1,2,3,4,5]},
      "gap_notes": {"type": "string", "maxLength": 150,
        "description": "1-2 lines MAX on what was missed. Written fresh; do not echo prior notes."}
    },
    "required": ["score", "gap_notes"]
  }
}
```

**Enforcement lives in code, not the prompt:**

- Derive `new_status` (state machine), `new_streak` (streak rule), `last_asked` (**date-only ISO**), `times_asked += 1`.
- If `Gap History` enabled: prepend the new note, prune to N, write.
- Clamp `gap_notes` server-side (`maxLength`/`enum` are model guidance, not guaranteed validation).
- **Overwrite by construction:** setting the `Gap Notes` property value replaces it — appending is impossible by how the PATCH is built.

### `update_topic` — gated, separate

Fires only when something pattern-worthy emerged, so the per-question path stays cheap.

```json
{
  "name": "update_topic",
  "description": "Update the topic-level profile when a recurring pattern emerged this session. Call sparingly. Weak Areas and the profile summary are OVERWRITTEN (compressed), never appended.",
  "input_schema": {
    "type": "object",
    "properties": {
      "weak_areas": {"type": "string", "maxLength": 200,
        "description": "Comma list, compressed. Overwrites the existing value."},
      "profile_summary": {"type": "string", "maxLength": 1500,
        "description": "≤300 words. Overwrites the Callout block. Summarize, don't accumulate."}
    },
    "required": []
  }
}
```

Code clamps `profile_summary` to the char-guard, splits across two rich-text objects **at a word/sentence boundary**, and PATCHes the stored Profile Block ID.

---

## Session workflow

1. Read Topics row for the topic → `Level`, `Weak Areas`, `Last Quizzed`, counts, `Profile Block ID`. *(1 call)*
2. Read (conditional) the Profile Callout block by stored ID — only if deep context is needed. *(0–1 call)*
3. Read Question Bank where `Topic = X` AND `Next Review` on-or-before today → due questions, including `Prompt`, `Prompt Continued`, **and `Rubric`**. If none due / want fresh, generate (titles-only dedup query; emit Prompt + Rubric). *(1 call)*
4. Ask (concatenate `Prompt` + `Prompt Continued`) → user answers → Claude evaluates **against the Rubric using the standardized anchors** → calls `submit_evaluation` with `score` + `gap_notes`.
5. Code writes the question row: `Last Score`, derived `Status`, `Last Asked` (date-only), `Times Asked +1`, derived `Streak`, `Gap Notes` (clamped, overwrite), `Gap History` (prepend+prune, if enabled). `Next Review` recomputes itself. Or create a new row if generated. *(1 call)*
6. Code writes the Topics row: `Last Quizzed = today`; `update_topic` only if pattern-worthy (Weak Areas + profile block). `Level` recomputes itself. *(0–1 call)*
7. Deliver evaluation + improvement advice.

**Typical cost:** 2–3 reads, 1–2 writes. Scheduling (`Next Review`), `Status`, `Streak`, and `Level` are all derived (formula or code), so the model writes only score + notes.

> **Atomicity / idempotency caveat:** these are 1–2 writes across two databases with **no transaction**. If the question-row write lands but the Topics write fails, you're momentarily in a split state. If the model double-fires `submit_evaluation`, `Times Asked` double-increments and `Status` advances twice. Single-user and low-stakes, so acceptable — but the write path is not atomic and re-running may double-count. Guard against accidental double-fire (e.g. ignore a second identical call within the same question turn) if you care.

---

## API / limit notes

- **`filter_properties` (titles-only dedup):** pass the **internal property ID** of the Title property, *not* the string `"Title"`. Grab the ID once via a standard database query (it's stable). The query then returns only that property, keeping dedup reads cheap.
- **Filtered rollups** (Mastered/Weak counts) are supported natively; the API returns the computed value on read.
- **`now()`-based date filtering is load-bearing — validate it before trusting it.** The whole "New → always due" and "interval elapsed → surfaces automatically" behavior depends on `formula.date.on_or_before` (today's ISO date) correctly evaluating a `now()`/`dateAdd`-based formula *at query time*. Notion's `now()` recomputes lazily and date-formula filtering via the API has historically been flaky. **Test it:** create a question whose computed `Next Review` is yesterday, wait, run the filtered query without touching the row, and confirm it surfaces. If it doesn't, fall back to a **written `Due` date** property (code writes `Last Asked + interval` at evaluation time) and filter on that instead — costs one extra computed write but restores deterministic, queryable due-dates.
- **No atomic increment** — `Times Asked` (and the `Gap History` prune) are read-then-write (safe for single-user; see idempotency caveat above).
- **2,000-char limit** applies per Title, per rich-text property, **and per rich-text object in a block.** Hence `Prompt` + `Prompt Continued` (≈4k total in the query call) and the two-object Callout split. Reserve the page body for true case studies needing images/tables.
- **Callout PATCH payload shape** (two-object, boundary-split):

```json
{
  "callout": {
    "rich_text": [
      { "text": { "content": "Summary part 1… (≤1999 chars, split on a space or period)" } },
      { "text": { "content": "Summary part 2… (remaining chars)" } }
    ]
  }
}
```

Split between the two `content` strings at a space or sentence boundary, never mid-word, to avoid mangled output.
- **Query truncation:** relation/rollup/rich-text arrays cap at 25 items per query response; irrelevant here.
- **Date writes:** write **date-only ISO (`YYYY-MM-DD`)** for `Last Asked` and `Last Quizzed` to prevent time-creep (Edge A). Reserve full datetimes for properties that genuinely need a time.
