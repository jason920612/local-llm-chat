import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { writeSandboxFiles } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Upload files into a conversation's sandbox workspace (for run_code to use). */
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!config.sandbox.enabled) {
    return Response.json({ error: "sandbox disabled" }, { status: 503 });
  }
  const { id } = await params;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart" }, { status: 400 });
  }
  const incoming = form
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (incoming.length === 0) {
    return Response.json({ error: "no files" }, { status: 400 });
  }

  const files = await Promise.all(
    incoming.map(async (f) => ({
      name: f.name,
      buffer: Buffer.from(await f.arrayBuffer()),
    })),
  );
  return Response.json({ files: writeSandboxFiles(id, files) });
}
