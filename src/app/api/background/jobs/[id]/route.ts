import { NextRequest } from "next/server";
import { getBackgroundJobDetail } from "@/lib/live/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const tail = Number(searchParams.get("tail") ?? 8000);
  const job = getBackgroundJobDetail(
    id,
    Number.isFinite(tail) ? tail : 8000,
  );
  if (!job) {
    return Response.json({ error: "background job not found" }, { status: 404 });
  }
  return Response.json({ job });
}
