"use client";

const SAMPLE_RATE = 16000;

export interface StreamingSttCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export class StreamingSttSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ready = false;
  private finalText = "";
  private cb: StreamingSttCallbacks;

  constructor(cb: StreamingSttCallbacks) {
    this.cb = cb;
  }

  async start(): Promise<void> {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      interim_results: "true",
    });
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/stt/stream?${params}`,
    );
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => this.handleMessage(ev.data);

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("STT websocket timeout")),
        10000,
      );
      ws.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("STT websocket error"));
      };
    });

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);

    ws.onclose = () => {
      this.ready = false;
    };

    this.node.onaudioprocess = (e) => {
      if (!this.ready || this.ws?.readyState !== WebSocket.OPEN || !this.ctx) {
        return;
      }
      const mono = e.inputBuffer.getChannelData(0);
      const resampled = downsample(mono, this.ctx.sampleRate, SAMPLE_RATE);
      this.ws.send(floatToPcm16(resampled));
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private handleMessage(raw: unknown): void {
    let msg: {
      type?: string;
      text?: string;
      transcript?: string;
      is_final?: boolean;
      speech_final?: boolean;
      error?: string | { message?: string };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "transcript.created") {
      this.ready = true;
      return;
    }

    if (msg.type === "transcript.partial" || msg.type === "transcript.done") {
      const text = (msg.text ?? msg.transcript ?? "").trim();
      if (!text) return;
      if (msg.type === "transcript.done" || msg.speech_final) {
        this.finalText = text;
        this.cb.onFinal?.(text);
      } else if (msg.is_final) {
        this.finalText = this.finalText
          ? `${this.finalText} ${text}`.trim()
          : text;
        this.cb.onPartial?.(this.finalText);
      } else {
        this.cb.onPartial?.(
          this.finalText ? `${this.finalText} ${text}`.trim() : text,
        );
      }
      return;
    }

    if (msg.type === "error") {
      const err =
        typeof msg.error === "string" ? msg.error : msg.error?.message;
      this.cb.onError?.(err || "Streaming STT error");
    }
  }

  stop(): string {
    const final = this.finalText.trim();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "audio.done" }));
      }
    } catch {
      /* ignore */
    }
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ws?.close();
    this.ws = null;
    this.ready = false;
    return final;
  }
}
