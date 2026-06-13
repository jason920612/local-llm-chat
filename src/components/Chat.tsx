"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Bot } from "lucide-react";
import type { UIMessage } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";

export function Chat() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the view pinned to the latest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    const userMsg: UIMessage = {
      id: nanoid(),
      role: "user",
      content: text,
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
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + chunk }
              : m,
          ),
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // user-initiated stop — keep whatever streamed so far
      } else {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        // drop the empty assistant placeholder on hard failure
        setMessages((prev) =>
          prev.filter((m) => !(m.id === assistantMsg.id && m.content === "")),
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, messages]);

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bot size={18} className="text-accent" />
        <span className="text-sm font-semibold">Local LLM Chat</span>
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
      />
    </div>
  );
}
