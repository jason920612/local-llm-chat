import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Expose non-sensitive runtime configuration (no API key). */
export async function GET() {
  return Response.json({
    baseURL: config.llm.baseURL,
    chatModel: config.llm.model,
    embeddingModel: config.llm.embeddingModel,
    rag: config.rag,
    sop: config.sop,
    grok: { enabled: config.grok.enabled, model: config.grok.model },
  });
}
