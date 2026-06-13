"use client";

import { useRef, useEffect, useState } from "react";
import { Send, Square, ImagePlus, X, Mic, Loader2 } from "lucide-react";
import { recordingSupported, transcribe } from "@/lib/speech";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  attachments: string[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const valueRef = useRef(value);
  valueRef.current = value;

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);

  useEffect(() => {
    setVoiceSupported(recordingSupported());
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 || attachments.length > 0;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: mr.mimeType || "audio/webm",
        });
        setTranscribing(true);
        try {
          const text = await transcribe(blob);
          if (text) {
            const prev = valueRef.current;
            onChange(prev ? `${prev} ${text}` : text);
          }
        } catch {
          /* transcription failed — silently ignore */
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch {
      setRecording(false);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming && canSend) onSend();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) {
      e.preventDefault();
      onAttachFiles(files);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onAttachFiles(files);
    e.target.value = "";
  }

  return (
    <div className="border-t border-border bg-surface/60 px-4 py-3 backdrop-blur">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface-2 px-3 py-2 focus-within:border-accent">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((src, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={`attachment ${i + 1}`}
                  className="h-16 w-16 rounded-lg border border-border object-cover"
                />
                <button
                  onClick={() => onRemoveAttachment(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-foreground hover:bg-red-500"
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled || streaming}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-foreground disabled:opacity-40"
            title="Attach image"
          >
            <ImagePlus size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleFileInput}
          />

          {voiceSupported && (
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={disabled || transcribing}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:opacity-40 ${
                recording
                  ? "bg-red-500/20 text-red-400"
                  : "text-muted hover:bg-surface hover:text-foreground"
              }`}
              title={
                recording
                  ? "Stop recording"
                  : transcribing
                    ? "Transcribing…"
                    : "Record voice (Whisper, in-browser)"
              }
            >
              {transcribing ? (
                <Loader2 size={18} className="animate-spin" />
              ) : recording ? (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              ) : (
                <Mic size={18} />
              )}
            </button>
          )}

          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Send a message or attach an image…  (Enter to send)"
            className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted disabled:opacity-50"
            // Browser extensions (writing assistants, etc.) inject attributes
            // into inputs after SSR; suppress the resulting benign hydration diff.
            suppressHydrationWarning
          />

          {streaming ? (
            <button
              onClick={onStop}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-foreground hover:bg-border"
              title="Stop"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={disabled || !canSend}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-strong text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              title="Send"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted">
        Runs locally via LM Studio · responses may be wrong — verify important
        facts
      </p>
    </div>
  );
}
