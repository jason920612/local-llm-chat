import { config } from "../config";

/**
 * Split text into overlapping chunks, preferring paragraph boundaries.
 * Paragraphs are packed up to `chunkSize`; an oversized paragraph is hard-split.
 * Consecutive chunks share `chunkOverlap` trailing characters for continuity.
 */
export function chunkText(
  text: string,
  chunkSize = config.rag.chunkSize,
  overlap = config.rag.chunkOverlap,
): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    if (p.length > chunkSize) {
      // Flush what we have, then hard-split the long paragraph.
      push();
      current = "";
      for (let i = 0; i < p.length; i += chunkSize - overlap) {
        chunks.push(p.slice(i, i + chunkSize));
      }
      continue;
    }

    if (current.length + p.length + 2 > chunkSize) {
      push();
      // Seed the next chunk with the overlap tail of the previous one.
      current = overlap > 0 ? current.slice(-overlap) + "\n\n" + p : p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  push();

  return chunks;
}
