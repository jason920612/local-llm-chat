"use client";

import { useEffect, useRef, useState } from "react";
import { X, Mic, PhoneOff } from "lucide-react";
import { RealtimeSession } from "@/lib/realtime";

type Status = "connecting" | "listening" | "speaking" | "closed";

export function VoiceMode({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [userText, setUserText] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setUserText("");
    setAssistantText("");
    setStatus("connecting");

    const session = new RealtimeSession({
      onStatus: setStatus,
      onUserText: (d) => setUserText((p) => p + d),
      onAssistantText: (d) => setAssistantText((p) => p + d),
      onError: (m) => setError(m),
    });
    sessionRef.current = session;
    session.start().catch((e) =>
      setError(e instanceof Error ? e.message : "failed to start"),
    );

    return () => {
      session.stop();
      sessionRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const statusLabel: Record<Status, string> = {
    connecting: "連線中…",
    listening: "聆聽中…請說話",
    speaking: "Grok 回應中…",
    closed: "已結束",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <button
          onClick={onClose}
          className="self-end text-muted hover:text-foreground"
        >
          <X size={18} />
        </button>

        <div
          className={`mt-2 flex h-24 w-24 items-center justify-center rounded-full ${
            status === "speaking"
              ? "bg-accent/20"
              : status === "listening"
                ? "bg-emerald-500/15"
                : "bg-surface-2"
          }`}
        >
          <Mic
            size={36}
            className={
              status === "listening"
                ? "text-emerald-400"
                : status === "speaking"
                  ? "text-accent"
                  : "text-muted"
            }
          />
        </div>

        <div className="mt-4 text-sm font-medium">{statusLabel[status]}</div>
        {error && (
          <div className="mt-2 text-center text-xs text-red-400">{error}</div>
        )}

        <div className="mt-4 max-h-40 w-full space-y-2 overflow-y-auto text-sm">
          {userText && (
            <p>
              <span className="text-muted">你：</span>
              {userText}
            </p>
          )}
          {assistantText && (
            <p>
              <span className="text-muted">Grok：</span>
              {assistantText}
            </p>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-6 flex items-center gap-2 rounded-full bg-red-500/90 px-5 py-2 text-sm font-medium text-white hover:bg-red-500"
        >
          <PhoneOff size={16} /> 結束對話
        </button>
        <p className="mt-3 text-center text-[11px] text-muted">
          即時語音對語音（xAI Realtime）。需要麥克風權限。
        </p>
      </div>
    </div>
  );
}
