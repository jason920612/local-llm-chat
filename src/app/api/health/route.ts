import { llm } from "@/lib/llm";
import { config } from "@/lib/config";
import { activeChatModel } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Probe the local model server and report which models are loaded. */
export async function GET() {
  const chatModel = activeChatModel();
  try {
    const list = await llm.models.list();
    const models = list.data.map((m) => m.id);
    const chatLoaded = models.includes(chatModel);
    const embedLoaded = models.includes(config.llm.embeddingModel);
    return Response.json({
      ok: true,
      models,
      chatModel,
      embeddingModel: config.llm.embeddingModel,
      chatLoaded,
      embedLoaded,
    });
  } catch (err) {
    return Response.json({
      ok: false,
      error: err instanceof Error ? err.message : "unreachable",
      baseURL: config.llm.baseURL,
      chatModel,
    });
  }
}
