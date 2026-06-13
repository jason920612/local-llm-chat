import { NextRequest } from "next/server";
import { listDocuments } from "@/lib/repo";
import { ingestFile } from "@/lib/rag/ingest";
import type { RagDocument } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return Response.json(listDocuments());
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data." }, {
      status: 400,
    });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "No files provided." }, { status: 400 });
  }

  const documents: RagDocument[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const doc = await ingestFile(file.name, file.type, buffer);
      documents.push(doc);
    } catch (err) {
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : "ingest failed",
      });
    }
  }

  return Response.json({ documents, errors });
}
