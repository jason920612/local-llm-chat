import { NextRequest } from "next/server";
import { killBackgroundJob } from "@/lib/live/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const ok = killBackgroundJob(id);
  if (!ok) {
    return Response.json(
      { error: "job is not running or was not found" },
      { status: 404 },
    );
  }
  return Response.json({ ok: true });
}
