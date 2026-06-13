"use client";

import { useRef, useEffect } from "react";
import { Send, Square, ImagePlus, X } from "lucide-react";

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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 || attachments.length > 0;

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
