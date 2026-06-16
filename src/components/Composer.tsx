"use client";

import { useRef, useEffect, useState } from "react";
import { Send, Square, Paperclip, X, Mic, Loader2, FileUp } from "lucide-react";
import {
  mediaPermissionBlockedReason,
  recordingSupported,
  transcribe,
} from "@/lib/speech";
import { StreamingSttSession } from "@/lib/streaming-stt";
import type { SandboxFileMeta } from "@/lib/types";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  attachments,
  onFiles,
  onRemoveAttachment,
  sandboxFiles,
  onRemoveSandboxFile,
  isMobile,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  attachments: string[];
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  sandboxFiles: SandboxFileMeta[];
  onRemoveSandboxFile: (name: string) => void;
  isMobile?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamingSttRef = useRef<StreamingSttSession | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const valueRef = useRef(value);
  const committedStreamTextRef = useRef("");
  valueRef.current = value;

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceUnavailableReason, setVoiceUnavailableReason] = useState<
    string | null
  >(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const [sttPartial, setSttPartial] = useState("");

  useEffect(() => {
    setVoiceSupported(recordingSupported());
    setVoiceUnavailableReason(mediaPermissionBlockedReason());
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 || attachments.length > 0;

  function appendTranscript(text: string) {
    const clean = text.trim();
    if (!clean || clean === committedStreamTextRef.current) return;
    committedStreamTextRef.current = clean;
    const prev = valueRef.current;
    onChange(prev ? `${prev} ${clean}` : clean);
  }

  async function startBufferedRecording() {
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
          appendTranscript(text);
        } else {
          setSttError("沒有辨識到語音");
        }
      } catch (err) {
        setSttError(err instanceof Error ? err.message : "語音辨識失敗");
      } finally {
        setTranscribing(false);
      }
    };
    mr.start();
    recorderRef.current = mr;
  }

  async function startRecording() {
    setSttError(null);
    setSttPartial("");
    committedStreamTextRef.current = "";
    const blockedReason = mediaPermissionBlockedReason();
    if (blockedReason) {
      setSttError(blockedReason);
      return;
    }
    try {
      const stt = new StreamingSttSession({
        onPartial: setSttPartial,
        onFinal: (text) => {
          setSttPartial("");
          appendTranscript(text);
        },
        onError: (msg) => setSttError(msg),
      });
      await stt.start();
      streamingSttRef.current = stt;
      setRecording(true);
    } catch (err) {
      streamingSttRef.current?.stop();
      streamingSttRef.current = null;
      try {
        await startBufferedRecording();
        setRecording(true);
      } catch {
        setRecording(false);
        setSttError(
          err instanceof Error
            ? `串流語音無法啟動，且無法存取麥克風：${err.message}`
            : "無法存取麥克風，請確認瀏覽器權限與系統麥克風設定",
        );
      }
    }
  }

  function stopRecording() {
    const streamedText = streamingSttRef.current?.stop().trim() ?? "";
    streamingSttRef.current = null;
    if (streamedText) appendTranscript(streamedText);
    setSttPartial("");
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (isMobile) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming && canSend) onSend();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      onFiles(files);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    e.target.value = "";
  }

  return (
    <div className="border-t border-border bg-surface/60 px-3 py-3 backdrop-blur sm:px-4 [padding-bottom:calc(0.75rem+env(safe-area-inset-bottom))]">
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

        {sandboxFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {sandboxFiles.map((f) => (
              <span
                key={f.name}
                className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
              >
                <FileUp size={12} className="text-accent" />
                <span className="max-w-[160px] truncate font-mono">
                  {f.name}
                </span>
                <button
                  onClick={() => onRemoveSandboxFile(f.name)}
                  className="text-muted hover:text-red-400"
                  title="Remove"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled || streaming}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-foreground disabled:opacity-40"
            title="附加檔案（圖片或資料檔）"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={handleFileInput}
          />

          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={disabled || transcribing || !voiceSupported}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-40 ${
              recording
                ? "bg-red-500/20 text-red-400"
                : "text-muted hover:bg-surface hover:text-foreground"
            }`}
            title={
              voiceUnavailableReason ??
              (recording
                ? "停止錄音"
                : transcribing
                  ? "語音辨識中…"
                  : "語音輸入")
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

          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              isMobile
                ? "Send a message or attach an image..."
                : "Send a message or attach an image...  (Enter to send)"
            }
            className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-muted disabled:opacity-50 sm:text-sm"
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
      {sttPartial ? (
        <p className="mx-auto mt-1.5 max-w-3xl truncate text-center text-[11px] text-accent">
          聽寫中：{sttPartial}
        </p>
      ) : sttError || voiceUnavailableReason ? (
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-red-400">
          {sttError ?? voiceUnavailableReason}
        </p>
      ) : (
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted">
          Runs locally via LM Studio · responses may be wrong — verify important
          facts
        </p>
      )}
    </div>
  );
}
