import { config } from "../config";

export interface SttWord {
  text: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface SttTranscript {
  text: string;
  language?: string;
  duration?: number;
  words: SttWord[];
}

/**
 * Host-side xAI batch Speech-to-Text (`/v1/stt`). Takes an audio file's bytes
 * and returns the transcript text. Used by the /api/stt proxy route and by the
 * `watch_video` tool (which transcribes a video's extracted audio track).
 *
 * xAI requires the `file` field to come AFTER all other form fields. We skip
 * `format=true` (which would pin a language) so transcription auto-detects.
 */
export async function transcribeAudioDetailed(
  bytes: Uint8Array | Blob,
  filename = "audio.webm",
): Promise<SttTranscript> {
  if (!config.grok.enabled) throw new Error("XAI_API_KEY not set");

  const form = new FormData();
  if (config.grok.serviceTier) {
    form.append("service_tier", config.grok.serviceTier);
  }
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
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
  const data = (await res.json().catch(() => ({}))) as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
    words?: unknown;
  };
  return {
    text: typeof data.text === "string" ? data.text : "",
    language: typeof data.language === "string" ? data.language : undefined,
    duration: typeof data.duration === "number" ? data.duration : undefined,
    words: parseWords(data.words),
  };
}

export async function transcribeAudio(
  bytes: Uint8Array | Blob,
  filename = "audio.webm",
): Promise<string> {
  return (await transcribeAudioDetailed(bytes, filename)).text;
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

function fmtTimestampPrecise(sec: number): string {
  const n = Math.max(0, sec);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad2 = (v: number) => String(v).padStart(2, "0");
  const secText = s.toFixed(2).padStart(5, "0");
  return h > 0
    ? `${h}:${pad2(m)}:${secText}`
    : `${pad2(m)}:${secText}`;
}

function parseWords(raw: unknown): SttWord[] {
  if (!Array.isArray(raw)) return [];
  const words: SttWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as {
      text?: unknown;
      start?: unknown;
      end?: unknown;
      speaker?: unknown;
    };
    if (
      typeof r.text !== "string" ||
      typeof r.start !== "number" ||
      typeof r.end !== "number"
    ) {
      continue;
    }
    words.push({
      text: r.text,
      start: r.start,
      end: r.end,
      speaker: typeof r.speaker === "number" ? r.speaker : undefined,
    });
  }
  return words;
}

function joinWordText(words: SttWord[]): string {
  let text = "";
  for (const w of words) {
    const token = w.text.trim();
    if (!token) continue;
    if (!text) {
      text = token;
    } else if (isLeadingPunctuation(token)) {
      text += token;
    } else if (endsWithOpeningBracket(text)) {
      text += token;
    } else {
      text += ` ${token}`;
    }
  }
  return text;
}

function wordsToTimedSentences(words: SttWord[]): string[] {
  const lines: string[] = [];
  let sentence: SttWord[] = [];
  const flush = () => {
    if (!sentence.length) return;
    const start = sentence[0].start;
    const end = sentence[sentence.length - 1].end;
    const text = joinWordText(sentence);
    if (text) {
      lines.push(`[${fmtTimestampPrecise(start)}-${fmtTimestampPrecise(end)}] ${text}`);
    }
    sentence = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    sentence.push(word);
    const token = word.text.trim();
    const next = words[i + 1];
    const gap = next ? next.start - word.end : 0;
    const endsSentence = endsSentenceToken(token);
    const longWithPause = sentence.length >= 12 && gap >= 0.9;
    const tooLong = sentence.length >= 36;
    if (endsSentence || longWithPause || tooLong) flush();
  }
  flush();
  return lines;
}

function isLeadingPunctuation(token: string): boolean {
  if (/^[,.;:!?\]\})]/.test(token)) return true;
  const cp = token.codePointAt(0);
  return (
    cp === 0x3001 || // ideographic comma
    cp === 0x3002 || // ideographic full stop
    cp === 0xff01 || // fullwidth exclamation mark
    cp === 0xff09 || // fullwidth right parenthesis
    cp === 0xff0c || // fullwidth comma
    cp === 0xff1a || // fullwidth colon
    cp === 0xff1b || // fullwidth semicolon
    cp === 0xff1f // fullwidth question mark
  );
}

function endsWithOpeningBracket(text: string): boolean {
  const last = text.codePointAt(text.length - 1);
  return /[\(\[\{]$/.test(text) || last === 0xff08;
}

function endsSentenceToken(token: string): boolean {
  if (/[.!?]$/.test(token)) return true;
  const last = token.codePointAt(token.length - 1);
  return last === 0x3002 || last === 0xff01 || last === 0xff1f;
}

/**
 * Transcribe a list of contiguous audio chunks (each covering `chunkSec`
 * seconds, in order) into a single transcript with a coarse timestamp prefix
 * per sentence. Empty/failed chunks are skipped, but successful chunks preserve
 * xAI word-level timestamps when available.
 */
export async function transcribeChunks(
  chunks: { bytes: Uint8Array; startSec: number; filename?: string }[],
): Promise<string> {
  const concurrency = Math.max(
    1,
    Math.min(
      chunks.length || 1,
      Math.floor(config.grok.stt.maxConcurrent) || 1,
    ),
  );
  const lines = new Array<string>(chunks.length).fill("");
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= chunks.length) return;
      const ch = chunks[index];
      try {
        const transcript = await transcribeAudioDetailed(ch.bytes, ch.filename);
        if (transcript.words.length) {
          const shifted = transcript.words.map((w) => ({
            ...w,
            start: w.start + ch.startSec,
            end: w.end + ch.startSec,
          }));
          lines[index] = wordsToTimedSentences(shifted).join("\n");
        } else {
          const text = transcript.text.trim();
          if (text) lines[index] = `${fmtTimestamp(ch.startSec)} ${text}`;
        }
      } catch {
        // One failed chunk should not discard the rest of a long video.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return lines.filter(Boolean).join("\n");
}
