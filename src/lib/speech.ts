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

/** In-browser Whisper transcription (offline fallback). */
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
 * Transcribe audio: prefer xAI cloud STT (/api/stt, fast + accurate), fall back
 * to in-browser Whisper when the cloud is unavailable.
 */
export async function transcribe(blob: Blob): Promise<string> {
  try {
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    const res = await fetch("/api/stt", { method: "POST", body: fd });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.text === "string" && data.text.trim()) {
        return data.text.trim();
      }
      return "";
    }
  } catch {
    /* fall through to local whisper */
  }
  return transcribeLocal(blob);
}

export function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}
