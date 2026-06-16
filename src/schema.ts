/**
 * Canonical property names for the two Notion databases (v5 schema).
 * One source of truth shared by the setup script and the runtime tools so a
 * rename can't silently desync reads/writes from what setup created.
 */

export const TOPIC_PROP = {
  Topic: "Topic", // title
  Category: "Category", // select
  LastQuizzed: "Last Quizzed", // date
  WeakAreas: "Weak Areas", // rich_text
  Status: "Status", // select (Active/Paused)
  ProfileBlockId: "Profile Block ID", // rich_text
  AvgScore: "Avg Score", // rollup (display)
  MasteredCount: "Mastered Count", // rollup, filtered (display)
  WeakCount: "Weak Count", // rollup, filtered (display)
  TotalQuestions: "Total Questions", // rollup (display)
  Level: "Level", // formula (display)
} as const;

export const QUESTION_PROP = {
  Question: "Question", // title (dedup key)
  Prompt: "Prompt", // rich_text
  PromptContinued: "Prompt Continued", // rich_text
  Rubric: "Rubric", // rich_text
  Topic: "Topic", // relation -> Topics DB
  Difficulty: "Difficulty", // select
  Status: "Status", // select (New/Weak/Shaky/Mastered)
  Streak: "Streak", // number
  GapHistory: "Gap History", // rich_text (ring buffer)
  TimesAsked: "Times Asked", // number
  LastAsked: "Last Asked", // date
  LastScore: "Last Score", // number
  GapNotes: "Gap Notes", // rich_text
  Source: "Source", // select (Manual/Generated)
  Due: "Due", // date — scheduling source of truth
  NextReview: "Next Review", // formula (display-only)
} as const;

export const TOPIC_CATEGORIES = ["Technical", "Behavioral"];
export const TOPIC_STATUSES = ["Active", "Paused"];
export const QUESTION_STATUSES = ["New", "Weak", "Shaky", "Mastered"];
export const DIFFICULTIES = ["Easy", "Medium", "Hard"];
export const SOURCES = ["Manual", "Generated"];

/** Simple, New-guarded Level formula (display-only — never filtered). */
export const LEVEL_FORMULA = `round(if(empty(prop("${TOPIC_PROP.AvgScore}")), 1, prop("${TOPIC_PROP.AvgScore}")))`;

/** Display-only Next Review formula — mirrors the in-code interval table. Never filtered. */
export const NEXT_REVIEW_FORMULA = [
  `if(prop("${QUESTION_PROP.Status}") == "New", now(),`,
  `if(empty(prop("${QUESTION_PROP.LastAsked}")), now(),`,
  `dateAdd(prop("${QUESTION_PROP.LastAsked}"),`,
  `if(prop("${QUESTION_PROP.Status}") == "Mastered", 14 * max(prop("${QUESTION_PROP.Streak}"), 1),`,
  `if(prop("${QUESTION_PROP.Status}") == "Shaky", 3,`,
  `if(prop("${QUESTION_PROP.Status}") == "Weak", 1, 0))),`,
  `"days")))`,
].join(" ");
