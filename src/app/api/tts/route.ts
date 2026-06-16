import { NextRequest } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_VOICES = ["eve", "ara", "rex", "sal", "leo"];

function maybeServiceTier(): Record<string, unknown> {
  return config.grok.serviceTier ? { service_tier: config.grok.serviceTier } : {};
}

/** Proxy to xAI Text-to-Speech (/v1/tts). Returns MP3 audio bytes. */
export async function POST(req: NextRequest) {
  if (!config.grok.enabled) {
    return Response.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.slice(0, 15000) : "";
  if (!text.trim()) {
    return Response.json({ error: "text required" }, { status: 400 });
  }
  const voice =
    typeof body.voice === "string" && VALID_VOICES.includes(body.voice)
      ? body.voice
      : "eve";

  const res = await fetch(`${config.grok.baseURL}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({
      text,
      voice_id: voice,
      language: "auto",
      ...maybeServiceTier(),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `xAI tts ${res.status}: ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const audio = await res.arrayBuffer();
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
