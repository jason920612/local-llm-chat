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
  Copy,
} from "lucide-react";
import type {
  UIMessage,
  SandboxFileMeta,
  ToolCallTrace,
  ArtifactMeta,
  Citation,
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
type InlineMarker =
  | {
      kind: "app";
      media: "image" | "video" | "file" | "artifact";
      ref: string;
      start: number;
      end: number;
    }
  | {
      kind: "grok_searched_image";
      imageId: string;
      size: string;
      start: number;
      end: number;
    };
type AppMediaKind = Extract<InlineMarker, { kind: "app" }>["media"];

function isAppMediaKind(value: string): value is AppMediaKind {
  return (
    value === "image" ||
    value === "video" ||
    value === "file" ||
    value === "artifact"
  );
}

function decodeGrokArg(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readGrokAttr(attrs: string, name: string): string {
  const m = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeGrokArg(m?.[1] ?? m?.[2] ?? m?.[3] ?? "");
}

function readGrokArgument(body: string, name: string): string {
  const m = body.match(
    new RegExp(
      `<argument\\s+name=["']${name}["']\\s*>([\\s\\S]*?)<\\/argument>`,
      "i",
    ),
  );
  return decodeGrokArg(m?.[1] ?? "");
}

function parseInlineMarkers(text: string): InlineMarker[] {
  const candidates: InlineMarker[] = [];

  const pushGrokImage = (
    start: number,
    end: number,
    imageId: string,
    size: string,
  ) => {
    const id = decodeGrokArg(imageId);
    if (!id) return;
    candidates.push({
      kind: "grok_searched_image",
      imageId: id,
      size: decodeGrokArg(size || "SMALL").toUpperCase(),
      start,
      end,
    });
  };

  for (const m of text.matchAll(/\[\[(image|video|file|artifact):([^\]\n]+)\]\]/gi)) {
    const media = m[1].toLowerCase();
    if (!isAppMediaKind(media)) continue;
    candidates.push({
      kind: "app",
      media,
      ref: m[2].trim(),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }

  for (const m of text.matchAll(
    /\[\[\s*(?:render\s+)?render_searched_image\s+with\s+image_id\s+is\s+([^\s\]\*]+)(?:\s+size\s+is\s+(?:"([^"\n]+)"|([A-Za-z]+)))?\s*\]\]/gi,
  )) {
    pushGrokImage(
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
      m[1],
      m[2] ?? m[3] ?? "SMALL",
    );
  }

  for (const m of text.matchAll(
    /(?:\*\*)?(?:render\s+)?render_searched_image\s+with\s+image_id\s+is\s+([^\s\]\*]+)(?:\s+size\s+is\s+(?:"([^"\n]+)"|([A-Za-z]+)))?(?:\*\*)?/gi,
  )) {
    pushGrokImage(
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
      m[1],
      m[2] ?? m[3] ?? "SMALL",
    );
  }

  for (const m of text.matchAll(/<grok:render\b([^>]*)>([\s\S]*?)<\/grok:render>/gi)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (readGrokAttr(attrs, "type") !== "render_searched_image") continue;
    pushGrokImage(
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
      readGrokArgument(body, "image_id") || readGrokAttr(attrs, "image_id"),
      readGrokArgument(body, "size") || readGrokAttr(attrs, "size") || "SMALL",
    );
  }

  for (const m of text.matchAll(/<grok:render\b([^>]*)\/>/gi)) {
    const attrs = m[1] ?? "";
    if (readGrokAttr(attrs, "type") !== "render_searched_image") continue;
    pushGrokImage(
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
      readGrokAttr(attrs, "image_id"),
      readGrokAttr(attrs, "size") || "SMALL",
    );
  }

  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result: InlineMarker[] = [];
  let coveredUntil = -1;
  for (const marker of candidates) {
    if (marker.start < coveredUntil) continue;
    result.push(marker);
    coveredUntil = marker.end;
  }
  return result;
}

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
  const grokImageFallbackEl = (imageId: string, size: string, key: string) => (
    <div
      key={key}
      className="my-2 max-w-md rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted"
      title={`render_searched_image image_id=${imageId} size=${size}`}
    >
      Grok searched image: {imageId}
      <span className="ml-2 uppercase opacity-70"> {size}</span>
    </div>
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
  let last = 0;
  let k = 0;
  let grokImageIndex = 0;
  const markers = parseInlineMarkers(answer);
  for (const marker of markers) {
    // Drop a stray "image:/video:/file:" label the model may write before a marker.
    const seg = answer
      .slice(last, marker.start)
      .replace(/(?:image|video|file|artifact)\s*[:：]\s*$/i, "");
    if (seg.trim())
      nodes.push(
        <Markdown key={`t${k}`} streaming={streaming}>
          {seg}
        </Markdown>,
      );
    if (marker.kind === "app") {
      const ref = marker.ref;
      if (marker.media === "image") {
        const i = parseInt(ref, 10) - 1;
        if (imgs[i]) {
          usedImg.add(i);
          nodes.push(imageEl(imgs[i], `m${k}`));
        }
      } else if (marker.media === "video") {
        const i = parseInt(ref, 10) - 1;
        if (vids[i]) {
          usedVid.add(i);
          nodes.push(videoEl(vids[i], `m${k}`));
        }
      } else if (marker.media === "artifact") {
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
    } else {
      let i = grokImageIndex;
      while (i < imgs.length && usedImg.has(i)) i++;
      grokImageIndex = i + 1;
      if (imgs[i]) {
        usedImg.add(i);
        nodes.push(imageEl(imgs[i], `grok${k}`));
      } else {
        nodes.push(
          grokImageFallbackEl(marker.imageId, marker.size, `grok${k}`),
        );
      }
    }
    last = marker.end;
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

  const leftImgs = imgs.filter(
    (src, i) => !usedImg.has(i) && !answer.includes(src),
  );
  const leftVids = vids.filter((_, i) => !usedVid.has(i));
  const leftArts = arts.filter((_, i) => !usedArt.has(i));
  // Real produced files (PDF, xlsx, …) the model didn't place inline are shown at
  // the end. Generated images/videos are NOT in this list (they're shown via
  // [[image/video:N]] and only live in the sandbox), so there's no duplication.
  const leftFiles = fls.filter((f) => !usedFile.has(f.name));

  return (
    <>
      {nodes}
      {leftArts.map((a, i) => artifactEl(a, `la${i}`))}
      {leftImgs.map((s, i) => imageEl(s, `li${i}`))}
      {leftVids.map((s, i) => videoEl(s, `lv${i}`))}
      {leftFiles.map((f, i) => fileInline(f, `lf${i}`))}
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
  embed_tradingview: "📈 K 線圖",
  use_skill: "📖 載入技能",
  install_skill: "⬇ 安裝技能",
  clone_repo: "📦 拉取倉庫",
  start_background: "⚙ 啟動背景程式",
  read_background_log: "📜 讀背景 log",
  list_background: "📋 背景程式列表",
  kill_background: "⛔ 關閉背景程式",
  xai_cost: "💳 xAI 成本",
};

const SEARCH_TOOLS = new Set([
  "web_search",
  "x_search",
  "search",
  "grok_search",
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Compact, clickable source cards for web/x search results (title + favicon). */
function SourceCards({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
      {citations.map((c) => {
        const url = c.snippet;
        const host = hostOf(url);
        return (
          <a
            key={c.index}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={`[${c.index}] ${c.title ?? host}\n${url}`}
            className="flex max-w-[200px] items-center gap-1.5 rounded-md border border-border/70 bg-surface px-2 py-1 text-[11px] text-muted transition hover:border-accent hover:text-foreground"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
              alt=""
              className="h-3.5 w-3.5 shrink-0 rounded-sm"
            />
            <span className="truncate">{c.title ?? host}</span>
          </a>
        );
      })}
    </div>
  );
}

/** Collapsible panel showing which tools the model called this turn + args. */
function ToolCallsPanel({
  calls,
  citations,
}: {
  calls: ToolCallTrace[];
  citations?: Citation[];
}) {
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  const labelOf = (t: ToolCallTrace) => TOOL_LABELS[t.tool] ?? t.tool;
  const didSearch = calls.some((c) => SEARCH_TOOLS.has(c.tool));
  const sources = didSearch ? (citations ?? []) : [];
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
      {sources.length > 0 && (
        <div className="border-t border-border/70 pt-2">
          <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted/70">
            來源 {sources.length}
          </div>
          <SourceCards citations={sources} />
        </div>
      )}
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
  isMobile,
}: {
  message: UIMessage;
  streaming?: boolean;
  canEdit?: boolean;
  onEdit?: (id: string, newText: string) => void | Promise<void>;
  onFork?: (id: string) => void;
  onRegenerate?: (id: string) => void;
  versionIndex?: number;
  versionCount?: number;
  onPrevVersion?: () => void;
  onNextVersion?: () => void;
  conversationId?: string | null;
  isMobile?: boolean;
}) {
  const isUser = message.role === "user";
  const [canTts, setCanTts] = useState(false);
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">(
    "idle",
  );
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);

  function openFile(name: string) {
    if (!conversationId) return;
    setViewer(name);
  }

  useEffect(() => setCanTts(ttsSupported()), []);
  useEffect(() => () => stopSpeaking(), []);

  // Bigger, padded tap targets on touch devices.
  const isz = isMobile ? 17 : 12;
  const btn = `text-muted hover:text-foreground${isMobile ? " p-1.5" : ""}`;

  // Split reasoning (<think>) from the answer for assistant messages.
  const { thinking, answer, thinkingStreaming } = isUser
    ? { thinking: "", answer: message.content, thinkingStreaming: false }
    : parseThinking(message.content);

  async function copyMessage() {
    const text = isUser ? message.content : answer;
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for insecure/older contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

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
                type="button"
                onClick={onPrevVersion}
                className="inline-flex h-7 w-7 touch-manipulation items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                disabled={streaming}
                title="上一個版本"
              >
                <ChevronLeft size={isz} />
              </button>
              <span className="tabular-nums">
                {versionIndex}/{versionCount}
              </span>
              <button
                type="button"
                onClick={onNextVersion}
                className="inline-flex h-7 w-7 touch-manipulation items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                disabled={streaming}
                title="下一個版本"
              >
                <ChevronRight size={isz} />
              </button>
            </span>
          )}
          {!isUser && canTts && !streaming && answer.trim() && (
            <button
              onClick={toggleSpeak}
              className={btn}
              title={
                ttsState === "idle"
                  ? "Read aloud"
                  : ttsState === "loading"
                    ? "Generating audio…"
                    : "Stop"
              }
            >
              {ttsState === "loading" ? (
                <Loader2 size={isz} className="animate-spin" />
              ) : ttsState === "playing" ? (
                <Square size={isz} />
              ) : (
                <Volume2 size={isz} />
              )}
            </button>
          )}
          {canEdit && !editing && (
            <span
              className={`flex items-center gap-2 transition ${
                isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <button
                onClick={copyMessage}
                className={btn}
                title={copied ? "已複製" : "複製訊息"}
              >
                {copied ? (
                  <Check size={isz} className="text-emerald-400" />
                ) : (
                  <Copy size={isz} />
                )}
              </button>
              {onEdit && (
                <button
                  onClick={() => {
                    setDraft(message.content);
                    setEditing(true);
                  }}
                  className={btn}
                  title="編輯此輪（建立新版本）"
                >
                  <Pencil size={isz} />
                </button>
              )}
              {!isUser && onRegenerate && (
                <button
                  onClick={() => onRegenerate(message.id)}
                  className={btn}
                  title="重新生成（建立新版本）"
                >
                  <RefreshCw size={isz} />
                </button>
              )}
              {onFork && (
                <button
                  onClick={() => onFork(message.id)}
                  className={btn}
                  title="從此處分支為新對話"
                >
                  <GitBranch size={isz} />
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
                onClick={async () => {
                  if (editSaving) return;
                  setEditSaving(true);
                  try {
                    await onEdit?.(message.id, draft);
                    setEditing(false);
                  } finally {
                    setEditSaving(false);
                  }
                }}
                disabled={editSaving}
                className="flex items-center gap-1 rounded-md bg-accent-strong px-2.5 py-1 text-xs text-white hover:bg-accent"
              >
                {editSaving ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
                {isUser ? "儲存並重新產生" : "儲存"}
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={editSaving}
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
              <ToolCallsPanel
                calls={message.toolCalls}
                citations={message.citations}
              />
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
