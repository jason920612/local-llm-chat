import { NextRequest } from "next/server";
import { listBackgroundDashboard } from "@/lib/live/background";
import type { BgStatus } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: BgStatus[] = [
  "running",
  "exited",
  "killed",
  "timeout",
  "terminated",
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get("conversationId");
  const statusParam = searchParams.get("status");
  const status = STATUSES.includes(statusParam as BgStatus)
    ? (statusParam as BgStatus)
    : null;
  const limit = Number(searchParams.get("limit") ?? 100);

  return Response.json({
    jobs: listBackgroundDashboard({
      conversationId,
      status,
      limit: Number.isFinite(limit) ? limit : 100,
    }),
  });
}
