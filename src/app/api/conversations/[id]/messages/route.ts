import { NextRequest } from "next/server";
import { addMessage } from "@/lib/repo";
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
  return Response.json({ ok: true }, { status: 201 });
}
