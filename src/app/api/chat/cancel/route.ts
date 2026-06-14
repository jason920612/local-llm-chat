import { NextRequest } from "next/server";
import { cancelGeneration } from "@/lib/live/generations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Best-effort cancel of an in-flight generation. Body: { messageId }. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.messageId === "string") cancelGeneration(body.messageId);
  return Response.json({ ok: true });
}
