import { NextRequest } from "next/server";
import { listSopControlEvents } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get("conversationId");
  const limit = Number(searchParams.get("limit") ?? 100);
  return Response.json({
    events: listSopControlEvents({
      conversationId,
      limit: Number.isFinite(limit) ? limit : 100,
    }),
  });
}
