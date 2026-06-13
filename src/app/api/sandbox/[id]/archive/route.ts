import { NextRequest } from "next/server";
import { packTar } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Pack selected sandbox files into a tar download. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const names: string[] = Array.isArray(body.names)
    ? body.names.filter((n: unknown) => typeof n === "string")
    : [];
  if (names.length === 0) {
    return Response.json({ error: "no files selected" }, { status: 400 });
  }
  const tar = packTar(id, names);
  return new Response(new Uint8Array(tar), {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": 'attachment; filename="sandbox.tar"',
      "Cache-Control": "no-store",
    },
  });
}
