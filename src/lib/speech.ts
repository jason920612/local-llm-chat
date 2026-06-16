"use client";

/**
 * In-browser speech-to-text using Whisper via transformers.js.
 * The model (~150MB) is downloaded from the HF hub on first use and then cached
 * by the browser; transcription itself runs locally (WASM/WebGPU).
 */

// transformers.js types are loaded lazily; keep this module light.
type Transcriber = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

let transcriberPromise: Promise<Transcriber> | null = null;

const MODEL_ID = "Xenova/whisper-base";

export function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      const pipe = await pipeline("automatic-speech-recognition", MODEL_ID);
      return pipe as unknown as Transcriber;
    })();
  }
  return transcriberPromise;
}

/** Decode an audio Blob and resample to 16kHz mono Float32 for Whisper. */
async function blobToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  const AudioCtx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  const ctx = new AudioCtx();
  const decoded = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const targetRate = 16000;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * targetRate),
    targetRate,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

/** In-browser Whisper transcription (offline fallback when no cloud key). */
async function transcribeLocal(blob: Blob): Promise<string> {
  const audio = await blobToMono16k(blob);
  const transcriber = await getTranscriber();
  const result = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const text = Array.isArray(result)
    ? result.map((r) => r.text).join(" ")
    : result.text;
  return (text ?? "").trim();
}

/**
 * Transcribe audio: convert to WAV (a format xAI STT reliably accepts) and send
 * to the cloud. If no API key is configured (503), fall back to in-browser
 * Whisper. Other failures throw so the UI can show them.
 */
function extFor(type: string): string {
  if (type.includes("ogg")) return "audio.ogg";
  if (type.includes("mp4") || type.includes("m4a")) return "audio.mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio.mp3";
  if (type.includes("wav")) return "audio.wav";
  return "audio.webm";
}

export async function transcribe(blob: Blob): Promise<string> {
  // Convert to 16kHz mono WAV (reliably accepted). If decoding fails, send the
  // original blob with a CORRECT extension (never mislabel webm as wav).
  let file: Blob;
  let name: string;
  try {
    const samples = await blobToMono16k(blob);
    if (samples.length < 1600) {
      throw new Error("錄音太短或沒有聲音"); // < 0.1s of 16k audio
    }
    file = encodeWav(samples, 16000);
    name = "audio.wav";
  } catch (e) {
    if (e instanceof Error && e.message.includes("錄音太短")) throw e;
    file = blob;
    name = extFor(blob.type);
  }

  const fd = new FormData();
  fd.append("file", file, name);
  const res = await fetch("/api/stt", { method: "POST", body: fd });
  if (!res.ok) {
    try {
      return await transcribeLocal(blob);
    } catch (fallbackErr) {
      const data = await res.json().catch(() => ({}));
      const cloudError = data.error || `STT failed (${res.status})`;
      const localError =
        fallbackErr instanceof Error ? fallbackErr.message : "local STT failed";
      throw new Error(`${cloudError}; local fallback failed: ${localError}`);
    }
  }

  const data = await res.json();
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (text) return text;
  return transcribeLocal(blob);
}

export function mediaPermissionBlockedReason(): string | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "語音輸入只能在瀏覽器中使用";
  }

  if (!window.isSecureContext) {
    return "手機瀏覽器需要 HTTPS 才能使用麥克風；目前的 LAN HTTP 網址會被瀏覽器封鎖";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "這個瀏覽器沒有開放麥克風存取 API";
  }

  if (typeof MediaRecorder === "undefined") {
    return "這個瀏覽器不支援錄音";
  }

  return null;
}

export function recordingSupported(): boolean {
  return mediaPermissionBlockedReason() === null;
}
