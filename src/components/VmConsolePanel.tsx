"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Monitor, X } from "lucide-react";

/**
 * Live, view-only VM Console. While open it subscribes to the conversation's
 * screen-stream SSE; the server only captures frames while a subscriber is
 * connected, so closing this panel (or the EventSource) stops VM-side capture.
 */
export function VmConsolePanel({
  open,
  conversationId,
  isMobile,
  onClose,
}: {
  open: boolean;
  conversationId: string | null;
  isMobile: boolean;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastFrameAt = useRef(0);

  useEffect(() => {
    if (!open || !conversationId) return;
    setFrame(null);
    setWaiting(true);
    setError(null);
    const es = new EventSource(
      `/api/sandbox/${encodeURIComponent(conversationId)}/screen-stream`,
    );
    es.onmessage = (ev) => {
      let e: { type?: string; jpg?: string; error?: string };
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.type === "frame" && e.jpg) {
        setFrame(e.jpg);
        setWaiting(false);
        setError(null);
        lastFrameAt.current = Date.now();
      } else if (e.type === "waiting") {
        // Only fall back to the spinner if we haven't seen a frame recently.
        if (Date.now() - lastFrameAt.current > 3000) setWaiting(true);
      } else if (e.type === "error") {
        setError(e.error || "VM screen stream failed.");
        setWaiting(false);
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };
    return () => es.close();
  }, [open, conversationId]);

  if (!open) return null;

  return (
    <aside
      className={
        isMobile
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex w-[440px] shrink-0 flex-col border-l border-border bg-background"
      }
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Monitor size={16} className="text-accent" />
        <span className="flex-1 text-sm font-medium">VM Console</span>
        <span className="text-[11px] text-muted">view-only live</span>
        <button
          onClick={onClose}
          title="Close"
          className="-mr-1 p-1 text-muted transition hover:text-foreground"
        >
          <X size={18} />
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-black/90 p-2">
        {!conversationId ? (
          <p className="text-sm text-muted">No conversation selected.</p>
        ) : error ? (
          <p className="max-w-sm text-center text-sm text-red-300">{error}</p>
        ) : frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frame}
            alt="VM screen"
            className="max-h-full max-w-full rounded border border-border object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-muted">
            <Loader2 size={28} className="animate-spin" />
            <p className="text-sm">
              {waiting ? "Starting VM display..." : "Waiting for frames..."}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
