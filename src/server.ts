/**
 * MCP server over Streamable HTTP (stateless). Exposes the seven v5 tools to the
 * chat-Claude via a custom connector. Run it, then `tailscale funnel` the port to
 * get a public HTTPS URL (see README, Phase 5-7).
 *
 * Stateless mode: a fresh McpServer + transport is built per POST request. The
 * connector calls are independent JSON-RPC requests from Anthropic's cloud, so we
 * don't keep per-session SSE state — simpler and resilient to the server restarting.
 */
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { makeNotion } from "./notion.ts";
import { runtimeConfig } from "./config.ts";
import { QuizTools } from "./tools.ts";
import type { Score } from "./engine.ts";

const cfg = runtimeConfig();
const tools = new QuizTools(makeNotion(cfg.notionToken), cfg);

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** Build a fresh server instance with all tools registered. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "claude-quiz", version: "0.1.0" });

  server.registerTool(
    "get_topic",
    {
      description:
        "Look up a topic's row: Level, Weak Areas, Last Quizzed, counts, and the Profile Block ID. Call this first when a quiz session starts. Returns topic_id for use in other tools.",
      inputSchema: { topic: z.string().describe("Topic name (e.g. 'SQL') or its page id.") },
    },
    async ({ topic }) => json(await tools.getTopic(topic))
  );

  server.registerTool(
    "get_profile",
    {
      description:
        "Read the topic's Profile Callout (deep context: recurring mistakes, mastered concepts, priorities). Call only when deep context is needed, using the profile_block_id from get_topic.",
      inputSchema: { profile_block_id: z.string().describe("Block ID from get_topic.") },
    },
    async ({ profile_block_id }) => json(await tools.getProfile(profile_block_id))
  );

  server.registerTool(
    "get_due_questions",
    {
      description:
        "Get the questions due today for a topic (Due on-or-before today), with Prompt (Prompt + Prompt Continued already concatenated) and Rubric for grading. If none are due and you want fresh ones, use create_question.",
      inputSchema: { topic: z.string().describe("Topic name or page id.") },
    },
    async ({ topic }) => json(await tools.getDueQuestions(topic))
  );

  server.registerTool(
    "submit_evaluation",
    {
      description:
        "Record the user's score and gap notes for a question. Status, streak, dates, due-date and counts are computed by the application — do NOT supply them. Gap notes are written fresh and overwrite the previous notes. Grade the answer against the question's Rubric using the standardized 1-5 anchors.",
      inputSchema: {
        question_id: z.string().describe("The question_id from get_due_questions."),
        score: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe("1=blank/incorrect, 2=weak, 3=shaky/major hints, 4=great minor gaps, 5=perfect."),
        gap_notes: z
          .string()
          .max(150)
          .describe("1-2 lines MAX on what was missed. Written fresh; do not echo prior notes."),
      },
    },
    async ({ question_id, score, gap_notes }) =>
      json(await tools.submitEvaluation(question_id, score as Score, gap_notes))
  );

  server.registerTool(
    "create_topic",
    {
      description:
        "Create a new topic row in the Topics database so it can be quizzed. Use when the user wants to study something that doesn't exist yet (get_topic returned found:false). New topics start Active. Duplicate topic names are skipped. Optionally seed Category, Weak Areas, and a profile summary (creates the Profile Callout).",
      inputSchema: {
        topic: z.string().describe("The topic name — also the dedup key (e.g. 'SQL')."),
        category: z.enum(["Technical", "Behavioral"]).optional().describe("Topic category."),
        weak_areas: z
          .string()
          .max(200)
          .optional()
          .describe("Optional initial weak areas (comma list, compressed)."),
        profile_summary: z
          .string()
          .max(1500)
          .optional()
          .describe("Optional <=300-word seed for the Profile Callout (deep context)."),
      },
    },
    async (args) => json(await tools.createTopic(args))
  );

  server.registerTool(
    "create_question",
    {
      description:
        "Create a new generated question for a topic. Provide Prompt and a Rubric together so it is gradeable from day one. Duplicate titles for the same topic are skipped. New questions are due immediately.",
      inputSchema: {
        topic: z.string().describe("Topic name or page id."),
        title: z.string().describe("Short descriptive label — also the dedup key."),
        prompt: z.string().describe("Full question prompt."),
        rubric: z.string().optional().describe("Grading ground-truth: key points / acceptable-answer criteria."),
        difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
      },
    },
    async (args) => json(await tools.createQuestion(args))
  );

  server.registerTool(
    "update_topic",
    {
      description:
        "Update the topic-level profile when a recurring pattern emerged this session. Call sparingly. Weak Areas and the profile summary are OVERWRITTEN (compressed), never appended. Always sets Last Quizzed to today.",
      inputSchema: {
        topic: z.string().describe("Topic name or page id."),
        weak_areas: z.string().max(200).optional().describe("Comma list, compressed. Overwrites existing."),
        profile_summary: z
          .string()
          .max(1500)
          .optional()
          .describe("<=300 words. Overwrites the Callout block. Summarize, don't accumulate."),
      },
    },
    async (args) => json(await tools.updateTopic(args))
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "claude-quiz" }));

app.post("/mcp", async (req, res) => {
  // Fresh server + transport per request (stateless).
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support server-initiated streams / session teardown.
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(cfg.port, () => {
  console.log(`claude-quiz MCP server listening on http://localhost:${cfg.port}/mcp`);
  console.log(`Health check: http://localhost:${cfg.port}/health`);
  console.log(`Interval easing: ${cfg.easing ? "ON" : "off"}`);
});
