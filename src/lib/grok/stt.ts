import { config } from "../config";

/**
 * Host-side xAI batch Speech-to-Text (`/v1/stt`). Takes an audio file's bytes
 * and returns the transcript text. Used by the /api/stt proxy route and by the
 * `watch_video` tool (which transcribes a video's extracted audio track).
 *
 * xAI requires the `file` field to come AFTER all other form fields. We skip
 * `format=true` (which would pin a language) so transcription auto-detects.
 */
export async function transcribeAudio(
  bytes: Uint8Array | Blob,
  filename = "audio.webm",
): Promise<string> {
  if (!config.grok.enabled) throw new Error("XAI_API_KEY not set");

  const form = new FormData();
  if (config.grok.serviceTier) form.append("service_tier", config.grok.serviceTier);
  const blob =
    bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
  form.append("file", blob, filename);

  const res = await fetch(`${config.grok.baseURL}/stt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.grok.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI stt ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: unknown };
  return typeof data.text === "string" ? data.text : "";
}

/** Format seconds as a compact `[mm:ss]` (or `[h:mm:ss]`) timestamp. */
export function fmtTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `[${h}:${pad(m)}:${pad(ss)}]` : `[${pad(m)}:${pad(ss)}]`;
}

/**
 * Transcribe a list of contiguous audio chunks (each covering `chunkSec`
 * seconds, in order) into a single transcript with a coarse timestamp prefix
 * per chunk. The plain `/stt` endpoint returns whole-clip text only, so coarse
 * timestamps come from splitting the audio upstream (in the guest) and labeling
 * each chunk by its start time here. Empty/failed chunks are skipped.
 */
export async function transcribeChunks(
  chunks: { bytes: Uint8Array; startSec: number; filename?: string }[],
): Promise<string> {
  const lines: string[] = [];
  for (const ch of chunks) {
    let text = "";
    try {
      text = (await transcribeAudio(ch.bytes, ch.filename)).trim();
    } catch {
      continue;
    }
    if (text) lines.push(`${fmtTimestamp(ch.startSec)} ${text}`);
  }
  return lines.join("\n");
}
