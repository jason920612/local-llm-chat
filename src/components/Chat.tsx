"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Bot, BookOpen, Globe, AudioLines, FolderOpen } from "lucide-react";
import type { Conversation, UIMessage, SandboxFileMeta } from "@/lib/types";
import {
  createConversationApi,
  fetchConversation,
  forkConversationApi,
  setActiveBranch,
  uploadSandboxFiles,
  parseCitationsHeader,
  parseImagesHeader,
  parseVideosHeader,
  parseMediaSentinel,
  parseStreamingText,
  saveMessage,
} from "@/lib/api";
import { computePath, ancestorsOf, versionInfo } from "@/lib/tree";
import { fileToResizedDataURL, isImageFile } from "@/lib/image";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ConnectionStatus } from "./ConnectionStatus";
import { VoiceMode } from "./VoiceMode";
import { SandboxExplorer } from "./SandboxExplorer";

export function Chat({
  conversationId,
  title,
  useRag,
  docCount,
  onToggleRag,
  useGrok,
  grokEnabled,
  onToggleGrok,
  onCreated,
  onPersisted,
}: {
  conversationId: string | null;
  title: string | null;
  useRag: boolean;
  docCount: number;
  onToggleRag: () => void;
  useGrok: boolean;
  grokEnabled: boolean;
  onToggleGrok: () => void;
  onCreated: (conv: Conversation) => void;
  onPersisted: () => void;
}) {
  // The full message TREE for this conversation; the displayed thread is the
  // path derived from it (computePath), following each node's selected branch.
  const [allMessages, setAllMessages] = useState<UIMessage[]>([]);
  const [rootChildId, setRootChildId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [sandboxFiles, setSandboxFiles] = useState<SandboxFileMeta[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  // The conversation currently loaded into `messages`. Used to avoid reloading
  // (and clobbering an in-progress stream) when we create a conversation locally.
  const loadedId = useRef<string | null>(null);

  // The visible conversation path through the tree.
  const messages = useMemo(
    () => computePath(allMessages, rootChildId),
    [allMessages, rootChildId],
  );

  // Add or replace a message in the tree, and select it as its parent's branch
  // (so a newly added/branched message becomes part of the visible path).
  const attach = useCallback((m: UIMessage) => {
    setAllMessages((prev) => {
      const next = prev.some((x) => x.id === m.id)
        ? prev.map((x) => (x.id === m.id ? m : x))
        : [...prev, m];
      return m.parentId
        ? next.map((x) =>
            x.id === m.parentId ? { ...x, activeChildId: m.id } : x,
          )
        : next;
    });
    if (!m.parentId) setRootChildId(m.id);
  }, []);

  // Load the tree when the active conversation changes externally.
  useEffect(() => {
    if (conversationId === loadedId.current) return;
    loadedId.current = conversationId;
    if (!conversationId) {
      setAllMessages([]);
      setRootChildId(null);
      return;
    }
    let cancelled = false;
    fetchConversation(conversationId)
      .then((d) => {
        if (cancelled) return;
        setAllMessages(d.messages);
        setRootChildId(d.rootChildId);
      })
      .catch(() => {
        if (cancelled) return;
        setAllMessages([]);
        setRootChildId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Robust drag-overlay reset: dropping or ending a drag anywhere clears it, and
  // we preventDefault globally so the browser never opens a stray dropped file.
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDragOver(false);
    };
    const onWinDragOver = (e: DragEvent) => e.preventDefault();
    const onWinDrop = (e: DragEvent) => {
      e.preventDefault();
      reset();
    };
    window.addEventListener("dragover", onWinDragOver);
    window.addEventListener("drop", onWinDrop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragover", onWinDragOver);
      window.removeEventListener("drop", onWinDrop);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const addAttachments = useCallback(async (files: File[]) => {
    const images = files.filter(isImageFile);
    const urls = await Promise.all(images.map((f) => fileToResizedDataURL(f)));
    setAttachments((prev) => [...prev, ...urls]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const ensureConversation = useCallback(
    async (titleHint: string): Promise<string> => {
      if (conversationId) return conversationId;
      const conv = await createConversationApi(
        titleHint.slice(0, 40) || "New chat",
      );
      loadedId.current = conv.id;
      onCreated(conv);
      return conv.id;
    },
    [conversationId, onCreated],
  );

  const uploadToSandbox = useCallback(
    async (files: File[]) => {
      try {
        const cid = await ensureConversation(files[0]?.name ?? "Files");
        const uploaded = await uploadSandboxFiles(cid, files);
        setSandboxFiles((prev) => {
          const names = new Set(prev.map((f) => f.name));
          return [...prev, ...uploaded.filter((f) => !names.has(f.name))];
        });
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "檔案上傳失敗（沙盒可能未啟用）",
        );
      }
    },
    [ensureConversation],
  );

  // Route dropped/picked files: images become vision attachments; other files
  // are uploaded into the conversation sandbox for run_code to use.
  const handleFiles = useCallback(
    (files: File[]) => {
      const imgs = files.filter(isImageFile);
      const others = files.filter((f) => !isImageFile(f));
      if (imgs.length) addAttachments(imgs);
      if (others.length) uploadToSandbox(others);
    },
    [addAttachments, uploadToSandbox],
  );

  const removeSandboxFile = useCallback((name: string) => {
    setSandboxFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // Core streaming turn: takes the full history (ending with the user turn to
  // answer), shows an assistant placeholder, streams the reply, and persists it.
  const runTurn = useCallback(
    async (history: UIMessage[], cid: string) => {
      // The new assistant branches off the last message of the history (the user
      // turn it answers), so re-generating just adds another sibling version.
      const parentId = history[history.length - 1]?.id ?? null;
      const assistantMsg: UIMessage = {
        id: nanoid(),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        parentId,
      };
      attach(assistantMsg);
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: cid,
            useRag,
            useGrok,
            messages: history.map((m) => ({
              role: m.role,
              content: m.content,
              images: m.images,
            })),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        if (!res.body) throw new Error("No response stream.");

        const citations = parseCitationsHeader(res.headers.get("X-Citations"));
        const genImages = parseImagesHeader(res.headers.get("X-Images"));
        const genVideos = parseVideosHeader(res.headers.get("X-Videos"));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          const live = parseStreamingText(acc);
          setAllMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    content: live.text,
                    toolCalls:
                      live.toolCalls.length > 0 ? live.toolCalls : undefined,
                  }
                : m,
            ),
          );
        }

        const media = parseMediaSentinel(acc);
        const parsed = parseStreamingText(acc);
        const finalAssistant: UIMessage = {
          ...assistantMsg,
          content: parsed.text,
          toolCalls:
            parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
          citations:
            citations.length || media.citations.length
              ? [...citations, ...media.citations]
              : undefined,
          images:
            genImages.length || media.images.length
              ? [...genImages, ...media.images]
              : undefined,
          videos:
            genVideos.length || media.videos.length
              ? [...genVideos, ...media.videos]
              : undefined,
          files: media.files.length > 0 ? media.files : undefined,
          artifacts: media.artifacts.length > 0 ? media.artifacts : undefined,
        };
        setAllMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? finalAssistant : m)),
        );
        await saveMessage(cid, finalAssistant);
        onPersisted();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // user stopped — keep partial output
        } else {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setError(msg);
          setAllMessages((prev) =>
            prev.filter((m) => !(m.id === assistantMsg.id && m.content === "")),
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [useRag, useGrok, onPersisted, attach],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (
      (!text && attachments.length === 0 && sandboxFiles.length === 0) ||
      streaming
    )
      return;
    setError(null);

    const fileNote =
      sandboxFiles.length > 0
        ? `\n\n[已上傳到工作目錄的檔案：${sandboxFiles
            .map((f) => f.name)
            .join(", ")}]`
        : "";
    const images = attachments;
    const userMsg: UIMessage = {
      id: nanoid(),
      role: "user",
      content: text + fileNote,
      images: images.length > 0 ? images : undefined,
      createdAt: Date.now(),
      parentId: messages.length ? messages[messages.length - 1].id : null,
    };
    const history = [...messages, userMsg];
    setInput("");
    setAttachments([]);
    setSandboxFiles([]);
    attach(userMsg);

    const cid = await ensureConversation(text || "New chat");
    await saveMessage(cid, userMsg);
    await runTurn(history, cid);
  }, [
    input,
    attachments,
    sandboxFiles,
    streaming,
    messages,
    ensureConversation,
    runTurn,
    attach,
  ]);

  // Edit any turn as a NEW version (branch), preserving the old one. Editing a
  // user turn creates a sibling and regenerates; editing an assistant turn saves
  // a sibling with the new text (no regeneration).
  const editMessage = useCallback(
    async (messageId: string, newText: string) => {
      if (streaming || !conversationId) return;
      const original = allMessages.find((m) => m.id === messageId);
      if (!original) return;
      setError(null);

      const sibling: UIMessage = {
        id: nanoid(),
        role: original.role,
        content: newText,
        images: original.images,
        parentId: original.parentId ?? null,
        createdAt: Date.now(),
      };
      attach(sibling);
      await saveMessage(conversationId, sibling);

      if (sibling.role === "user") {
        const history = ancestorsOf([...allMessages, sibling], sibling);
        await runTurn(history, conversationId);
      } else {
        onPersisted();
      }
    },
    [streaming, conversationId, allMessages, runTurn, onPersisted, attach],
  );

  // Regenerate any assistant message: add another sibling version under the same
  // user turn and stream a fresh answer. The previous version stays switchable.
  const regenerate = useCallback(
    async (messageId: string) => {
      if (streaming || !conversationId) return;
      const target = allMessages.find((m) => m.id === messageId);
      if (!target || target.role !== "assistant" || !target.parentId) return;
      const parent = allMessages.find((m) => m.id === target.parentId);
      if (!parent) return;
      setError(null);
      const history = ancestorsOf(allMessages, parent);
      await runTurn(history, conversationId);
    },
    [streaming, conversationId, allMessages, runTurn],
  );

  // Switch which version of a message (and its branch) is shown.
  const switchVersion = useCallback(
    async (messageId: string, dir: -1 | 1) => {
      if (streaming || !conversationId) return;
      const msg = allMessages.find((m) => m.id === messageId);
      if (!msg) return;
      const { index, count, siblings } = versionInfo(allMessages, msg);
      if (count < 2) return;
      const target = siblings[(index + dir + count) % count];
      const parentId = target.parentId ?? null;
      if (parentId) {
        setAllMessages((prev) =>
          prev.map((m) =>
            m.id === parentId ? { ...m, activeChildId: target.id } : m,
          ),
        );
      } else {
        setRootChildId(target.id);
      }
      await setActiveBranch(conversationId, parentId, target.id);
    },
    [streaming, conversationId, allMessages],
  );

  // Fork: branch a new conversation containing everything up to this message.
  const forkAt = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      try {
        const conv = await forkConversationApi(conversationId, messageId);
        onCreated(conv); // adds to sidebar + switches; effect loads the fork
      } catch {
        setError("Fork failed");
      }
    },
    [conversationId, onCreated],
  );

  const isEmpty = messages.length === 0;

  return (
    <div
      className="relative flex h-screen flex-1 flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          dragDepth.current += 1;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) handleFiles(files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 m-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
          放開以上傳檔案（圖片→視覺；其他→沙盒工作目錄）
        </div>
      )}
      <header className="flex h-12 items-center gap-2 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted">
          {title ?? "New chat"}
        </span>
        <ConnectionStatus />
        <button
          onClick={onToggleRag}
          disabled={docCount === 0}
          title={
            docCount === 0
              ? "Upload documents to enable"
              : "Ground answers in your documents"
          }
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
            useRag && docCount > 0
              ? "border-accent bg-accent/15 text-accent"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          <BookOpen size={13} />
          Docs{docCount > 0 ? ` (${docCount})` : ""}
        </button>
        {conversationId && (
          <button
            onClick={() => setExplorerOpen(true)}
            title="沙盒檔案總管"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted transition hover:text-foreground"
          >
            <FolderOpen size={13} />
            Files
          </button>
        )}
        {grokEnabled && (
          <button
            onClick={() => setVoiceOpen(true)}
            title="即時語音對話 (xAI Realtime)"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted transition hover:text-foreground"
          >
            <AudioLines size={13} />
            Voice
          </button>
        )}
        <button
          onClick={onToggleGrok}
          disabled={!grokEnabled}
          title={
            grokEnabled
              ? "Let the model search X & the web via Grok"
              : "Set XAI_API_KEY in .env.local to enable"
          }
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
            useGrok && grokEnabled
              ? "border-accent bg-accent/15 text-accent"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          <Globe size={13} />
          Grok
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2">
              <Bot size={22} className="text-accent" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Chat with your local model
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted">
              Private and offline. Make sure LM Studio is running with a model
              loaded, then say hello.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-border/50">
            {messages.map((m, i) => {
              const v = versionInfo(allMessages, m);
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  streaming={
                    streaming &&
                    i === messages.length - 1 &&
                    m.role === "assistant"
                  }
                  canEdit={!streaming}
                  onEdit={editMessage}
                  onFork={forkAt}
                  onRegenerate={regenerate}
                  versionIndex={v.index + 1}
                  versionCount={v.count}
                  onPrevVersion={() => switchVersion(m.id, -1)}
                  onNextVersion={() => switchVersion(m.id, 1)}
                  conversationId={conversationId}
                />
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-auto w-full max-w-3xl px-4">
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        </div>
      )}

      <Composer
        value={input}
        onChange={setInput}
        onSend={send}
        onStop={stop}
        streaming={streaming}
        attachments={attachments}
        onFiles={handleFiles}
        onRemoveAttachment={removeAttachment}
        sandboxFiles={sandboxFiles}
        onRemoveSandboxFile={removeSandboxFile}
      />

      <VoiceMode open={voiceOpen} onClose={() => setVoiceOpen(false)} />
      <SandboxExplorer
        open={explorerOpen}
        onClose={() => setExplorerOpen(false)}
        conversationId={conversationId}
      />
    </div>
  );
}
