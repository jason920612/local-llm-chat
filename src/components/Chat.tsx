"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Bot, BookOpen, Globe } from "lucide-react";
import type { Conversation, UIMessage } from "@/lib/types";
import {
  createConversationApi,
  fetchConversation,
  parseCitationsHeader,
  parseImagesHeader,
  saveMessage,
} from "@/lib/api";
import { fileToResizedDataURL, isImageFile } from "@/lib/image";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ConnectionStatus } from "./ConnectionStatus";

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
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The conversation currently loaded into `messages`. Used to avoid reloading
  // (and clobbering an in-progress stream) when we create a conversation locally.
  const loadedId = useRef<string | null>(null);

  // Load messages when the active conversation changes externally.
  useEffect(() => {
    if (conversationId === loadedId.current) return;
    loadedId.current = conversationId;
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    fetchConversation(conversationId)
      .then((d) => !cancelled && setMessages(d.messages))
      .catch(() => !cancelled && setMessages([]));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

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

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    setError(null);

    const images = attachments;
    const userMsg: UIMessage = {
      id: nanoid(),
      role: "user",
      content: text,
      images: images.length > 0 ? images : undefined,
      createdAt: Date.now(),
    };
    const assistantMsg: UIMessage = {
      id: nanoid(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    const history = [...messages, userMsg];
    setMessages([...history, assistantMsg]);
    setInput("");
    setAttachments([]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Ensure a conversation exists before persisting anything.
      let cid = conversationId;
      if (!cid) {
        const conv = await createConversationApi(
          text.slice(0, 40) || "Image chat",
        );
        cid = conv.id;
        loadedId.current = cid; // don't reload over our own stream
        onCreated(conv);
      }

      await saveMessage(cid, userMsg);

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
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, content: acc } : m,
          ),
        );
      }

      const finalAssistant: UIMessage = {
        ...assistantMsg,
        content: acc,
        citations: citations.length > 0 ? citations : undefined,
        images: genImages.length > 0 ? genImages : undefined,
      };
      setMessages((prev) =>
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
        setMessages((prev) =>
          prev.filter((m) => !(m.id === assistantMsg.id && m.content === "")),
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [
    input,
    attachments,
    streaming,
    messages,
    conversationId,
    useRag,
    useGrok,
    onCreated,
    onPersisted,
  ]);

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen flex-1 flex-col">
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
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                streaming={
                  streaming &&
                  i === messages.length - 1 &&
                  m.role === "assistant"
                }
              />
            ))}
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
        onAttachFiles={addAttachments}
        onRemoveAttachment={removeAttachment}
      />
    </div>
  );
}
