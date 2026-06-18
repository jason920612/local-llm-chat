import { config } from "../config";
import { cosineSimilarity, embedOne } from "../embeddings";
import { getAllChunks } from "../repo";
import type { Citation } from "../types";

export interface RetrievalResult {
  /** Numbered, model-facing context block. Empty when nothing was retrieved. */
  context: string;
  /** Citations aligned with the [n] markers in `context`. */
  citations: Citation[];
}

const SNIPPET_MAX = 160;

function snippet(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "…" : s;
}

/**
 * Embed the query, score all stored chunks by cosine similarity, and return the
 * top-K as a numbered context block plus matching citations.
 */
export async function retrieve(
  query: string,
  topK = config.rag.topK,
  opts: { projectId?: string | null; includeGlobal?: boolean } = {},
): Promise<RetrievalResult> {
  const chunks = getAllChunks({
    projectId: opts.projectId,
    includeGlobal: opts.includeGlobal,
  });
  if (chunks.length === 0 || !query.trim()) {
    return { context: "", citations: [] };
  }

  const queryVec = await embedOne(query);

  const scored = chunks
    .map((c) => ({ c, score: cosineSimilarity(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const contextParts: string[] = [];
  const citations: Citation[] = [];

  scored.forEach(({ c }, i) => {
    const n = i + 1;
    contextParts.push(`[${n}] (source: ${c.documentName})\n${c.content}`);
    citations.push({
      index: n,
      documentId: c.documentId,
      documentName: c.documentName,
      snippet: snippet(c.content),
    });
  });

  return { context: contextParts.join("\n\n"), citations };
}
