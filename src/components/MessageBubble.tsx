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
  ImageRef,
} from "@/lib/types";
import { interpretGrokRenderSyntax } from "@/lib/grok/render-interpreter";
import { speak, stopSpeaking, ttsSupported } from "@/lib/tts";
import { parseThinking } from "@/lib/think";
import { Markdown } from "./Markdown";
import { Thinking } from "./Thinking";
import { FilePreview, isPreviewable } from "./FilePreview";
import { ImageViewer, VideoPlayer } from "./MediaViewer";
import { Artifact } from "./Artifact";

const SOP_VISIBLE_MARKERS = ["### SOP 修正版", "### SOP 控制結果"];

function searchedImageIds(answer: string): string[] {
  const ids: string[] = [];
  for (const node of interpretGrokRenderSyntax(answer)) {
    if (node.kind !== "grok_searched_image") continue;
    if (!ids.includes(node.imageId)) ids.push(node.imageId);
  }
  return ids;
}

function assistantAnswerPresentation(answer: string): {
  displayAnswer: string;
  debugNotices: string[];
} {
  for (const marker of SOP_VISIBLE_MARKERS) {
    const idx = answer.lastIndexOf(marker);
    if (idx >= 0) {
      const original = answer.slice(0, idx).trim();
      const ids = searchedImageIds(original);
      const debugNotices = [
        "SOP replaced the original Grok answer; showing the corrected final answer.",
      ];
      if (ids.length > 0) {
        debugNotices.push(
          `Original Grok answer contained searched-image markers: ${ids.join(
            ", ",
          )}. If no images render, the provider did not supply matching image metadata for those ids.`,
        );
      }
      return { displayAnswer: answer.slice(idx).trim(), debugNotices };
    }
  }
  return { displayAnswer: answer, debugNotices: [] };
}

function AssistantBody({
  answer,
  images,
  imageRefs,
  videos,
  files,
  artifacts,
  conversationId,
  debugNotices,
  onImageClick,
  onOpenFile,
  streaming,
}: {
  answer: string;
  images?: string[];
  imageRefs?: ImageRef[];
  videos?: string[];
  files?: SandboxFileMeta[];
  artifacts?: ArtifactMeta[];
  conversationId?: string | null;
  debugNotices?: string[];
  onImageClick: (src: string) => void;
  onOpenFile: (name: string) => void;
  streaming?: boolean;
}) {
  const imgs = images ?? [];
  const imgRefs = imageRefs ?? [];
  const vids = videos ?? [];
  const fls = files ?? [];
  const arts = artifacts ?? [];
  const mediaDebugNotices = [...(debugNotices ?? [])];

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
  // Resolve a media identifier to a renderable src. An identifier is either a
  // full URL / data: URI (used as-is) or a sandbox file path (served via the
  // file route, which sets an image MIME so it renders inline).
  const mediaSrc = (id: string) =>
    /^(https?:|data:)/i.test(id) || !conversationId
      ? id
      : `/api/sandbox/${conversationId}/file?name=${encodeURIComponent(id)}`;

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

  const usedImg = new Set<string>();
  const usedVid = new Set<string>();
  const usedFile = new Set<string>();
  const usedArt = new Set<number>();
  const nodes: React.ReactNode[] = [];
  let k = 0;
  let grokImageIndex = 0;
  const imageRefById = new Map(
    imgRefs.map((ref) => [ref.id.toLowerCase(), ref]),
  );
  const imageRefUrls = new Set(imgRefs.map((ref) => ref.url));
  const renderNodes = interpretGrokRenderSyntax(answer);
  const hasGrokImageRender = renderNodes.some(
    (node) => node.kind === "grok_searched_image",
  );
  for (const node of renderNodes) {
    if (node.kind === "text") {
      const seg = node.text.replace(
        /(?:image|video|file|artifact)\s*[:：]\s*$/i,
        "",
      );
      if (seg.trim())
        nodes.push(
          <Markdown key={`t${k}`} streaming={streaming}>
            {seg}
          </Markdown>,
        );
      k++;
      continue;
    }
    if (node.kind === "app_media") {
      const ref = node.ref;
      if (node.media === "image") {
        // ref is a concrete identifier: a URL or a sandbox file path. Bare
        // numbers (legacy order markers) are no longer supported — ignore them
        // so they don't resolve to a broken URL; the image still appends below.
        if (!/^\d+$/.test(ref)) {
          usedImg.add(ref);
          nodes.push(imageEl(mediaSrc(ref), `m${k}`));
        }
      } else if (node.media === "video") {
        if (!/^\d+$/.test(ref)) {
          usedVid.add(ref);
          nodes.push(videoEl(mediaSrc(ref), `m${k}`));
        }
      } else if (node.media === "artifact") {
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
      const ref = imageRefById.get(node.imageId.toLowerCase());
      if (ref?.url) {
        usedImg.add(ref.url);
        nodes.push(imageEl(mediaSrc(ref.url), `grok${k}`));
      } else {
        let i = grokImageIndex;
        while (i < imgs.length && usedImg.has(imgs[i])) i++;
        grokImageIndex = i + 1;
        if (imgs[i]) {
          usedImg.add(imgs[i]);
          nodes.push(imageEl(mediaSrc(imgs[i]), `grok${k}`));
        } else if (!streaming) {
          const reason =
            imgRefs.length > 0
              ? "No matching imageRef URL was captured for this id."
              : imgs.length > 0
                ? "Images were captured, but no logical imageRefs were captured."
                : "No image metadata was captured for this marker.";
          mediaDebugNotices.push(
            `Grok searched-image marker unresolved: ${node.imageId} (${node.size}). ${reason}`,
          );
        }
      }
    }
    k++;
  }
  if (nodes.length === 0) {
    nodes.push(
      <Markdown key={`t${k}`} streaming={streaming}>
        {streaming ? "" : "_(empty response)_"}
      </Markdown>,
    );
  }

  const leftImgs = imgs.filter(
    (id) =>
      !usedImg.has(id) &&
      !answer.includes(id) &&
      !(hasGrokImageRender && (imgRefs.length > 0 || imageRefUrls.has(id))),
  );
  const leftVids = vids.filter((id) => !usedVid.has(id));
  const leftArts = arts.filter((_, i) => !usedArt.has(i));
  // Media (images/videos/files) the model didn't place inline with a marker is
  // appended here. Each image/video entry is an identifier (URL or sandbox path)
  // resolved through mediaSrc.
  const leftFiles = fls.filter((f) => !usedFile.has(f.name));

  return (
    <>
      {nodes}
      {leftArts.map((a, i) => artifactEl(a, `la${i}`))}
      {leftImgs.map((s, i) => imageEl(mediaSrc(s), `li${i}`))}
      {leftVids.map((s, i) => videoEl(mediaSrc(s), `lv${i}`))}
      {leftFiles.map((f, i) => fileInline(f, `lf${i}`))}
      <DebugNotices notices={mediaDebugNotices} />
    </>
  );
}

function DebugNotices({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <details className="mt-3 max-w-2xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted">
      <summary className="cursor-pointer select-none font-medium text-amber-200">
        Debug ({notices.length})
      </summary>
      <ul className="space-y-1">
        {notices.map((notice, i) => (
          <li key={i}>{notice}</li>
        ))}
      </ul>
    </details>
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
  const { displayAnswer, debugNotices } = isUser
    ? { displayAnswer: answer, debugNotices: [] }
    : assistantAnswerPresentation(answer);

  async function copyMessage() {
    const text = isUser ? message.content : displayAnswer;
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
    <div className="group flex max-w-full gap-3 overflow-x-hidden px-4 py-4">
      <div
        className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-accent-strong" : "bg-surface-2"
        }`}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-muted">
            {isUser ? "You" : "Assistant"}
          </span>
          {versionCount && versionCount > 1 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted">
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
              className={`flex shrink-0 items-center gap-2 transition ${
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
                className="max-h-64 max-w-full cursor-zoom-in rounded-lg border border-border object-contain transition hover:opacity-90"
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
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {message.content}
          </p>
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
              answer={displayAnswer}
              images={message.images}
              imageRefs={message.imageRefs}
              videos={message.videos}
              files={message.files}
              artifacts={message.artifacts}
              conversationId={conversationId}
              debugNotices={debugNotices}
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
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
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
