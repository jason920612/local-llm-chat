import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { fixMermaid } from "@/lib/grok/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Repair invalid Mermaid via the model (used as a render-failure fallback). */
export async function POST(req: NextRequest) {
  if (!config.grok.enabled) {
    return Response.json({ error: "grok disabled" }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  if (!body || typeof body.code !== "string") {
    return Response.json({ error: "code required" }, { status: 400 });
  }
  try {
    const fixed = await fixMermaid(body.code);
    return Response.json({ code: fixed });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "fix failed" },
      { status: 502 },
    );
  }
}
