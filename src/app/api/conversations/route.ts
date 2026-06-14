import { NextRequest } from "next/server";
import { createConversation, listConversations } from "@/lib/repo";
import { publishGlobal } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(listConversations());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const conv = createConversation(
    typeof body.title === "string" ? body.title : "New chat",
  );
  publishGlobal({ type: "conv-created", conversation: conv });
  return Response.json(conv, { status: 201 });
}
