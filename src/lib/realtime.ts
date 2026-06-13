"use client";

/**
 * xAI Realtime voice agent client (speech-to-speech over WebSocket).
 *
 * Flow: mint an ephemeral token (/api/realtime/token) -> open WS to
 * wss://api.x.ai/v1/realtime (token via subprotocol) -> session.update ->
 * stream mic as PCM16 (input_audio_buffer.append) with server VAD -> play back
 * response.output_audio.delta chunks and surface transcripts.
 *
 * NOTE: audio is PCM16 mono @ 24kHz. Exact realtime audio params may need tuning
 * against xAI's spec; this is a best-effort implementation.
 */

const WS_URL = "wss://api.x.ai/v1/realtime";
const SAMPLE_RATE = 24000;

export interface RealtimeCallbacks {
  onStatus?: (s: "connecting" | "listening" | "speaking" | "closed") => void;
  onUserText?: (delta: string) => void;
  onAssistantText?: (delta: string) => void;
  onError?: (msg: string) => void;
}

function floatToPcm16Base64(input: Float32Array): string {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private playCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private playHead = 0;
  private cb: RealtimeCallbacks;

  constructor(cb: RealtimeCallbacks) {
    this.cb = cb;
  }

  async start(voice = "eve"): Promise<void> {
    this.cb.onStatus?.("connecting");
    const tokenRes = await fetch("/api/realtime/token", { method: "POST" });
    if (!tokenRes.ok) throw new Error("Could not get realtime token");
    const { value } = await tokenRes.json();
    if (!value) throw new Error("No realtime token");

    const ws = new WebSocket(WS_URL, ["xai-client-secret." + value]);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            model: "grok-voice-latest",
            voice,
            modalities: ["audio", "text"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
          },
        }),
      );
      this.startMic().catch((e) =>
        this.cb.onError?.(e instanceof Error ? e.message : "mic error"),
      );
      this.cb.onStatus?.("listening");
    };

    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onerror = () => this.cb.onError?.("websocket error");
    ws.onclose = () => this.cb.onStatus?.("closed");
  }

  private async startMic(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const audio = floatToPcm16Base64(e.inputBuffer.getChannelData(0));
      this.ws.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio }),
      );
    };
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private handle(raw: string): void {
    let msg: { type?: string; delta?: string; transcript?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "response.output_audio.delta":
        if (msg.delta) this.playChunk(msg.delta);
        this.cb.onStatus?.("speaking");
        break;
      case "response.output_audio_transcript.delta":
        if (msg.delta) this.cb.onAssistantText?.(msg.delta);
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (msg.delta) this.cb.onUserText?.(msg.delta);
        break;
      case "response.done":
        this.cb.onStatus?.("listening");
        break;
      case "error":
        this.cb.onError?.(msg.transcript || "realtime error");
        break;
    }
  }

  private playChunk(b64: string): void {
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!this.playCtx) this.playCtx = new Ctx({ sampleRate: SAMPLE_RATE });
    const data = base64ToFloat32(b64);
    const buffer = this.playCtx.createBuffer(1, data.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(data);
    const src = this.playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playCtx.destination);
    const now = this.playCtx.currentTime;
    this.playHead = Math.max(this.playHead, now);
    src.start(this.playHead);
    this.playHead += buffer.duration;
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.playCtx?.close();
    this.ws?.close();
    this.ws = null;
    this.cb.onStatus?.("closed");
  }
}

export function realtimeSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}
