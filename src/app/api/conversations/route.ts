import { NextRequest } from "next/server";
import {
  createConversation,
  deleteConversationsBulk,
  listConversations,
} from "@/lib/repo";
import { publishGlobal } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  const conversations =
    project === null
      ? listConversations()
      : listConversations(project === "none" ? null : project);
  return Response.json(conversations);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const conv = createConversation(
    typeof body.title === "string" ? body.title : "New chat",
    {
      projectId:
        typeof body.projectId === "string" && body.projectId.trim()
          ? body.projectId
          : null,
    },
  );
  publishGlobal({ type: "conv-created", conversation: conv });
  return Response.json(conv, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId =
    typeof body.projectId === "string"
      ? body.projectId
      : body.projectId === null
        ? null
        : undefined;
  const ids = deleteConversationsBulk({
    projectId,
    includePinned: Boolean(body.includePinned),
  });
  for (const id of ids) publishGlobal({ type: "conv-deleted", id });
  return Response.json({ ok: true, deleted: ids.length, ids });
}
