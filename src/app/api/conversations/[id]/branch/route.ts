import { NextRequest } from "next/server";
import { setActiveChild } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Select which child branch (version) is active under a node, or the root. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as {
    parentId?: string | null;
    childId?: string;
  } | null;
  if (!body || typeof body.childId !== "string") {
    return Response.json({ error: "childId required" }, { status: 400 });
  }
  setActiveChild(id, body.parentId ?? null, body.childId);
  return Response.json({ ok: true });
}
