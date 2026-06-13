import { NextRequest } from "next/server";
import { setActiveChild, getConversation } from "@/lib/repo";
import { computePath } from "@/lib/tree";
import { compactConversation } from "@/lib/compaction";

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

  // Switching a branch can change the active path, so eagerly compact it now: the
  // summary then always matches the branch you're on (cached per node, so this is
  // cheap on subsequent switches and reuses shared-history summaries).
  try {
    const data = getConversation(id);
    if (data) {
      await compactConversation(id, computePath(data.messages, data.rootChildId));
    }
  } catch {
    /* best-effort pre-warm */
  }
  return Response.json({ ok: true });
}
