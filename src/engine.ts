/**
 * Deterministic v5 engine — the core of the system.
 *
 * Everything here is a pure function with no I/O. The chat-Claude never computes
 * any of this; it only ever supplies `score` + `gap_notes`. These functions own
 * the state machine, streak rule, `Due`/interval math, date-only ISO handling,
 * the Gap History ring buffer, and the Callout char-guard split.
 *
 * v5 invariants honored here (see BUILD-PLAN §7 / spec §Rules):
 *  - Compute `Due` from the NEW status and NEW streak (post-machine), never the old ones.
 *  - All dates are date-only ISO (YYYY-MM-DD) — midnight-anchored, no time-creep (Edge A).
 *  - Gap Notes overwritten + clamped ≤150 chars. Gap History = capped ring buffer.
 *  - Callout summary split across two rich-text objects on a word/sentence boundary.
 */

export type Status = "New" | "Weak" | "Shaky" | "Mastered";
export type Score = 1 | 2 | 3 | 4 | 5;

export const GAP_NOTES_MAX = 150;
export const GAP_HISTORY_CAP = 3;
export const PROFILE_MAX_CHARS = 1900;
export const RICH_TEXT_OBJECT_MAX = 2000;

/**
 * Status state machine (old Status + Score -> new Status).
 * Reaching Mastered requires two clean reps (New/Weak -> Shaky -> Mastered).
 * Score 3 lands on Shaky from any prior status (a demote from Mastered).
 */
export function nextStatus(oldStatus: Status, score: Score): Status {
  if (score <= 2) return "Weak";
  if (score === 3) return "Shaky";
  // score 4-5
  return oldStatus === "Shaky" || oldStatus === "Mastered" ? "Mastered" : "Shaky";
}

/**
 * Streak rule.
 *  - Score 1-3 -> 0 (lapse / no advance resets spacing)
 *  - Score 4-5 -> current + 1
 */
export function nextStreak(oldStreak: number, score: Score): number {
  const base = Number.isFinite(oldStreak) && oldStreak > 0 ? Math.floor(oldStreak) : 0;
  return score >= 4 ? base + 1 : 0;
}

/**
 * Interval in days for the NEW status/streak.
 *  - New (or manual reset) -> 0 (due today)
 *  - Weak -> 1 day
 *  - Shaky -> 3 days
 *  - Mastered -> 14 * Streak days (optional easing: 14 * max(Streak-1, 1))
 */
export function intervalDays(
  newStatus: Status,
  newStreak: number,
  opts: { easing?: boolean } = {}
): number {
  switch (newStatus) {
    case "New":
      return 0;
    case "Weak":
      return 1;
    case "Shaky":
      return 3;
    case "Mastered": {
      const streak = Math.max(1, Math.floor(newStreak) || 1);
      const multiplier = opts.easing ? Math.max(streak - 1, 1) : streak;
      return 14 * multiplier;
    }
  }
}

// ---- Date-only ISO helpers (all midnight-anchored, UTC math) --------------

/** Today as date-only ISO (YYYY-MM-DD) in the given timezone offset-free local sense. */
export function todayISO(now: Date = new Date()): string {
  // Use the local calendar date, then format as date-only. Local date is what a
  // human in this timezone calls "today" — matches how Notion shows date-only props.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Add `days` to a date-only ISO string, returning date-only ISO. UTC math avoids DST drift. */
export function addDays(isoDate: string, days: number): string {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`addDays expects date-only ISO (YYYY-MM-DD), got: ${isoDate}`);
  }
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Compute `Due` (date-only ISO) from the NEW status + NEW streak.
 * New/reset rows are due today; everything else is lastAsked + interval.
 * `lastAsked` is "today" at write time, so non-New rows resolve to today + interval.
 */
export function computeDue(
  lastAskedISO: string,
  newStatus: Status,
  newStreak: number,
  opts: { easing?: boolean; today?: string } = {}
): string {
  if (newStatus === "New") return opts.today ?? lastAskedISO;
  return addDays(lastAskedISO, intervalDays(newStatus, newStreak, opts));
}

// ---- Gap Notes / Gap History ----------------------------------------------

/** Clamp gap notes server-side (the model's maxLength is guidance, not a guarantee). */
export function clampGapNotes(notes: string, max: number = GAP_NOTES_MAX): string {
  const trimmed = (notes ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  // Truncate at a word boundary where possible, then hard-cap.
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Gap History ring buffer: prepend the new (clamped) note, prune to `cap`, newest first.
 * Stored as newline-separated text. The one deliberate exception to overwrite-only.
 */
export function pushGapHistory(
  existing: string | null | undefined,
  newNote: string,
  cap: number = GAP_HISTORY_CAP
): string {
  const note = clampGapNotes(newNote);
  const prior = (existing ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [note, ...prior].slice(0, Math.max(1, cap)).join("\n");
}

// ---- Callout char-guard ----------------------------------------------------

/** Truncate a profile summary at a sentence/word boundary if it exceeds the guard. */
export function clampProfile(summary: string, max: number = PROFILE_MAX_CHARS): string {
  const text = (summary ?? "").trim();
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  // Prefer a sentence boundary, then a word boundary, else a hard cut.
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? ")
  );
  if (sentenceEnd > max * 0.5) return window.slice(0, sentenceEnd + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? window.slice(0, lastSpace) : window).trim();
}

/**
 * Split a (already clamped) summary across up to two rich-text objects for the Callout
 * PATCH. Splits on a word/sentence boundary near the midpoint, never mid-word. Returns
 * 1 or 2 non-empty strings. Each object is guaranteed <= RICH_TEXT_OBJECT_MAX.
 */
export function splitForCallout(
  summary: string,
  perObjectMax: number = RICH_TEXT_OBJECT_MAX
): string[] {
  const text = (summary ?? "").trim();
  if (text.length === 0) return [""];
  if (text.length <= perObjectMax) return [text];

  // Aim to split near the midpoint, preferring a sentence boundary, then a space.
  const mid = Math.floor(text.length / 2);
  const lower = Math.floor(text.length * 0.25);
  const upper = Math.min(text.length - 1, Math.ceil(text.length * 0.75), perObjectMax - 1);

  const boundaries: number[] = [];
  for (let i = lower; i <= upper; i++) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") boundaries.push(i + 1);
  }
  let splitAt = pickClosest(boundaries, mid);
  if (splitAt < 0) {
    // No sentence boundary in range — fall back to the nearest space.
    const spaces: number[] = [];
    for (let i = lower; i <= upper; i++) if (text[i] === " ") spaces.push(i);
    splitAt = pickClosest(spaces, mid);
  }
  if (splitAt < 0) splitAt = Math.min(perObjectMax, mid); // last resort: hard split

  const part1 = text.slice(0, splitAt).trim();
  const part2 = text.slice(splitAt).trim();
  return part2.length === 0 ? [part1] : [part1, part2];
}

function pickClosest(candidates: number[], target: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(c - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}
