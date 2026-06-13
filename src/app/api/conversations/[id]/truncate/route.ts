import { NextRequest } from "next/server";
import { truncateMessagesAfter } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Delete all messages after `afterMessageId` (used when editing a turn). */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.afterMessageId !== "string") {
    return Response.json({ error: "afterMessageId required" }, { status: 400 });
  }
  truncateMessagesAfter(id, body.afterMessageId);
  return Response.json({ ok: true });
}
