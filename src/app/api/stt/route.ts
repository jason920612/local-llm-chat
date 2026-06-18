import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { transcribeAudio } from "@/lib/grok/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    const text = await transcribeAudio(file, file.name || "audio.webm");
    return Response.json({ text });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "stt failed" },
      { status: 502 },
    );
  }
}
