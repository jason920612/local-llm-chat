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
  FileCode,
  Wrench,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Maximize2,
  Download,
} from "lucide-react";
import type {
  UIMessage,
  SandboxFileMeta,
  ToolCallTrace,
  ArtifactMeta,
} from "@/lib/types";
import { speak, stopSpeaking, ttsSupported } from "@/lib/tts";
import { parseThinking } from "@/lib/think";
import { Markdown } from "./Markdown";
import { Thinking } from "./Thinking";
import { FilePreview, isPreviewable } from "./FilePreview";
import { ImageViewer, VideoPlayer } from "./MediaViewer";
import { Artifact } from "./Artifact";

/**
 * Renders an assistant answer, placing generated media at the model's inline
 * markers ([[image:N]] / [[video:N]] / [[file:name]]); unreferenced media is
 * appended at the end.
 */
function AssistantBody({
  answer,
  images,
  videos,
  files,
  artifacts,
  conversationId,
  onImageClick,
  onOpenFile,
  streaming,
}: {
  answer: string;
  images?: string[];
  videos?: string[];
  files?: SandboxFileMeta[];
  artifacts?: ArtifactMeta[];
  conversationId?: string | null;
  onImageClick: (src: string) => void;
  onOpenFile: (name: string) => void;
  streaming?: boolean;
}) {
  const imgs = images ?? [];
  const vids = videos ?? [];
  const fls = files ?? [];
  const arts = artifacts ?? [];

  const artifactEl = (a: ArtifactMeta, key: string) => (
    <div key={key} className="my-2">
      <Artifact kind={a.type} code={a.spec} />
    </div>
  );

  const imageEl = (src: string, key: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={key}
      src={src}
      alt=""
      onClick={() => onImageClick(src)}
      className="my-2 max-h-72 cursor-zoom-in rounded-lg border border-border object-contain hover:opacity-90"
    />
  );
  const videoEl = (src: string, key: string) => (
    <div key={key} className="my-2 max-w-md">
      <VideoPlayer src={src} inline />
    </div>
  );
  const dlUrl = (name: string) =>
    `/api/sandbox/${conversationId}/file?name=${encodeURIComponent(name)}&download=1`;

  const fileEl = (f: SandboxFileMeta, key: string) => (
    <div
      key={key}
      className="my-2 flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs"
    >
      <FileCode size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
      <span className="shrink-0 text-muted">{f.size}B</span>
      {f.isText || isPreviewable(f.name) ? (
        <button
          onClick={() => onOpenFile(f.name)}
          className="shrink-0 text-accent hover:text-foreground"
        >
          檢視
        </button>
      ) : (
        <a href={dlUrl(f.name)} className="shrink-0 text-accent hover:text-foreground">
          下載
        </a>
      )}
    </div>
  );

  // Inline rendered preview card (used at [[file:NAME]] markers for previewable
  // types), with expand-to-modal + download — same idea as artifacts.
  const fileInline = (f: SandboxFileMeta, key: string) => {
    if (!conversationId || !isPreviewable(f.name)) return fileEl(f, key);
    return (
      <div key={key} className="my-2 overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-1.5 text-xs">
          <FileCode size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
          <button
            onClick={() => onOpenFile(f.name)}
            className="shrink-0 text-muted hover:text-foreground"
            title="展開"
          >
            <Maximize2 size={13} />
          </button>
          <a
            href={dlUrl(f.name)}
            className="shrink-0 text-muted hover:text-foreground"
            title="下載"
          >
            <Download size={13} />
          </a>
        </div>
        <FilePreview conversationId={conversationId} name={f.name} compact />
      </div>
    );
  };

  const usedImg = new Set<number>();
  const usedVid = new Set<number>();
  const usedFile = new Set<string>();
  const usedArt = new Set<number>();
  const nodes: React.ReactNode[] = [];
  const re = /\[\[(image|video|file|artifact):([^\]\n]+)\]\]/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    // Drop a stray "image:/video:/file:" label the model may write before a marker.
    const seg = answer
      .slice(last, m.index)
      .replace(/(?:image|video|file|artifact)\s*[:：]\s*$/i, "");
    if (seg.trim())
      nodes.push(
        <Markdown key={`t${k}`} streaming={streaming}>
          {seg}
        </Markdown>,
      );
    const ref = m[2].trim();
    if (m[1] === "image") {
      const i = parseInt(ref, 10) - 1;
      if (imgs[i]) {
        usedImg.add(i);
        nodes.push(imageEl(imgs[i], `m${k}`));
      }
    } else if (m[1] === "video") {
      const i = parseInt(ref, 10) - 1;
      if (vids[i]) {
        usedVid.add(i);
        nodes.push(videoEl(vids[i], `m${k}`));
      }
    } else if (m[1] === "artifact") {
      const i = parseInt(ref, 10) - 1;
      if (arts[i]) {
        usedArt.add(i);
        nodes.push(artifactEl(arts[i], `m${k}`));
      }
    } else {
      const f = fls.find((x) => x.name === ref);
      if (f) {
        usedFile.add(f.name);
        nodes.push(fileInline(f, `m${k}`));
      }
    }
    last = m.index + m[0].length;
    k++;
  }
  const tail = answer.slice(last);
  if (tail.trim() || nodes.length === 0) {
    nodes.push(
      <Markdown key={`t${k}`} streaming={streaming}>
        {tail || (streaming ? "" : "_(empty response)_")}
      </Markdown>,
    );
  }

  const leftImgs = imgs.filter((_, i) => !usedImg.has(i));
  const leftVids = vids.filter((_, i) => !usedVid.has(i));
  const leftArts = arts.filter((_, i) => !usedArt.has(i));
  // Files the model didn't explicitly place with a [[file:NAME]] marker are NOT
  // appended to the message (they remain in the sandbox file explorer).

  return (
    <>
      {nodes}
      {leftArts.map((a, i) => artifactEl(a, `la${i}`))}
      {leftImgs.map((s, i) => imageEl(s, `li${i}`))}
      {leftVids.map((s, i) => videoEl(s, `lv${i}`))}
    </>
  );
}

const TOOL_LABELS: Record<string, string> = {
  search: "🔍 搜尋",
  web_search: "🔍 網路搜尋",
  x_search: "𝕏 搜尋",
  grok_search: "🔍 Grok 搜尋",
  generate_image: "🖼 生成圖片",
  generate_video: "🎬 生成影片",
  run_code: "▶ 執行程式",
  create_artifact: "📊 產生圖表/視覺化",
  use_skill: "📖 載入技能",
  install_skill: "⬇ 安裝技能",
  clone_repo: "📦 拉取倉庫",
};

/** Collapsible panel showing which tools the model called this turn + args. */
function ToolCallsPanel({ calls }: { calls: ToolCallTrace[] }) {
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  const labelOf = (t: ToolCallTrace) => TOOL_LABELS[t.tool] ?? t.tool;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border/70 bg-surface-2/50 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-muted hover:text-foreground"
      >
        <ChevronRight
          size={12}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Wrench size={12} />
        <span className="truncate">
          已呼叫 {calls.length} 個工具：{calls.map(labelOf).join("、")}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/70 px-3 py-2">
          {calls.map((c, i) => (
            <div key={i}>
              <div className="font-medium text-foreground">{labelOf(c)}</div>
              {c.args && Object.keys(c.args).length > 0 && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[#0d0f15] p-2 text-[11px] text-muted">
                  {JSON.stringify(c.args, null, 2).slice(0, 1500)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageBubble({
  message,
  streaming,
  canEdit,
  onEdit,
  onFork,
  onRegenerate,
  versionIndex,
  versionCount,
  onPrevVersion,
  onNextVersion,
  conversationId,
}: {
  message: UIMessage;
  streaming?: boolean;
  canEdit?: boolean;
  onEdit?: (id: string, newText: string) => void;
  onFork?: (id: string) => void;
  onRegenerate?: (id: string) => void;
  versionIndex?: number;
  versionCount?: number;
  onPrevVersion?: () => void;
  onNextVersion?: () => void;
  conversationId?: string | null;
}) {
  const isUser = message.role === "user";
  const [canTts, setCanTts] = useState(false);
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">(
    "idle",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);

  function openFile(name: string) {
    if (!conversationId) return;
    setViewer(name);
  }

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
          {versionCount && versionCount > 1 && (
            <span className="flex items-center gap-0.5 text-[11px] text-muted">
              <button
                onClick={onPrevVersion}
                className="hover:text-foreground disabled:opacity-30"
                disabled={streaming}
                title="上一個版本"
              >
                <ChevronLeft size={12} />
              </button>
              <span className="tabular-nums">
                {versionIndex}/{versionCount}
              </span>
              <button
                onClick={onNextVersion}
                className="hover:text-foreground disabled:opacity-30"
                disabled={streaming}
                title="下一個版本"
              >
                <ChevronRight size={12} />
              </button>
            </span>
          )}
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
                  title="編輯此輪（建立新版本）"
                >
                  <Pencil size={12} />
                </button>
              )}
              {!isUser && onRegenerate && (
                <button
                  onClick={() => onRegenerate(message.id)}
                  className="text-muted hover:text-foreground"
                  title="重新生成（建立新版本）"
                >
                  <RefreshCw size={12} />
                </button>
              )}
              {onFork && (
                <button
                  onClick={() => onFork(message.id)}
                  className="text-muted hover:text-foreground"
                  title="從此處分支為新對話"
                >
                  <GitBranch size={12} />
                </button>
              )}
            </span>
          )}
        </div>

        {isUser && message.images && message.images.length > 0 && (
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
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ToolCallsPanel calls={message.toolCalls} />
            )}
            <AssistantBody
              answer={answer}
              images={message.images}
              videos={message.videos}
              files={message.files}
              artifacts={message.artifacts}
              conversationId={conversationId}
              onImageClick={setLightbox}
              onOpenFile={openFile}
              streaming={streaming}
            />
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
          <div
            className="w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <ImageViewer src={lightbox} alt="preview" />
          </div>
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 text-white/80 hover:text-white"
            title="關閉"
          >
            <X size={24} />
          </button>
        </div>
      )}

      {viewer && conversationId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setViewer(null)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate font-mono text-xs">{viewer}</span>
              <div className="flex items-center gap-3">
                <a
                  href={`/api/sandbox/${conversationId}/file?name=${encodeURIComponent(viewer)}&download=1`}
                  className="text-xs text-accent hover:text-foreground"
                >
                  下載
                </a>
                <button
                  onClick={() => setViewer(null)}
                  className="text-muted hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <FilePreview conversationId={conversationId} name={viewer} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
