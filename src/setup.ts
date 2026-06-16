/**
 * One-time setup script (NOT an MCP tool). Creates the two Notion databases to the
 * exact v5 schema under NOTION_PARENT_PAGE_ID, then prints the IDs you paste into .env.
 *
 *   npm run setup
 *
 * Idempotency: this CREATES fresh databases every run. Run it once. If you re-run it
 * you'll get a second pair of databases — delete the extras in Notion.
 *
 * Notion API limitation handled here: filtered rollups (Mastered/Weak counts) cannot
 * have their filter set via the API. We create the rollup properties wired to the
 * relation; you add the one-click Status filter in the Notion UI (printed checklist).
 */
import { makeNotion, normalizeId } from "./notion.ts";
import { setupConfig } from "./config.ts";
import {
  TOPIC_PROP,
  QUESTION_PROP,
  TOPIC_CATEGORIES,
  TOPIC_STATUSES,
  QUESTION_STATUSES,
  DIFFICULTIES,
  SOURCES,
  LEVEL_FORMULA,
  NEXT_REVIEW_FORMULA,
} from "./schema.ts";

const sel = (names: string[]) => ({ select: { options: names.map((name) => ({ name })) } });

async function main() {
  const { notionToken, parentPageId } = setupConfig();
  const notion = makeNotion(notionToken);
  const parent = { type: "page_id" as const, page_id: normalizeId(parentPageId) };

  console.log("Creating 🗺️ Topics database…");
  const topics = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "🗺️ Topics" } }],
    properties: {
      [TOPIC_PROP.Topic]: { title: {} },
      [TOPIC_PROP.Category]: sel(TOPIC_CATEGORIES),
      [TOPIC_PROP.LastQuizzed]: { date: {} },
      [TOPIC_PROP.WeakAreas]: { rich_text: {} },
      [TOPIC_PROP.Status]: sel(TOPIC_STATUSES),
      [TOPIC_PROP.ProfileBlockId]: { rich_text: {} },
    },
  });
  const topicsDbId = topics.id;
  console.log(`  ✓ Topics DB: ${topicsDbId}`);

  console.log("Creating 🗂️ Question Bank database…");
  const qbank = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "🗂️ Question Bank" } }],
    properties: {
      [QUESTION_PROP.Question]: { title: {} },
      [QUESTION_PROP.Prompt]: { rich_text: {} },
      [QUESTION_PROP.PromptContinued]: { rich_text: {} },
      [QUESTION_PROP.Rubric]: { rich_text: {} },
      [QUESTION_PROP.Topic]: {
        relation: { database_id: topicsDbId, type: "dual_property", dual_property: {} },
      },
      [QUESTION_PROP.Difficulty]: sel(DIFFICULTIES),
      [QUESTION_PROP.Status]: sel(QUESTION_STATUSES),
      [QUESTION_PROP.Streak]: { number: {} },
      [QUESTION_PROP.GapHistory]: { rich_text: {} },
      [QUESTION_PROP.TimesAsked]: { number: {} },
      [QUESTION_PROP.LastAsked]: { date: {} },
      [QUESTION_PROP.LastScore]: { number: {} },
      [QUESTION_PROP.GapNotes]: { rich_text: {} },
      [QUESTION_PROP.Source]: sel(SOURCES),
      [QUESTION_PROP.Due]: { date: {} },
    },
  });
  const questionBankDbId = qbank.id;
  console.log(`  ✓ Question Bank DB: ${questionBankDbId}`);

  // The Title property internal ID (for titles-only dedup reads — pass the ID, not "Title").
  const titleProp = Object.values(qbank.properties).find((p: any) => p.type === "title") as any;
  const questionTitlePropId = titleProp?.id ?? "title";

  // Find the synced reverse-relation property Notion auto-created in Topics, so rollups
  // can reference it by name.
  const topicsFull = await notion.databases.retrieve({ database_id: topicsDbId });
  const syncedRel = Object.entries(topicsFull.properties).find(
    ([, p]: [string, any]) => p.type === "relation" && p.relation?.database_id === questionBankDbId
  );
  const relName = syncedRel?.[0];

  // ---- Best-effort display props (rollups + formulas). Never block core schema. ----
  const notes: string[] = [];

  if (relName) {
    await tryUpdate(
      notion,
      topicsDbId,
      {
        [TOPIC_PROP.TotalQuestions]: {
          rollup: { relation_property_name: relName, rollup_property_name: QUESTION_PROP.Status, function: "count" },
        },
        [TOPIC_PROP.AvgScore]: {
          rollup: { relation_property_name: relName, rollup_property_name: QUESTION_PROP.LastScore, function: "average" },
        },
        [TOPIC_PROP.MasteredCount]: {
          rollup: { relation_property_name: relName, rollup_property_name: QUESTION_PROP.Status, function: "count" },
        },
        [TOPIC_PROP.WeakCount]: {
          rollup: { relation_property_name: relName, rollup_property_name: QUESTION_PROP.Status, function: "count" },
        },
      },
      "Topics rollups (Avg Score, counts)",
      notes
    );
    notes.push(
      `In the Notion UI, add a rollup FILTER to "${TOPIC_PROP.MasteredCount}" (Status = Mastered) and "${TOPIC_PROP.WeakCount}" (Status = Weak). The API cannot set rollup filters; without it both read the same as Total Questions.`
    );
  } else {
    notes.push("Could not locate the synced relation in Topics — add the four rollups manually in the UI.");
  }

  await tryUpdate(
    notion,
    topicsDbId,
    { [TOPIC_PROP.Level]: { formula: { expression: LEVEL_FORMULA } } },
    "Topics Level formula",
    notes
  );

  await tryUpdate(
    notion,
    questionBankDbId,
    { [QUESTION_PROP.NextReview]: { formula: { expression: NEXT_REVIEW_FORMULA } } },
    "Question Bank Next Review formula (display-only)",
    notes
  );

  // ---- Output -------------------------------------------------------------
  console.log("\n=================  PASTE INTO .env  =================");
  console.log(`TOPICS_DB_ID=${stripDashes(topicsDbId)}`);
  console.log(`QUESTION_BANK_DB_ID=${stripDashes(questionBankDbId)}`);
  console.log(`QUESTION_TITLE_PROP_ID=${questionTitlePropId}`);
  console.log("====================================================\n");

  console.log("NEXT STEPS:");
  console.log("  1. Paste the three lines above into your .env.");
  console.log("  2. In Notion, share BOTH databases with your integration (••• → Connections).");
  if (notes.length) {
    console.log("  3. Finish these manual steps the API can't do:");
    for (const n of notes) console.log(`       - ${n}`);
  }
  console.log("\nDone.");
}

async function tryUpdate(
  notion: ReturnType<typeof makeNotion>,
  databaseId: string,
  properties: Record<string, any>,
  label: string,
  notes: string[]
) {
  try {
    await notion.databases.update({ database_id: databaseId, properties });
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    console.log(`  ⚠ ${label} — could not auto-create (${err?.message ?? err}).`);
    notes.push(`Add "${label}" manually in the Notion UI.`);
  }
}

const stripDashes = (id: string) => id.replace(/-/g, "");

main().catch((err) => {
  console.error("\nSetup failed:", err?.body ?? err?.message ?? err);
  process.exit(1);
});
