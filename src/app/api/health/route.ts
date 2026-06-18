import { llm } from "@/lib/llm";
import { config } from "@/lib/config";
import { activeChatModel, chatTarget } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Probe the local model server and report which models are loaded. */
export async function GET() {
  const target = chatTarget();

  // When chatting via Grok (cloud), the local server is only used for RAG
  // embeddings — don't gate the indicator on it.
  if (target === "grok") {
    return Response.json({
      ok: true,
      target: "grok",
      chatModel: config.grok.model,
      embeddingProvider: config.llm.embeddingProvider,
      embeddingModel:
        config.llm.embeddingProvider === "lmstudio"
          ? config.llm.embeddingModel
          : config.llm.localEmbeddingModel,
      embedLoaded: config.llm.embeddingProvider !== "lmstudio",
    });
  }

  const chatModel = activeChatModel();
  try {
    const list = await llm.models.list();
    const models = list.data.map((m) => m.id);
    const chatLoaded = models.includes(chatModel);
    const embedLoaded = models.includes(config.llm.embeddingModel);
    return Response.json({
      ok: true,
      target: "local",
      models,
      chatModel,
      embeddingProvider: config.llm.embeddingProvider,
      embeddingModel: config.llm.embeddingModel,
      chatLoaded,
      embedLoaded: config.llm.embeddingProvider === "lmstudio" ? embedLoaded : true,
    });
  } catch (err) {
    return Response.json({
      ok: false,
      target: "local",
      error: err instanceof Error ? err.message : "unreachable",
      baseURL: config.llm.baseURL,
      chatModel,
      embeddingProvider: config.llm.embeddingProvider,
      embeddingModel:
        config.llm.embeddingProvider === "lmstudio"
          ? config.llm.embeddingModel
          : config.llm.localEmbeddingModel,
      embedLoaded: config.llm.embeddingProvider !== "lmstudio",
    });
  }
}
