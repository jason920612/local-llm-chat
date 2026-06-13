import { NextRequest } from "next/server";
import { llm } from "@/lib/llm";
import { getEffectiveSettings, setSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current effective settings + the models LM Studio currently exposes. */
export async function GET() {
  let availableModels: string[] = [];
  try {
    const list = await llm.models.list();
    availableModels = list.data.map((m) => m.id);
  } catch {
    /* server offline — leave list empty */
  }
  return Response.json({ ...getEffectiveSettings(), availableModels });
}

/** Update runtime overrides (chat model / strict monitor). Takes effect at once. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.chatModel === "string" && body.chatModel.trim()) {
    setSetting("chatModel", body.chatModel.trim());
  }
  if (typeof body.strictMonitor === "boolean") {
    setSetting("strictMonitor", String(body.strictMonitor));
  }
  return Response.json(getEffectiveSettings());
}
