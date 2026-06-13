"use client";

import {
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  Bot,
  Library,
  Settings,
} from "lucide-react";
import type { Conversation } from "@/lib/types";

export function Sidebar({
  conversations,
  activeId,
  docCount,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onOpenDocs,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  docCount: number;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
  onOpenDocs: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <Bot size={18} className="text-accent" />
        <span className="text-sm font-semibold">Local LLM Chat</span>
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm hover:border-accent"
        >
          <Plus size={16} /> New chat
        </button>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted">
            No conversations yet.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <div
                  className={`group flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                    c.id === activeId
                      ? "bg-surface-2 text-foreground"
                      : "text-muted hover:bg-surface-2/60"
                  }`}
                >
                  <button
                    onClick={() => onSelect(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <MessageSquare size={14} className="shrink-0" />
                    <span className="truncate">{c.title}</span>
                  </button>
                  <button
                    onClick={() => onRename(c.id, c.title)}
                    className="shrink-0 text-muted opacity-0 transition hover:text-foreground group-hover:opacity-100"
                    title="Rename"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => onDelete(c.id)}
                    className="shrink-0 text-muted opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-border p-2">
        <button
          onClick={onOpenDocs}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <Library size={15} />
          <span className="flex-1 text-left">Knowledge base</span>
          {docCount > 0 && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">
              {docCount}
            </span>
          )}
        </button>
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <Settings size={15} />
          <span className="flex-1 text-left">Settings</span>
        </button>
        <div className="px-3 pt-1 text-[11px] text-muted">
          Private · runs on your machine
        </div>
      </div>
    </aside>
  );
}
