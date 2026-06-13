"use client";

import { useRef, useEffect } from "react";
import { Send, Square } from "lucide-react";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming && value.trim()) onSend();
    }
  }

  return (
    <div className="border-t border-border bg-surface/60 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-surface-2 px-3 py-2 focus-within:border-accent">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
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
            disabled={disabled || !value.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-strong text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            title="Send"
          >
            <Send size={16} />
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted">
        Runs locally via LM Studio · responses may be wrong — verify important
        facts
      </p>
    </div>
  );
}
