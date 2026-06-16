"use client";

import { useState } from "react";
import {
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  Bot,
  Library,
  Activity,
  Settings,
  Link2,
  Check,
  Sparkles,
} from "lucide-react";
import type { Conversation } from "@/lib/types";

export function Sidebar({
  conversations,
  activeId,
  docCount,
  isMobile,
  open,
  onClose,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onOpenDocs,
  onOpenSkills,
  onOpenDashboard,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  docCount: number;
  isMobile: boolean;
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
  onOpenDocs: () => void;
  onOpenSkills: () => void;
  onOpenDashboard: () => void;
  onOpenSettings: () => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyLink = async (id: string) => {
    const url = `${window.location.origin}/c/${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked — ignore */
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  const body = (
    <>
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
          <ul className="space-y-1">
            {conversations.map((c) => {
              const actionVis = isMobile
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100";
              return (
                <li key={c.id} className="group relative">
                  {/* The whole card is the select button. */}
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2.5 pr-20 text-left text-sm transition ${
                      c.id === activeId
                        ? "border-accent/60 bg-surface-2 text-foreground"
                        : "border-transparent text-muted hover:border-border hover:bg-surface-2/60"
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0" />
                    <span className="truncate">{c.title}</span>
                  </button>
                  {/* Action icons float over the card's right padding. */}
                  <div
                    className={`absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5 transition ${actionVis}`}
                  >
                    <button
                      onClick={() => copyLink(c.id)}
                      className={`p-0.5 hover:text-accent ${
                        copiedId === c.id ? "text-accent" : "text-muted"
                      }`}
                      title={copiedId === c.id ? "已複製連結" : "複製此對話連結"}
                    >
                      {copiedId === c.id ? <Check size={14} /> : <Link2 size={14} />}
                    </button>
                    <button
                      onClick={() => onRename(c.id, c.title)}
                      className="p-0.5 text-muted hover:text-foreground"
                      title="重新命名"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => onDelete(c.id)}
                      className="p-0.5 text-muted hover:text-red-400"
                      title="刪除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
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
          onClick={onOpenSkills}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <Sparkles size={15} />
          <span className="flex-1 text-left">Skills</span>
        </button>
        <button
          onClick={onOpenDashboard}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <Activity size={15} />
          <span className="flex-1 text-left">Console</span>
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
    </>
  );

  // Desktop: a persistent column. Mobile: an off-canvas drawer with a backdrop.
  if (!isMobile) {
    return (
      <aside className="flex h-dvh w-64 shrink-0 flex-col border-r border-border bg-surface">
        {body}
      </aside>
    );
  }
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] shrink-0 transform flex-col border-r border-border bg-surface transition-transform ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {body}
      </aside>
    </>
  );
}
