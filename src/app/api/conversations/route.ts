import { NextRequest } from "next/server";
import { createConversation, listConversations } from "@/lib/repo";

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
  return Response.json(conv, { status: 201 });
}
