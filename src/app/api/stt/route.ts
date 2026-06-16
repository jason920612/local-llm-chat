import { NextRequest } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appendServiceTier(form: FormData): void {
  if (config.grok.serviceTier) {
    form.append("service_tier", config.grok.serviceTier);
  }
}

/** Proxy to xAI Speech-to-Text (/v1/stt). Accepts an audio file, returns text. */
export async function POST(req: NextRequest) {
  if (!config.grok.enabled) {
    return Response.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }

  let inForm: FormData;
  try {
    inForm = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart" }, { status: 400 });
  }
  const file = inForm.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "file required" }, { status: 400 });
  }

  // xAI requires the file field AFTER all other fields. We skip `format=true`
  // (which would require a fixed language) so transcription auto-detects.
  const out = new FormData();
  appendServiceTier(out);
  out.append("file", file, file.name || "audio.webm");

  const res = await fetch(`${config.grok.baseURL}/stt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.grok.apiKey}` },
    body: out,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `xAI stt ${res.status}: ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const data = await res.json().catch(() => ({}));
  return Response.json({ text: typeof data.text === "string" ? data.text : "" });
}
