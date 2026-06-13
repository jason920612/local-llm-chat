import pdf from "pdf-parse/lib/pdf-parse.js";

export interface ParsedFile {
  text: string;
  type: string;
}

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".log"];

function hasTextExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Extract plain text from a supported uploaded file. */
export async function parseFile(
  name: string,
  type: string,
  buffer: Buffer,
): Promise<ParsedFile> {
  const isPdf = type === "application/pdf" || name.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    const data = await pdf(buffer);
    return { text: data.text, type: "application/pdf" };
  }

  if (type.startsWith("text/") || hasTextExtension(name)) {
    return { text: buffer.toString("utf-8"), type: type || "text/plain" };
  }

  throw new Error(
    `Unsupported file type: ${type || name}. Supported: PDF, txt, md, csv, json.`,
  );
}
