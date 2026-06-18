import { NextRequest } from "next/server";
import {
  deleteConversation,
  getConversation,
  getConversationMeta,
  renameConversation,
  setConversationPinned,
  updateConversationProject,
} from "@/lib/repo";
import { publishGlobal } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const data = getConversation(id);
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(data);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  let changed = false;
  if (typeof body.title === "string") {
    renameConversation(id, body.title, "manual");
    changed = true;
  }
  if ("projectId" in body) {
    updateConversationProject(
      id,
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId
        : null,
    );
    changed = true;
  }
  if (typeof body.pinned === "boolean") {
    setConversationPinned(id, body.pinned);
    changed = true;
  }
  if (!changed) {
    return Response.json(
      { error: "title, projectId, or pinned required" },
      { status: 400 },
    );
  }
  const meta = getConversationMeta(id);
  if (meta) publishGlobal({ type: "conv-updated", conversation: meta });
  return meta
    ? Response.json(meta)
    : Response.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  deleteConversation(id);
  publishGlobal({ type: "conv-deleted", id });
  return Response.json({ ok: true });
}
