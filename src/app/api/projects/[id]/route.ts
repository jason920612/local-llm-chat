import { NextRequest } from "next/server";
import {
  deleteProject,
  getProject,
  updateProject,
} from "@/lib/repo";
import { publishGlobal } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(project);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const project = updateProject(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    description:
      typeof body.description === "string" || body.description === null
        ? body.description
        : undefined,
    systemPrompt:
      typeof body.systemPrompt === "string" || body.systemPrompt === null
        ? body.systemPrompt
        : undefined,
    includeGlobalDocuments:
      typeof body.includeGlobalDocuments === "boolean"
        ? body.includeGlobalDocuments
        : undefined,
  });
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  publishGlobal({ type: "project-updated", project });
  return Response.json(project);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const deletedConversationIds = deleteProject(id, {
    deleteConversations: Boolean(body.deleteConversations),
  });
  publishGlobal({ type: "project-deleted", id });
  for (const cid of deletedConversationIds) {
    publishGlobal({ type: "conv-deleted", id: cid });
  }
  return Response.json({ ok: true, deletedConversationIds });
}
