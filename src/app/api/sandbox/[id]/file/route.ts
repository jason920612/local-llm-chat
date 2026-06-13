import { NextRequest } from "next/server";
import { readSandboxFile } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Serve a file from a conversation's sandbox (for the viewer / download). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  const file = readSandboxFile(id, name);
  if (!file) return Response.json({ error: "not found" }, { status: 404 });

  const download = req.nextUrl.searchParams.get("download") === "1";
  const base = name.split("/").pop() || "file";
  return new Response(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.isText
        ? "text/plain; charset=utf-8"
        : "application/octet-stream",
      "Cache-Control": "no-store",
      ...(download
        ? { "Content-Disposition": `attachment; filename="${base}"` }
        : {}),
    },
  });
}
