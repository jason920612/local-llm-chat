"use client";

import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

/** Collapsible chain-of-thought block. Collapsed by default. */
export function Thinking({
  content,
  live,
}: {
  content: string;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!content.trim()) return null;

  return (
    <div className="mb-2 max-w-full overflow-hidden rounded-lg border border-border/70 bg-surface-2/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted hover:text-foreground"
      >
        <ChevronRight
          size={13}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Brain size={13} />
        <span>{live ? "思考中…" : "思考過程"}</span>
        {!open && <span className="text-muted/60">（點擊展開）</span>}
      </button>
      {open && (
        <div className="whitespace-pre-wrap break-words border-t border-border/70 px-3 py-2 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
          {content}
        </div>
      )}
    </div>
  );
}
