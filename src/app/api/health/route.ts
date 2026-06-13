import { llm } from "@/lib/llm";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Probe the local model server and report which models are loaded. */
export async function GET() {
  try {
    const list = await llm.models.list();
    const models = list.data.map((m) => m.id);
    const chatLoaded = models.includes(config.llm.model);
    const embedLoaded = models.includes(config.llm.embeddingModel);
    return Response.json({
      ok: true,
      models,
      chatModel: config.llm.model,
      embeddingModel: config.llm.embeddingModel,
      chatLoaded,
      embedLoaded,
    });
  } catch (err) {
    return Response.json({
      ok: false,
      error: err instanceof Error ? err.message : "unreachable",
      baseURL: config.llm.baseURL,
      chatModel: config.llm.model,
    });
  }
}
