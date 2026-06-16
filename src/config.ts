/** Typed environment config. Loaded once at process start. */
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Config needed by the one-time setup script (does not need DB IDs yet). */
export function setupConfig() {
  return {
    notionToken: required("NOTION_TOKEN"),
    parentPageId: required("NOTION_PARENT_PAGE_ID"),
  };
}

/** Full runtime config needed by the MCP server. */
export function runtimeConfig() {
  return {
    notionToken: required("NOTION_TOKEN"),
    topicsDbId: required("TOPICS_DB_ID"),
    questionBankDbId: required("QUESTION_BANK_DB_ID"),
    questionTitlePropId: required("QUESTION_TITLE_PROP_ID"),
    port: Number(optional("PORT") ?? "8787"),
    // Optional Mastered-interval easing (14 * max(Streak-1,1)). Off by default.
    easing: (optional("INTERVAL_EASING") ?? "false").toLowerCase() === "true",
  };
}

export type RuntimeConfig = ReturnType<typeof runtimeConfig>;
