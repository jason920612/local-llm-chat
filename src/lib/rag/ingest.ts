import { embed } from "../embeddings";
import { createDocumentWithChunks } from "../repo";
import type { RagDocument } from "../types";
import { chunkText } from "./chunk";
import { parseFile } from "./parse";

/** Parse, chunk, embed, and store an uploaded file. */
export async function ingestFile(
  name: string,
  type: string,
  buffer: Buffer,
): Promise<RagDocument> {
  const parsed = await parseFile(name, type, buffer);
  const chunks = chunkText(parsed.text);
  if (chunks.length === 0) {
    throw new Error(`No extractable text found in "${name}".`);
  }

  // Embed in batches to avoid oversized requests on large documents.
  const BATCH = 64;
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    embeddings.push(...(await embed(chunks.slice(i, i + BATCH))));
  }

  return createDocumentWithChunks(
    { name, type: parsed.type, size: buffer.byteLength },
    chunks.map((content, i) => ({ content, embedding: embeddings[i] })),
  );
}
