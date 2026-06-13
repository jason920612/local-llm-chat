"use client";

import { useEffect, useState } from "react";
import {
  User,
  Bot,
  Volume2,
  Square,
  Loader2,
  Pencil,
  GitBranch,
  Check,
  X,
} from "lucide-react";
import type { UIMessage } from "@/lib/types";
import { speak, stopSpeaking, ttsSupported } from "@/lib/tts";
import { parseThinking } from "@/lib/think";
import { Markdown } from "./Markdown";
import { Thinking } from "./Thinking";

export function MessageBubble({
  message,
  streaming,
  canEdit,
  onEdit,
  onFork,
}: {
  message: UIMessage;
  streaming?: boolean;
  canEdit?: boolean;
  onEdit?: (id: string, newText: string) => void;
  onFork?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const [canTts, setCanTts] = useState(false);
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">(
    "idle",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => setCanTts(ttsSupported()), []);
  useEffect(() => () => stopSpeaking(), []);

  // Split reasoning (<think>) from the answer for assistant messages.
  const { thinking, answer, thinkingStreaming } = isUser
    ? { thinking: "", answer: message.content, thinkingStreaming: false }
    : parseThinking(message.content);

  function toggleSpeak() {
    if (ttsState !== "idle") {
      stopSpeaking();
      setTtsState("idle");
      return;
    }
    setTtsState("loading");
    speak(answer, {
      onStart: () => setTtsState("playing"),
      onEnd: () => setTtsState("idle"),
    }); // never read the reasoning aloud
  }

  return (
    <div className="group flex gap-3 px-4 py-4">
      <div
        className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-accent-strong" : "bg-surface-2"
        }`}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">
            {isUser ? "You" : "Assistant"}
          </span>
          {!isUser && canTts && !streaming && answer.trim() && (
            <button
              onClick={toggleSpeak}
              className="text-muted hover:text-foreground"
              title={
                ttsState === "idle"
                  ? "Read aloud"
                  : ttsState === "loading"
                    ? "Generating audio…"
                    : "Stop"
              }
            >
              {ttsState === "loading" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : ttsState === "playing" ? (
                <Square size={12} />
              ) : (
                <Volume2 size={13} />
              )}
            </button>
          )}
          {canEdit && !editing && (
            <span className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
              {onEdit && (
                <button
                  onClick={() => {
                    setDraft(message.content);
                    setEditing(true);
                  }}
                  className="text-muted hover:text-foreground"
                  title="編輯此輪"
                >
                  <Pencil size={12} />
                </button>
              )}
              {onFork && (
                <button
                  onClick={() => onFork(message.id)}
                  className="text-muted hover:text-foreground"
                  title="從此處分支對話"
                >
                  <GitBranch size={12} />
                </button>
              )}
            </span>
          )}
        </div>

        {message.images && message.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`attachment ${i + 1}`}
                onClick={() => setLightbox(src)}
                className="max-h-64 cursor-zoom-in rounded-lg border border-border object-contain transition hover:opacity-90"
              />
            ))}
          </div>
        )}

        {message.videos && message.videos.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.videos.map((src, i) => (
              <video
                key={i}
                src={src}
                controls
                className="max-h-72 rounded-lg border border-border"
              />
            ))}
          </div>
        )}

        {editing ? (
          <div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              rows={Math.min(12, draft.split("\n").length + 1)}
              className="w-full resize-y rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none focus:border-accent"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={() => {
                  onEdit?.(message.id, draft);
                  setEditing(false);
                }}
                className="flex items-center gap-1 rounded-md bg-accent-strong px-2.5 py-1 text-xs text-white hover:bg-accent"
              >
                <Check size={12} />
                {isUser ? "儲存並重新產生" : "儲存"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted hover:text-foreground"
              >
                <X size={12} /> 取消
              </button>
            </div>
          </div>
        ) : isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <>
            <Thinking
              content={thinking}
              live={streaming && thinkingStreaming}
            />
            <Markdown>
              {answer || (streaming ? "" : "_(empty response)_")}
            </Markdown>
          </>
        )}

        {streaming && (
          <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent align-middle" />
        )}

        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Sources
            </div>
            <ol className="space-y-1">
              {message.citations.map((c) => (
                <li key={c.index} className="flex gap-2 text-xs text-muted">
                  <span className="shrink-0 font-semibold text-accent">
                    [{c.index}]
                  </span>
                  <span className="min-w-0">
                    <span className="text-foreground">{c.documentName}</span>
                    {c.snippet ? ` — ${c.snippet}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="preview"
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 text-white/80 hover:text-white"
            title="關閉"
          >
            <X size={24} />
          </button>
        </div>
      )}
    </div>
  );
}
