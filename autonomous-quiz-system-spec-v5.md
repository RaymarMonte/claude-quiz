# 🧠 Autonomous Quiz System — Design Spec (v5)

A two-database Notion system for spaced-repetition interview/skill prep, driven by Claude. Optimized for **autonomy** (the model never computes scheduling or state on the fly), **token efficiency** (property-level reads/writes, no block surgery), and **determinism** (anything that's a lookup is computed in code, not by the model).

---

## Changes since v4

> **The big one — the `now()`-filter go/no-go was run, and it failed.** This drove the only structural change in v5: scheduling is now queried off a **code-written `Due` date**, not a formula.

- **Empirical result: formula filtering is unusable via the API in this workspace.** The v4 spec flagged `now()`-based date filtering as load-bearing and said to validate it. It was validated against a live workspace (internal integration, REST API, `Notion-Version: 2022-06-28`). Every formula-property filter — the v4 `Next Review` formula, a bare `now()`, a bare `dateAdd`, and even a boolean `is_due` checkbox formula — returned `400 "Unable to filter based on a formula of unknown type"`. A control filter on a **real Date property worked perfectly**, and opening the database in the Notion UI to force type resolution **did not** fix it. See the [Validation log](#validation-log-the-nowfilter-test) for the full battery.
  - This is *worse but cleaner* than the lazy-`now()` flakiness v4 anticipated: it's not intermittent, it's total. The API cannot filter on **any** formula here, so neither the date-formula nor a boolean-formula workaround is viable.
- **`Due` (written Date property) is now the scheduling source of truth** in the Question Bank DB. Code writes `Due = Last Asked + interval` (date-only ISO) on every evaluation; New/reset rows get `Due = today`. Step 3 of the workflow filters on `Due`, which is a proven-filterable real Date property.
- **`Next Review` formula demoted to display-only.** It stays in the schema as a human-readable convenience in the Notion UI (and as living documentation of the interval math), but **nothing queries it**. It may be dropped entirely with no behavioral impact.
- **Write-path cost** rises by exactly one property write (`Due`), as v4's fallback predicted. It's free in engineering terms: the code already computes the interval to know the status/streak, so it already holds everything `Due` needs.
- Everything else from v4 (rubric, score anchors, gap history ring buffer, char-guard split, idempotency caveat, titles-only dedup) is unchanged.

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
| **Level** | Formula | Derived 1–5 estimate — see formula. Replaces a manual Number to prevent drift. **Display/read only** — see formula-filtering note. |

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

> **Formula-filtering note (applies to every formula in this spec):** the API cannot filter on formula properties in this workspace (see [Validation log](#validation-log-the-nowfilter-test)). `Level` is only ever **read** (its value comes back fine on a normal query) and **displayed** in the UI — it is never used in a `filter`. If you ever need to *query* topics by level, store a written Number instead.

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
| **🆕 Due** | **Date** | **Scheduling source of truth — this is what step 3 filters on.** Code writes `Due = Last Asked + interval` (date-only ISO) on every evaluation; New/reset rows → `Due = today`. A *real* Date property because formula properties are not filterable via the API here (see [Validation log](#validation-log-the-nowfilter-test)). |
| **Next Review** | Formula | **Display-only** mirror of `Due`, derived from `Last Asked` + `Status` + `Streak`. Convenient to eyeball in the UI; **never queried.** Optional — may be dropped with zero behavioral impact. |

### Due (written Date — the queryable due-date)

`Due` is computed **in code** at evaluation time, from the same status/streak machine the code already runs, and written as a **date-only ISO** string. This is the v5 replacement for filtering on the formula.

| Status (new, post-state-machine) | Due = |
|---|---|
| New (or manual reset) | **today** (due now) |
| Weak | Last Asked + 1 day |
| Shaky | Last Asked + 3 days |
| Mastered | Last Asked + 14 × `Streak` days |

- `Last Asked` is "today" at write time (date-only ISO), so for the non-New statuses `Due = today + interval`. Writing date-only keeps everything midnight-anchored — no time-creep (Edge A).
- A manually-reset row: set `Status = New` (or clear `Last Asked`) **and** set `Due = today` so it surfaces immediately. (Edge D — the dual guard now lives in the write, not the formula.)
- *Optional easing:* use `14 × max(Streak − 1, 1)` for the Mastered interval if you want the first post-relearn Mastered rep back at 14d rather than 28d (see Rules sensitivity note).

### Next Review formula (display-only; New-guarded)

Kept verbatim from v4 as a UI convenience and as executable documentation of the interval math. **Do not filter on it.**

```
if(prop("Status") == "New", now(),
if(empty(prop("Last Asked")), now(),
  dateAdd(prop("Last Asked"),
    if(prop("Status") == "Mastered", 14 * max(prop("Streak"), 1),
    if(prop("Status") == "Shaky", 3,
    if(prop("Status") == "Weak", 1, 0))),
  "days")))
```

- This formula and `Due` should always agree (they encode the same table). If they ever diverge in the UI, `Due` is authoritative — the formula re-derives lazily and uses a datetime `now()` for the New branch.
- **Mastered** interval is linear in `Streak` (14 / 28 / 42 …) — deliberately tame for time-boxed interview prep; avoids the multi-month intervals geometric ease factors produce.

| Status | Interval (encoded in both `Due` and the display formula) |
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

`Last Score` = score · `Last Asked` = today (**date-only ISO**) · `Times Asked += 1` (read-then-write) · **`Due` = `Last Asked` + interval (date-only ISO; New/reset → today)** · `Gap History` prepend+prune (if enabled) · `Next Review` & `Level` recompute themselves via formula (display only).

> **Compute `Due` from the *new* Status and *new* Streak** (after applying the state machine and streak rule), not the old ones — otherwise a just-mastered question schedules on its prior interval.

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

Before inserting a generated question, query existing questions for that Topic **fetching titles only** (see Vulnerability 2) and skip/merge near-duplicates by label. When generating, produce **Prompt (+ Prompt Continued if needed) + Rubric together** so the new question is gradeable from day one. Tag new ones `Source = Generated`. **Set `Due = today`** on creation so a fresh question is immediately surfaceable (New status).

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

Only the score and notes; the model judges nothing else. Status/Streak/dates/**Due** are derived in code afterward.

```json
{
  "name": "submit_evaluation",
  "description": "Record the user's score and gap notes for the current question. Status, streak, dates, due-date and counts are computed by the application — do NOT supply them. Gap notes are written fresh each time and overwrite the previous notes.",
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

- Derive `new_status` (state machine), `new_streak` (streak rule), `last_asked` (**date-only ISO**), **`due` = `last_asked` + interval(new_status, new_streak), date-only ISO; New/reset → today**, `times_asked += 1`.
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
3. Read Question Bank where `Topic = X` **AND `Due` on-or-before today** → due questions, including `Prompt`, `Prompt Continued`, **and `Rubric`**. If none due / want fresh, generate (titles-only dedup query; emit Prompt + Rubric; set `Due = today`). *(1 call)*
   - **Filter shape (proven to work):** `{"and":[{"property":"Topic","relation":{"contains":"<id>"}},{"property":"Due","date":{"on_or_before":"<today ISO>"}}]}`. `Due` is a real Date property — do **not** filter on `Next Review` or any formula.
4. Ask (concatenate `Prompt` + `Prompt Continued`) → user answers → Claude evaluates **against the Rubric using the standardized anchors** → calls `submit_evaluation` with `score` + `gap_notes`.
5. Code writes the question row: `Last Score`, derived `Status`, `Last Asked` (date-only), **`Due` (date-only, recomputed)**, `Times Asked +1`, derived `Streak`, `Gap Notes` (clamped, overwrite), `Gap History` (prepend+prune, if enabled). `Next Review` & `Level` recompute themselves (display only). Or create a new row if generated (with `Due = today`). *(1 call)*
6. Code writes the Topics row: `Last Quizzed = today`; `update_topic` only if pattern-worthy (Weak Areas + profile block). `Level` recomputes itself. *(0–1 call)*
7. Deliver evaluation + improvement advice.

**Typical cost:** 2–3 reads, 1–2 writes. `Status`, `Streak`, `Due`, and `Level` are all derived (code or formula), so the model writes only score + notes. The one v5 delta from v4: `Due` is a written property, not a queried formula — same number of API calls, one extra property in the write body.

> **Atomicity / idempotency caveat:** these are 1–2 writes across two databases with **no transaction**. If the question-row write lands but the Topics write fails, you're momentarily in a split state. If the model double-fires `submit_evaluation`, `Times Asked` double-increments, `Status` advances twice, and `Due` is pushed out twice. Single-user and low-stakes, so acceptable — but the write path is not atomic and re-running may double-count. Guard against accidental double-fire (e.g. ignore a second identical call within the same question turn) if you care.

---

## API / limit notes

- **⚠️ Formula properties are NOT filterable via the API in this workspace — validated empirically (v5).** Filtering any formula property returns `400 "Unable to filter based on a formula of unknown type"`, regardless of the formula's output type (date, checkbox, …) and regardless of whether the database has been opened in the UI. **This is why scheduling moved to the written `Due` date.** Formula values still **read** back fine; you just can't put a formula in a `filter`. See the [Validation log](#validation-log-the-nowfilter-test).
- **`filter_properties` (titles-only dedup):** pass the **internal property ID** of the Title property, *not* the string `"Title"`. Grab the ID once via a standard database query (it's stable). The query then returns only that property, keeping dedup reads cheap.
- **Filtered rollups** (Mastered/Weak counts) are supported natively; the API returns the computed value on read. *(These are rollups, not formulas — reads are fine; same don't-filter-on-them caution applies if you ever need to filter.)*
- **Date filtering works on real Date properties.** Filtering `Due` (and `Last Asked`, `Last Quizzed`) via `date.on_or_before` / `before` / etc. is confirmed working. Write **date-only ISO (`YYYY-MM-DD`)** to keep comparisons midnight-anchored (Edge A).
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
- **Date writes:** write **date-only ISO (`YYYY-MM-DD`)** for `Due`, `Last Asked`, and `Last Quizzed` to prevent time-creep (Edge A). Reserve full datetimes for properties that genuinely need a time.

---

## Validation log: the `now()`-filter test

Run against a live Notion workspace via an internal integration (REST API, `Notion-Version: 2022-06-28`). A throwaway `__filter_test__` database was created under a shared page with the exact v4 schema, seeded with four probe rows, then torn down.

**Probe rows** (today = 2026-06-16):

| Row | Status | Last Asked | Computed `Next Review` | Expected to surface? |
|---|---|---|---|---|
| A | New | (empty) | `now()` (today, w/ time) | ✅ yes |
| B | Weak | 2026-06-14 | 2026-06-15 (yesterday) | ✅ yes |
| C | Shaky | 2026-06-11 | 2026-06-14 | ✅ yes |
| D | Mastered (Streak 1) | 2026-06-16 | 2026-06-30 | ❌ no (control) |

**Results:**

| Test | Outcome |
|---|---|
| Read computed `Next Review` (no filter) | ✅ All four correct |
| Filter v4 `Next Review` formula, `formula.date.on_or_before = today` | ❌ `400 "Unable to filter based on a formula of unknown type"` |
| Filter bare `now()` formula | ❌ same error |
| Filter bare `dateAdd(...)` formula | ❌ same error |
| Filter boolean `is_due` formula via `formula.checkbox` | ❌ same error |
| **Control:** filter raw `Last Asked` **Date** property, `date.on_or_before = today` | ✅ Returned B, C, D |
| Re-run all formula filters **after opening the DB in the Notion UI** | ❌ still the same error |

**Conclusion:** formula filtering is not flaky here — it is unavailable. A real Date property filters correctly. Therefore scheduling is queried off the written **`Due`** date (this spec), and all formulas are display/read-only. The v4 fallback ("written `Due` date") is now the v5 default.
