import { NextRequest } from "next/server";
import { addMessage, getConversationMeta } from "@/lib/repo";
import { publishConv, publishGlobal } from "@/lib/live/bus";
import type { UIMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const msg = (await req.json().catch(() => null)) as UIMessage | null;
  if (!msg || !msg.id || !msg.role) {
    return Response.json({ error: "invalid message" }, { status: 400 });
  }
  addMessage(id, msg);
  // Broadcast so other devices see the new/edited message (and reordered list).
  publishConv(id, { type: "message", message: msg });
  const meta = getConversationMeta(id);
  if (meta) publishGlobal({ type: "conv-updated", conversation: meta });
  return Response.json({ ok: true }, { status: 201 });
}
