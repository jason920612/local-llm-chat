"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { nanoid } from "nanoid";
import { Bot, BookOpen, Globe, AudioLines, FolderOpen, Menu } from "lucide-react";
import type { Conversation, UIMessage, SandboxFileMeta } from "@/lib/types";
import {
  createConversationApi,
  fetchConversation,
  forkConversationApi,
  setActiveBranch,
  uploadSandboxFiles,
  parseStreamingText,
  saveMessage,
  startTurn,
  cancelTurn,
} from "@/lib/api";

/** SSE payloads from /api/conversations/[id]/stream (mirrors live/bus ConvEvent). */
type ConvEvent =
  | { type: "snapshot"; messageId: string; raw: string; status: string }
  | { type: "token"; messageId: string; chunk: string }
  | { type: "message"; message: UIMessage; status?: string }
  | { type: "status"; messageId: string; status: string }
  | { type: "branch"; parentId: string | null; childId: string }
  | { type: "truncate"; afterMessageId: string };
import { computePath, versionInfo } from "@/lib/tree";
import { fileToResizedDataURL, isImageFile } from "@/lib/image";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ConnectionStatus } from "./ConnectionStatus";
import { VoiceMode } from "./VoiceMode";
import { SandboxExplorer } from "./SandboxExplorer";
import { mediaPermissionBlockedReason, recordingSupported } from "@/lib/speech";

const AUTO_SCROLL_BOTTOM_PX = 96;

export function Chat({
  conversationId,
  title,
  isMobile,
  onOpenSidebar,
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
  isMobile: boolean;
  onOpenSidebar: () => void;
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
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceUnavailableReason, setVoiceUnavailableReason] = useState<
    string | null
  >(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [sandboxFiles, setSandboxFiles] = useState<SandboxFileMeta[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const dragDepth = useRef(0);
  // Live-stream state: raw SSE buffer per assistant message id (for parsing
  // partial tokens) and the id currently generating (for stop()).
  const rawBuffers = useRef<Map<string, string>>(new Map());
  const streamingIdRef = useRef<string | null>(null);
  // The conversation currently loaded into `messages`. Used to avoid reloading
  // (and clobbering an in-progress stream) when we create a conversation locally.
  const loadedId = useRef<string | null>(null);
  // The conversation whose fetch is currently in flight (dedupe re-renders).
  const loadingId = useRef<string | null>(null);

  // The visible conversation path through the tree.
  const messages = useMemo(
    () => computePath(allMessages, rootChildId),
    [allMessages, rootChildId],
  );

  const reflectStreamingFromPath = useCallback(
    (tree: UIMessage[], rootId: string | null) => {
      const inflight = computePath(tree, rootId).find(
        (m) => m.status === "streaming",
      );
      streamingIdRef.current = inflight?.id ?? null;
      setStreaming(Boolean(inflight));
    },
    [],
  );

  useEffect(() => {
    setVoiceSupported(recordingSupported());
    setVoiceUnavailableReason(mediaPermissionBlockedReason());
  }, []);

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

  // Load the tree when the active conversation changes externally. Only mark a
  // conversation as "loaded" AFTER a successful fetch — a transient failure
  // (server restart, network blip) must NOT leave it flagged-loaded-but-empty
  // (that caused blank threads and sends creating stray branches). Retries on
  // failure and dedupes concurrent loads.
  useEffect(() => {
    const cid = conversationId;
    if (cid === loadedId.current) return; // already loaded (incl. null === null)
    if (cid && cid === loadingId.current) return; // in-flight (real ids only)
    rawBuffers.current.clear();
    autoScrollRef.current = true;
    if (!cid) {
      // New chat: clear to an empty thread.
      loadedId.current = null;
      loadingId.current = null;
      streamingIdRef.current = null;
      setStreaming(false);
      setAllMessages([]);
      setRootChildId(null);
      return;
    }
    let cancelled = false;
    loadingId.current = cid;
    const attempt = (triesLeft: number) => {
      fetchConversation(cid)
        .then((d) => {
          if (cancelled) return;
          loadingId.current = null;
          loadedId.current = cid; // mark loaded only on success
          setAllMessages(d.messages);
          setRootChildId(d.rootChildId);
          // Reflect any generation still running server-side (e.g. started on
          // another device, or before this device reconnected). Only the active
          // path should lock controls; stale streaming messages on hidden
          // branches must not disable version switching for the whole thread.
          reflectStreamingFromPath(d.messages, d.rootChildId);
        })
        .catch(() => {
          if (cancelled) return;
          if (triesLeft > 0) {
            setTimeout(() => !cancelled && attempt(triesLeft - 1), 700);
          } else {
            // Give up for now but DON'T mark loaded — leave content intact and
            // allow a later switch/refresh to retry.
            loadingId.current = null;
          }
        });
    };
    attempt(3);
    return () => {
      cancelled = true;
      if (loadingId.current === cid) loadingId.current = null;
    };
  }, [conversationId, reflectStreamingFromPath]);

  const updateAutoScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_BOTTOM_PX;
  }, []);

  // Re-fetch the whole tree (used after a truncation broadcast).
  const reloadConversation = useCallback((cid: string) => {
    fetchConversation(cid)
      .then((d) => {
        setAllMessages(d.messages);
        setRootChildId(d.rootChildId);
        reflectStreamingFromPath(d.messages, d.rootChildId);
      })
      .catch(() => {});
  }, [reflectStreamingFromPath]);

  // Apply a live event from the conversation's SSE stream.
  const applyConvEvent = useCallback(
    (e: ConvEvent, cid: string) => {
      switch (e.type) {
        case "snapshot": {
          rawBuffers.current.set(e.messageId, e.raw);
          const parsed = parseStreamingText(e.raw);
          setAllMessages((prev) =>
            prev.map((m) =>
              m.id === e.messageId
                ? {
                    ...m,
                    content: parsed.text,
                    toolCalls: parsed.toolCalls.length
                      ? parsed.toolCalls
                      : m.toolCalls,
                    status: e.status as UIMessage["status"],
                  }
                : m,
            ),
          );
          if (e.status === "streaming") {
            streamingIdRef.current = e.messageId;
            setStreaming(true);
          }
          break;
        }
        case "token": {
          const raw = (rawBuffers.current.get(e.messageId) ?? "") + e.chunk;
          rawBuffers.current.set(e.messageId, raw);
          const parsed = parseStreamingText(raw);
          setAllMessages((prev) =>
            prev.map((m) =>
              m.id === e.messageId
                ? {
                    ...m,
                    content: parsed.text,
                    toolCalls: parsed.toolCalls.length
                      ? parsed.toolCalls
                      : m.toolCalls,
                    status: "streaming",
                  }
                : m,
            ),
          );
          streamingIdRef.current = e.messageId;
          setStreaming(true);
          break;
        }
        case "message": {
          // Authoritative add/finalize from the server (this or another device).
          attach(e.message);
          const st = e.message.status;
          if (st && st !== "streaming") {
            rawBuffers.current.delete(e.message.id);
            if (streamingIdRef.current === e.message.id) {
              streamingIdRef.current = null;
              setStreaming(false);
            }
          } else if (st === "streaming") {
            streamingIdRef.current = e.message.id;
            setStreaming(true);
          }
          break;
        }
        case "status": {
          if (e.status !== "streaming") {
            rawBuffers.current.delete(e.messageId);
            setAllMessages((prev) =>
              prev.map((m) =>
                m.id === e.messageId
                  ? { ...m, status: e.status as UIMessage["status"] }
                  : m,
              ),
            );
            if (streamingIdRef.current === e.messageId) {
              streamingIdRef.current = null;
              setStreaming(false);
            }
          }
          break;
        }
        case "branch": {
          if (e.parentId) {
            const pid = e.parentId;
            setAllMessages((prev) =>
              prev.map((m) =>
                m.id === pid ? { ...m, activeChildId: e.childId } : m,
              ),
            );
          } else {
            setRootChildId(e.childId);
          }
          break;
        }
        case "truncate": {
          reloadConversation(cid);
          break;
        }
      }
    },
    [attach, reloadConversation],
  );

  // Live sync: subscribe to the active conversation's server-sent events so
  // tokens, new/edited messages, and branch switches from ANY device (or a
  // background generation that outlived this tab) appear here in real time.
  useEffect(() => {
    const cid = conversationId;
    if (!cid) return;
    const es = new EventSource(`/api/conversations/${cid}/stream`);
    es.onmessage = (ev) => {
      try {
        applyConvEvent(JSON.parse(ev.data) as ConvEvent, cid);
      } catch {
        /* ignore malformed event */
      }
    };
    es.onerror = () => {
      /* EventSource reconnects automatically; snapshot re-syncs on reconnect */
    };
    return () => es.close();
  }, [conversationId, applyConvEvent]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
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
    const id = streamingIdRef.current;
    if (id) cancelTurn(id);
    streamingIdRef.current = null;
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

  // Bridge for the Android shell's "share into app" feature. The native layer
  // pushes shared files onto window.__coderyoSharedQueue (each entry is a JSON
  // array of {name, mime, data:base64}) and calls __coderyoDrainShared. We mark
  // __coderyoShareReady so native can poll for the mounted page before sending.
  // No-op in a normal browser where nothing ever pushes to the queue.
  useEffect(() => {
    const w = window as unknown as {
      __coderyoSharedQueue?: string[];
      __coderyoDrainShared?: () => void;
      __coderyoShareReady?: boolean;
    };
    const drain = () => {
      const queue = w.__coderyoSharedQueue;
      if (!Array.isArray(queue)) return;
      while (queue.length) {
        const json = queue.shift();
        if (!json) continue;
        try {
          const items: { name?: string; mime?: string; data?: string }[] =
            JSON.parse(json);
          const files = items
            .filter((it) => it.data)
            .map((it) => {
              const binary = atob(it.data as string);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              return new File([bytes], it.name || "shared", {
                type: it.mime || "application/octet-stream",
              });
            });
          if (files.length) handleFiles(files);
        } catch {
          // ignore a malformed payload
        }
      }
    };
    w.__coderyoDrainShared = drain;
    w.__coderyoShareReady = true;
    drain(); // process anything queued before this effect ran
    return () => {
      delete w.__coderyoDrainShared;
      delete w.__coderyoShareReady;
    };
  }, [handleFiles]);

  // Kick off a server-authoritative turn answering `parentId`. The assistant
  // placeholder, live tokens, and final message all arrive via the SSE
  // subscription — generation runs (and persists) on the server, so it survives
  // this device closing and is mirrored to every other open device.
  const beginTurn = useCallback(
    async (cid: string, parentId: string) => {
      const assistantId = nanoid();
      streamingIdRef.current = assistantId;
      setStreaming(true);
      try {
        await startTurn({
          conversationId: cid,
          parentId,
          assistantMessageId: assistantId,
          useRag,
          useGrok,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        streamingIdRef.current = null;
        setStreaming(false);
      }
    },
    [useRag, useGrok],
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
    setInput("");
    setAttachments([]);
    setSandboxFiles([]);
    attach(userMsg);

    const cid = await ensureConversation(text || "New chat");
    await saveMessage(cid, userMsg);
    await beginTurn(cid, userMsg.id);
  }, [
    input,
    attachments,
    sandboxFiles,
    streaming,
    messages,
    ensureConversation,
    beginTurn,
    attach,
  ]);

  // Edit any turn as a NEW version (branch), preserving the old one. Editing a
  // user turn creates a sibling and regenerates; editing an assistant turn saves
  // a sibling with the new text (no regeneration).
  const editMessage = useCallback(
    async (messageId: string, newText: string) => {
      if (streaming || !conversationId) return;
      const original = allMessages.find((m) => m.id === messageId);
      if (!original) {
        setError("Could not find the message to edit. Reload and try again.");
        return;
      }
      setError(null);

      const sibling: UIMessage = {
        id: nanoid(),
        role: original.role,
        content: newText,
        images: original.images,
        parentId: original.parentId ?? null,
        createdAt: Date.now(),
      };
      await saveMessage(conversationId, sibling);
      attach(sibling);

      if (sibling.role === "user") {
        await beginTurn(conversationId, sibling.id);
      } else {
        onPersisted();
      }
    },
    [
      streaming,
      conversationId,
      allMessages,
      beginTurn,
      onPersisted,
      attach,
    ],
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
      await beginTurn(conversationId, parent.id);
    },
    [streaming, conversationId, allMessages, beginTurn],
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
      const previousMessages = allMessages;
      const previousRootChildId = rootChildId;
      if (parentId) {
        setAllMessages((prev) =>
          prev.map((m) =>
            m.id === parentId ? { ...m, activeChildId: target.id } : m,
          ),
        );
      } else {
        setRootChildId(target.id);
      }
      try {
        await setActiveBranch(conversationId, parentId, target.id);
        setError(null);
      } catch (err) {
        setAllMessages(previousMessages);
        setRootChildId(previousRootChildId);
        setError(err instanceof Error ? err.message : "Switch version failed");
      }
    },
    [streaming, conversationId, allMessages, rootChildId],
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
      className="relative flex h-dvh min-w-0 flex-1 flex-col"
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
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 sm:px-4">
        {isMobile && (
          <button
            onClick={onOpenSidebar}
            className="-ml-1 shrink-0 p-1 text-muted hover:text-foreground"
            title="選單"
          >
            <Menu size={20} />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted">
          {title ?? "New chat"}
        </span>
        <div className="hidden lg:block">
          <ConnectionStatus />
        </div>
        <button
          onClick={onToggleRag}
          disabled={docCount === 0}
          title={
            docCount === 0
              ? "Upload documents to enable"
              : "Ground answers in your documents"
          }
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 ${
            useRag && docCount > 0
              ? "border-accent bg-accent/15 text-accent"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          <BookOpen size={13} />
          <span className="hidden lg:inline">
            Docs{docCount > 0 ? ` (${docCount})` : ""}
          </span>
        </button>
        {conversationId && (
          <button
            onClick={() => setExplorerOpen(true)}
            title="沙盒檔案總管"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs text-muted transition hover:text-foreground sm:px-3"
          >
            <FolderOpen size={13} />
            <span className="hidden lg:inline">Files</span>
          </button>
        )}
        {grokEnabled && (
          <button
            onClick={() => setVoiceOpen(true)}
            disabled={!voiceSupported}
            title={voiceUnavailableReason ?? "即時語音對話 (xAI Realtime)"}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:px-3"
          >
            <AudioLines size={13} />
            <span className="hidden lg:inline">Voice</span>
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
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 ${
            useGrok && grokEnabled
              ? "border-accent bg-accent/15 text-accent"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          <Globe size={13} />
          <span className="hidden lg:inline">Grok</span>
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={updateAutoScroll}
        className="flex-1 overflow-y-auto"
      >
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
                  isMobile={isMobile}
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
        isMobile={isMobile}
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
