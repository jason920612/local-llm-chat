"use client";

import { User, Bot } from "lucide-react";
import type { UIMessage } from "@/lib/types";
import { Markdown } from "./Markdown";

export function MessageBubble({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className="flex gap-3 px-4 py-4">
      <div
        className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-accent-strong" : "bg-surface-2"
        }`}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-medium text-muted">
          {isUser ? "You" : "Assistant"}
        </div>

        {message.images && message.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`attachment ${i + 1}`}
                className="max-h-48 rounded-lg border border-border object-contain"
              />
            ))}
          </div>
        )}

        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <Markdown>
            {message.content || (streaming ? "" : "_(empty response)_")}
          </Markdown>
        )}

        {streaming && (
          <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent align-middle" />
        )}
      </div>
    </div>
  );
}
