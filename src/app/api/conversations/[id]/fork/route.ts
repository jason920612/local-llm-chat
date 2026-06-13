import { NextRequest } from "next/server";
import { forkConversation } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Branch a conversation: copy messages up to `messageId` into a new one. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.messageId !== "string") {
    return Response.json({ error: "messageId required" }, { status: 400 });
  }
  const conv = forkConversation(id, body.messageId, body.title);
  if (!conv) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(conv);
}
