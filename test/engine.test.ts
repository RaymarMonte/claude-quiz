import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextStatus,
  nextStreak,
  intervalDays,
  computeDue,
  addDays,
  todayISO,
  clampGapNotes,
  pushGapHistory,
  clampProfile,
  splitForCallout,
  type Status,
  type Score,
} from "../src/engine.ts";

test("state machine matches the v5 table", () => {
  // [oldStatus][score] -> expected
  const table: Record<Status, Record<Score, Status>> = {
    New: { 1: "Weak", 2: "Weak", 3: "Shaky", 4: "Shaky", 5: "Shaky" },
    Weak: { 1: "Weak", 2: "Weak", 3: "Shaky", 4: "Shaky", 5: "Shaky" },
    Shaky: { 1: "Weak", 2: "Weak", 3: "Shaky", 4: "Mastered", 5: "Mastered" },
    Mastered: { 1: "Weak", 2: "Weak", 3: "Shaky", 4: "Mastered", 5: "Mastered" },
  };
  for (const old of Object.keys(table) as Status[]) {
    for (const s of [1, 2, 3, 4, 5] as Score[]) {
      assert.equal(nextStatus(old, s), table[old][s], `${old} + ${s}`);
    }
  }
});

test("reaching Mastered requires two clean reps", () => {
  let status: Status = "New";
  status = nextStatus(status, 5); // New -> Shaky
  assert.equal(status, "Shaky");
  status = nextStatus(status, 5); // Shaky -> Mastered
  assert.equal(status, "Mastered");
});

test("streak rule: 1-3 reset, 4-5 increment", () => {
  assert.equal(nextStreak(5, 1), 0);
  assert.equal(nextStreak(5, 3), 0);
  assert.equal(nextStreak(0, 4), 1);
  assert.equal(nextStreak(3, 5), 4);
  // defensive: non-finite / negative prior streak treated as 0
  assert.equal(nextStreak(NaN, 4), 1);
  assert.equal(nextStreak(-2, 4), 1);
});

test("interval table", () => {
  assert.equal(intervalDays("New", 0), 0);
  assert.equal(intervalDays("Weak", 0), 1);
  assert.equal(intervalDays("Shaky", 0), 3);
  assert.equal(intervalDays("Mastered", 1), 14);
  assert.equal(intervalDays("Mastered", 3), 42);
});

test("interval easing option", () => {
  assert.equal(intervalDays("Mastered", 1, { easing: true }), 14); // max(0,1)=1 -> 14
  assert.equal(intervalDays("Mastered", 2, { easing: true }), 14); // max(1,1)=1 -> 14
  assert.equal(intervalDays("Mastered", 3, { easing: true }), 28); // max(2,1)=2 -> 28
});

test("addDays does UTC math, returns date-only ISO", () => {
  assert.equal(addDays("2026-06-16", 1), "2026-06-17");
  assert.equal(addDays("2026-06-16", 14), "2026-06-30");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.throws(() => addDays("2026-06-16T00:00:00Z", 1));
});

test("computeDue uses the NEW status/streak", () => {
  // A just-mastered question with streak 2 schedules 28 days out, not the prior interval.
  assert.equal(computeDue("2026-06-16", "Mastered", 2), "2026-07-14");
  assert.equal(computeDue("2026-06-16", "Weak", 0), "2026-06-17");
  assert.equal(computeDue("2026-06-16", "Shaky", 0), "2026-06-19");
});

test("computeDue: New/reset is due today", () => {
  assert.equal(computeDue("2026-06-16", "New", 0), "2026-06-16");
  assert.equal(computeDue("2026-01-01", "New", 0, { today: "2026-06-16" }), "2026-06-16");
});

test("todayISO is date-only", () => {
  assert.match(todayISO(new Date("2026-06-16T23:30:00")), /^\d{4}-\d{2}-\d{2}$/);
});

test("clampGapNotes caps at 150 chars on a word boundary", () => {
  const long = "indexing ".repeat(40); // 360 chars
  const out = clampGapNotes(long);
  assert.ok(out.length <= 150, `len=${out.length}`);
  assert.ok(!out.endsWith("index"), "should not cut mid-word");
  assert.equal(clampGapNotes("  short note  "), "short note");
});

test("pushGapHistory prepends newest-first and prunes to cap", () => {
  let h = pushGapHistory("", "missed indexing");
  h = pushGapHistory(h, "wrong join order");
  h = pushGapHistory(h, "no partitioning");
  assert.deepEqual(h.split("\n"), ["no partitioning", "wrong join order", "missed indexing"]);
  h = pushGapHistory(h, "forgot WHERE");
  assert.equal(h.split("\n").length, 3);
  assert.equal(h.split("\n")[0], "forgot WHERE");
  assert.ok(!h.includes("missed indexing"), "oldest pruned");
});

test("clampProfile truncates at a sentence boundary", () => {
  const text = "First sentence. " + "x".repeat(2100) + ". Tail.";
  const out = clampProfile(text);
  assert.ok(out.length <= 1900, `len=${out.length}`);
  assert.equal(clampProfile("Short profile."), "Short profile.");
});

test("splitForCallout returns one object when short", () => {
  assert.deepEqual(splitForCallout("Just a short profile."), ["Just a short profile."]);
  assert.deepEqual(splitForCallout(""), [""]);
});

test("splitForCallout splits long text into two boundary-safe objects", () => {
  const sentence = "The user keeps missing indexing strategy. ";
  const text = sentence.repeat(70); // ~2940 chars, well over 2000
  const parts = splitForCallout(text);
  assert.equal(parts.length, 2);
  for (const p of parts) assert.ok(p.length <= 2000, `object len=${p.length}`);
  // Reassembled (modulo trimmed whitespace at the split) preserves content length closely.
  assert.ok(parts[0]!.length > 0 && parts[1]!.length > 0);
  // The split must not land mid-word: both parts end/start on whole words.
  assert.ok(!/\w$/.test(parts[0]!) || parts[0]!.endsWith("indexing") || /[.!?]$/.test(parts[0]!));
});
