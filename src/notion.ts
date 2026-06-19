/**
 * Thin Notion REST wrapper: a configured client plus property read/write helpers.
 * Higher-level tool logic lives in tools.ts; this file just maps between Notion's
 * property-value shapes and plain JS values. Notion-Version is pinned to the one
 * the v5 validation was run against (2022-06-28).
 */
import { Client } from "@notionhq/client";

// Use Node's native fetch (undici) instead of the SDK's bundled node-fetch.
// undici does Happy-Eyeballs (races IPv4/IPv6) and is far more robust in
// containers; node-fetch gave consistent "Premature close" on outbound calls
// from Fly, whose IPv6 egress drops long-haul transfers to api.notion.com.
// Strip the node-fetch-only `agent` option that undici's fetch doesn't accept.
const undiciFetch = ((url: any, init: { agent?: unknown } = {}) => {
  const { agent: _agent, ...rest } = init;
  return fetch(url, rest as RequestInit);
}) as never;

export function makeNotion(token: string): Client {
  return new Client({ auth: token, notionVersion: "2022-06-28", fetch: undiciFetch });
}

// Notion property values come back as a loose union; we read defensively.
type AnyProp = Record<string, any>;
type Props = Record<string, AnyProp>;

const richTextToPlain = (arr: any[] | undefined): string =>
  (arr ?? []).map((rt) => rt?.plain_text ?? "").join("");

// ---- Readers ---------------------------------------------------------------

export function readTitle(props: Props, name: string): string {
  return richTextToPlain(props[name]?.title);
}

export function readText(props: Props, name: string): string {
  return richTextToPlain(props[name]?.rich_text);
}

export function readNumber(props: Props, name: string): number | null {
  const v = props[name]?.number;
  return typeof v === "number" ? v : null;
}

export function readSelect(props: Props, name: string): string | null {
  return props[name]?.select?.name ?? null;
}

export function readDate(props: Props, name: string): string | null {
  return props[name]?.date?.start ?? null;
}

export function readRelationIds(props: Props, name: string): string[] {
  return (props[name]?.relation ?? []).map((r: any) => r.id);
}

/** Reads a numeric rollup (average/count). Returns null when empty/non-numeric. */
export function readRollupNumber(props: Props, name: string): number | null {
  const rollup = props[name]?.rollup;
  if (!rollup) return null;
  if (typeof rollup.number === "number") return rollup.number;
  return null;
}

// ---- Writers (property-value builders for create/update) -------------------

export const W = {
  title: (s: string) => ({ title: [{ text: { content: s } }] }),
  text: (s: string) => ({ rich_text: s ? [{ text: { content: s } }] : [] }),
  number: (n: number) => ({ number: n }),
  select: (name: string) => ({ select: { name } }),
  date: (iso: string) => ({ date: { start: iso } }),
  relation: (ids: string[]) => ({ relation: ids.map((id) => ({ id })) }),
  /** Multi-object rich_text for the Callout char-guard split. */
  textObjects: (parts: string[]) => ({
    rich_text: parts.filter((p) => p.length > 0).map((content) => ({ text: { content } })),
  }),
};

/** Page id without dashes -> with dashes, tolerant of either input form. */
export function normalizeId(id: string): string {
  const clean = id.replace(/-/g, "").trim();
  if (clean.length !== 32) return id.trim();
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(
    16,
    20
  )}-${clean.slice(20)}`;
}
