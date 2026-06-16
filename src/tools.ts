/**
 * The seven MCP tools' logic, wrapping the deterministic engine + the Notion client.
 *
 * Division of labor (the v5 contract): the chat-Claude supplies ONLY judgment/content
 * (score, gap_notes, generated text). Everything scheduling/state — new Status, new
 * Streak, Last Asked, Due, Times Asked, Gap History — is computed here in code from the
 * engine, never by the model. See BUILD-PLAN §6/§7.
 */
import type { Client } from "@notionhq/client";
import type { RuntimeConfig } from "./config.ts";
import {
  W,
  readTitle,
  readText,
  readNumber,
  readSelect,
  readDate,
  readRollupNumber,
  normalizeId,
} from "./notion.ts";
import { TOPIC_PROP, QUESTION_PROP } from "./schema.ts";
import {
  nextStatus,
  nextStreak,
  computeDue,
  todayISO,
  clampGapNotes,
  pushGapHistory,
  clampProfile,
  splitForCallout,
  type Status,
  type Score,
} from "./engine.ts";

const ID_RE = /^[0-9a-f]{32}$/i;
const looksLikeId = (s: string) => ID_RE.test(s.replace(/-/g, ""));

export class QuizTools {
  // Idempotency guard: remembers the last evaluation per question to drop an
  // accidental double-fire within a short window (BUILD-PLAN §7).
  private lastEval = new Map<string, { sig: string; at: number; result: unknown }>();
  private static readonly DOUBLE_FIRE_MS = 90_000;

  constructor(private notion: Client, private cfg: RuntimeConfig) {}

  // ---- helpers -------------------------------------------------------------

  private async resolveTopic(topic: string): Promise<{ id: string; props: any } | null> {
    if (looksLikeId(topic)) {
      const id = normalizeId(topic);
      const page: any = await this.notion.pages.retrieve({ page_id: id });
      return { id, props: page.properties };
    }
    const res: any = await this.notion.databases.query({
      database_id: this.cfg.topicsDbId,
      filter: { property: TOPIC_PROP.Topic, title: { equals: topic } },
      page_size: 1,
    });
    const hit = res.results[0];
    return hit ? { id: hit.id, props: hit.properties } : null;
  }

  // ---- get_topic -----------------------------------------------------------

  async getTopic(topic: string) {
    const found = await this.resolveTopic(topic);
    if (!found) return { found: false, message: `No topic named "${topic}".` };
    const p = found.props;
    return {
      found: true,
      topic_id: found.id,
      topic: readTitle(p, TOPIC_PROP.Topic),
      category: readSelect(p, TOPIC_PROP.Category),
      level: readRollupNumber(p, TOPIC_PROP.Level) ?? readNumber(p, TOPIC_PROP.Level),
      weak_areas: readText(p, TOPIC_PROP.WeakAreas),
      last_quizzed: readDate(p, TOPIC_PROP.LastQuizzed),
      avg_score: readRollupNumber(p, TOPIC_PROP.AvgScore),
      total_questions: readRollupNumber(p, TOPIC_PROP.TotalQuestions),
      mastered_count: readRollupNumber(p, TOPIC_PROP.MasteredCount),
      weak_count: readRollupNumber(p, TOPIC_PROP.WeakCount),
      profile_block_id: readText(p, TOPIC_PROP.ProfileBlockId) || null,
    };
  }

  // ---- get_profile ---------------------------------------------------------

  async getProfile(blockId: string) {
    if (!blockId) return { found: false, message: "No profile_block_id supplied." };
    try {
      const block: any = await this.notion.blocks.retrieve({ block_id: normalizeId(blockId) });
      const rt = block?.callout?.rich_text ?? block?.paragraph?.rich_text ?? [];
      return { found: true, profile: rt.map((r: any) => r.plain_text ?? "").join("") };
    } catch (err: any) {
      return { found: false, message: `Could not read profile block: ${err?.message ?? err}` };
    }
  }

  // ---- get_due_questions ---------------------------------------------------

  async getDueQuestions(topic: string) {
    const found = await this.resolveTopic(topic);
    if (!found) return { found: false, message: `No topic named "${topic}".`, questions: [] };
    const today = todayISO();
    const res: any = await this.notion.databases.query({
      database_id: this.cfg.questionBankDbId,
      filter: {
        and: [
          { property: QUESTION_PROP.Topic, relation: { contains: found.id } },
          { property: QUESTION_PROP.Due, date: { on_or_before: today } },
        ],
      },
      page_size: 50,
    });
    const questions = res.results.map((row: any) => {
      const p = row.properties;
      const prompt = readText(p, QUESTION_PROP.Prompt);
      const cont = readText(p, QUESTION_PROP.PromptContinued);
      return {
        question_id: row.id,
        title: readTitle(p, QUESTION_PROP.Question),
        prompt: cont ? `${prompt}${cont}` : prompt,
        rubric: readText(p, QUESTION_PROP.Rubric) || null,
        difficulty: readSelect(p, QUESTION_PROP.Difficulty),
        status: (readSelect(p, QUESTION_PROP.Status) ?? "New") as Status,
        streak: readNumber(p, QUESTION_PROP.Streak) ?? 0,
        due: readDate(p, QUESTION_PROP.Due),
      };
    });
    return { found: true, topic_id: found.id, count: questions.length, questions };
  }

  // ---- submit_evaluation ---------------------------------------------------

  async submitEvaluation(questionId: string, score: Score, gapNotes: string) {
    const id = normalizeId(questionId);
    const sig = `${score}|${gapNotes}`;
    const prev = this.lastEval.get(id);
    if (prev && prev.sig === sig && Date.now() - prev.at < QuizTools.DOUBLE_FIRE_MS) {
      return { ...(prev.result as object), idempotent_skip: true };
    }

    const page: any = await this.notion.pages.retrieve({ page_id: id });
    const p = page.properties;
    const oldStatus = (readSelect(p, QUESTION_PROP.Status) ?? "New") as Status;
    const oldStreak = readNumber(p, QUESTION_PROP.Streak) ?? 0;
    const oldTimesAsked = readNumber(p, QUESTION_PROP.TimesAsked) ?? 0;
    const oldGapHistory = readText(p, QUESTION_PROP.GapHistory);

    const newStatus = nextStatus(oldStatus, score);
    const newStreak = nextStreak(oldStreak, score);
    const lastAsked = todayISO();
    const due = computeDue(lastAsked, newStatus, newStreak, { easing: this.cfg.easing });
    const cleanNotes = clampGapNotes(gapNotes);
    const gapHistory = pushGapHistory(oldGapHistory, cleanNotes);

    await this.notion.pages.update({
      page_id: id,
      properties: {
        [QUESTION_PROP.LastScore]: W.number(score),
        [QUESTION_PROP.Status]: W.select(newStatus),
        [QUESTION_PROP.Streak]: W.number(newStreak),
        [QUESTION_PROP.LastAsked]: W.date(lastAsked),
        [QUESTION_PROP.Due]: W.date(due),
        [QUESTION_PROP.TimesAsked]: W.number(oldTimesAsked + 1),
        [QUESTION_PROP.GapNotes]: W.text(cleanNotes),
        [QUESTION_PROP.GapHistory]: W.text(gapHistory),
      },
    });

    const result = {
      ok: true,
      question_id: id,
      old_status: oldStatus,
      new_status: newStatus,
      new_streak: newStreak,
      last_asked: lastAsked,
      due,
      times_asked: oldTimesAsked + 1,
    };
    this.lastEval.set(id, { sig, at: Date.now(), result });
    return result;
  }

  // ---- create_question -----------------------------------------------------

  async createQuestion(args: {
    topic: string;
    title: string;
    prompt: string;
    rubric?: string;
    difficulty?: string;
  }) {
    const found = await this.resolveTopic(args.topic);
    if (!found) return { ok: false, message: `No topic named "${args.topic}".` };

    // Titles-only dedup: query this topic's questions returning ONLY the title property
    // (pass the Title property's internal ID, not the string "Title").
    const existing: any = await this.notion.databases.query({
      database_id: this.cfg.questionBankDbId,
      filter: { property: QUESTION_PROP.Topic, relation: { contains: found.id } },
      filter_properties: [this.cfg.questionTitlePropId],
      page_size: 100,
    });
    const wanted = args.title.trim().toLowerCase();
    const dupe = existing.results.find(
      (r: any) => readTitle(r.properties, QUESTION_PROP.Question).trim().toLowerCase() === wanted
    );
    if (dupe) {
      return { ok: false, deduped: true, message: "A question with this title already exists.", question_id: dupe.id };
    }

    const today = todayISO();
    const { prompt, promptContinued } = splitPrompt(args.prompt);
    const properties: Record<string, any> = {
      [QUESTION_PROP.Question]: W.title(args.title.trim()),
      [QUESTION_PROP.Prompt]: W.text(prompt),
      [QUESTION_PROP.Topic]: W.relation([found.id]),
      [QUESTION_PROP.Status]: W.select("New"),
      [QUESTION_PROP.Streak]: W.number(0),
      [QUESTION_PROP.TimesAsked]: W.number(0),
      [QUESTION_PROP.Due]: W.date(today),
      [QUESTION_PROP.Source]: W.select("Generated"),
    };
    if (promptContinued) properties[QUESTION_PROP.PromptContinued] = W.text(promptContinued);
    if (args.rubric) properties[QUESTION_PROP.Rubric] = W.text(args.rubric);
    if (args.difficulty) properties[QUESTION_PROP.Difficulty] = W.select(args.difficulty);

    const created: any = await this.notion.pages.create({
      parent: { database_id: this.cfg.questionBankDbId },
      properties,
    });
    return { ok: true, question_id: created.id, title: args.title.trim(), due: today };
  }

  // ---- create_topic --------------------------------------------------------

  async createTopic(args: {
    topic: string;
    category?: string;
    weak_areas?: string;
    profile_summary?: string;
  }) {
    const title = args.topic.trim();
    if (!title) return { ok: false, message: "Topic name is required." };

    // Titles-only dedup: a topic with this name (case-insensitive) already exists?
    const existing: any = await this.notion.databases.query({
      database_id: this.cfg.topicsDbId,
      filter: { property: TOPIC_PROP.Topic, title: { equals: title } },
      page_size: 1,
    });
    if (existing.results.length > 0) {
      return {
        ok: false,
        deduped: true,
        message: `A topic named "${title}" already exists.`,
        topic_id: existing.results[0].id,
      };
    }

    const properties: Record<string, any> = {
      [TOPIC_PROP.Topic]: W.title(title),
      [TOPIC_PROP.Status]: W.select("Active"),
    };
    if (args.category) properties[TOPIC_PROP.Category] = W.select(args.category);
    if (args.weak_areas !== undefined && args.weak_areas.trim() !== "")
      properties[TOPIC_PROP.WeakAreas] = W.text(args.weak_areas.trim());

    const created: any = await this.notion.pages.create({
      parent: { database_id: this.cfg.topicsDbId },
      properties,
    });

    let profileBlockId: string | null = null;
    if (args.profile_summary !== undefined && args.profile_summary.trim() !== "") {
      profileBlockId = await this.createProfileCallout(created.id, args.profile_summary);
    }

    return { ok: true, topic_id: created.id, topic: title, profile_block_id: profileBlockId };
  }

  // ---- update_topic --------------------------------------------------------

  async updateTopic(args: { topic: string; weak_areas?: string; profile_summary?: string }) {
    const found = await this.resolveTopic(args.topic);
    if (!found) return { ok: false, message: `No topic named "${args.topic}".` };

    const today = todayISO();
    const props: Record<string, any> = { [TOPIC_PROP.LastQuizzed]: W.date(today) };
    if (args.weak_areas !== undefined) props[TOPIC_PROP.WeakAreas] = W.text(args.weak_areas.trim());
    await this.notion.pages.update({ page_id: found.id, properties: props });

    let profileUpdated = false;
    if (args.profile_summary !== undefined && args.profile_summary.trim() !== "") {
      const parts = splitForCallout(clampProfile(args.profile_summary));
      const existingBlockId = readText(found.props, TOPIC_PROP.ProfileBlockId);
      if (existingBlockId) {
        await this.notion.blocks.update({
          block_id: normalizeId(existingBlockId),
          callout: W.textObjects(parts) as any,
        });
        profileUpdated = true;
      } else {
        // No Callout yet — create one in the page body and store its block ID.
        profileUpdated = (await this.createProfileCallout(found.id, args.profile_summary)) !== null;
      }
    }
    return { ok: true, topic_id: found.id, last_quizzed: today, profile_updated: profileUpdated };
  }

  /**
   * Create the Profile Callout block in a topic page's body and store its block ID in
   * the Profile Block ID property. Returns the new block ID (or null if append failed).
   * Shared by create_topic and update_topic's "no existing callout yet" path.
   */
  private async createProfileCallout(pageId: string, summary: string): Promise<string | null> {
    const parts = splitForCallout(clampProfile(summary));
    const appended: any = await this.notion.blocks.children.append({
      block_id: pageId,
      children: [
        { object: "block", type: "callout", callout: { ...(W.textObjects(parts) as any), icon: { emoji: "🧠" } } },
      ],
    });
    const newBlockId = appended.results?.[0]?.id;
    if (!newBlockId) return null;
    await this.notion.pages.update({
      page_id: pageId,
      properties: { [TOPIC_PROP.ProfileBlockId]: W.text(newBlockId) },
    });
    return newBlockId;
  }
}

/** Split a long generated prompt across Prompt (<=2000) + Prompt Continued, on a boundary. */
function splitPrompt(text: string): { prompt: string; promptContinued?: string } {
  const t = (text ?? "").trim();
  if (t.length <= 2000) return { prompt: t };
  const window = t.slice(0, 2000);
  const at = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
  const cut = at > 1000 ? at + 1 : 2000;
  return { prompt: t.slice(0, cut).trim(), promptContinued: t.slice(cut).trim().slice(0, 2000) };
}
