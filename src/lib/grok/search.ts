import { config } from "../config";
import type { Citation } from "../types";

export interface GrokResult {
  answer: string;
  citations: Citation[];
}

interface RawOutputContent {
  type?: string;
  text?: string;
}
interface RawOutputItem {
  type?: string;
  role?: string;
  text?: string;
  content?: RawOutputContent[];
}

function extractAnswer(data: {
  output_text?: unknown;
  output?: RawOutputItem[];
}): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data.output) ? data.output : [];
  // Walk from the end: the final assistant message holds the answer.
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (Array.isArray(item.content)) {
      const text = item.content
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (text.trim()) return text.trim();
    }
    if (
      (item.type === "output_text" || item.type === "text") &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      return item.text.trim();
    }
  }
  return "";
}

function toUrl(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const obj = c as { url?: string; uri?: string };
    return obj.url ?? obj.uri ?? "";
  }
  return "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "source";
  }
}

/** Map Grok's raw citations to UI Citation objects with sequential indices. */
export function mapGrokCitations(
  raw: unknown[],
  offset: number,
): Citation[] {
  return raw
    .map((c) => toUrl(c))
    .filter((u) => u.length > 0)
    .map((url, i) => ({
      index: offset + i + 1,
      documentId: "grok",
      documentName: hostOf(url),
      snippet: url,
    }));
}

/**
 * Ask Grok a question with server-side X (Twitter) + web search enabled.
 * Grok orchestrates the search loop and returns a synthesized answer; we return
 * only that answer (plus citations) so the caller's context stays small.
 */
export async function askGrok(query: string): Promise<GrokResult> {
  if (!config.grok.enabled) {
    throw new Error("XAI_API_KEY is not set — Grok search is disabled.");
  }

  const res = await fetch(`${config.grok.baseURL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: config.grok.model,
      input: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }, { type: "x_search" }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const answer = extractAnswer(data);
  const rawCitations: unknown[] = Array.isArray(data.citations)
    ? data.citations
    : [];

  return { answer, citations: mapGrokCitations(rawCitations, 0) };
}
