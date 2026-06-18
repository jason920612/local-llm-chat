"use client";

import { useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  FolderInput,
  FolderKanban,
  Library,
  Link2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Conversation, Project } from "@/lib/types";

export function Sidebar({
  conversations,
  allConversations,
  projects,
  activeProjectId,
  activeId,
  docCount,
  isMobile,
  open,
  onClose,
  onNew,
  onSelect,
  onSelectProject,
  onShowAll,
  onCreateProject,
  onEditProject,
  onRename,
  onDelete,
  onTogglePin,
  onMoveConversation,
  onDeleteMany,
  onOpenDocs,
  onOpenSkills,
  onOpenDashboard,
  onOpenSettings,
}: {
  conversations: Conversation[];
  allConversations: Conversation[];
  projects: Project[];
  activeProjectId: string | null;
  activeId: string | null;
  docCount: number;
  isMobile: boolean;
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onSelectProject: (id: string) => void;
  onShowAll: () => void;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onMoveConversation: (id: string, projectId: string | null) => void;
  onDeleteMany: () => void;
  onOpenDocs: () => void;
  onOpenSkills: () => void;
  onOpenDashboard: () => void;
  onOpenSettings: () => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const pinned = conversations.filter((c) => c.pinnedAt);
  const unpinned = conversations.filter((c) => !c.pinnedAt);
  const sections = [
    { label: "Pinned", items: pinned },
    { label: activeProject ? "Project chats" : "Recent", items: unpinned },
  ].filter((s) => s.items.length > 0);

  const copyLink = async (id: string) => {
    const url = `${window.location.origin}/c/${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked: ignore */
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  const moveConversation = (id: string) => {
    const lines = [
      "none: No project",
      ...projects.map((p, i) => `${i + 1}: ${p.name}`),
    ];
    const choice = window.prompt(
      `Move conversation to project:\n${lines.join("\n")}`,
    );
    if (!choice) return;
    if (choice.trim().toLowerCase() === "none") {
      onMoveConversation(id, null);
      return;
    }
    const project = projects[Number(choice.trim()) - 1];
    if (project) onMoveConversation(id, project.id);
  };

  const conversationList = conversations.length === 0 ? (
    <p className="px-3 py-6 text-center text-xs text-muted">
      {activeProject ? "No chats in this project yet." : "No conversations yet."}
    </p>
  ) : (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.label}>
          <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {section.label}
          </div>
          <ul className="space-y-1">
            {section.items.map((c) => {
              const actionVis = isMobile
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100";
              return (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2.5 pr-28 text-left text-sm transition ${
                      c.id === activeId
                        ? "border-accent/60 bg-surface-2 text-foreground"
                        : "border-transparent text-muted hover:border-border hover:bg-surface-2/60"
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0" />
                    <span className="truncate">{c.title}</span>
                  </button>
                  <div
                    className={`absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 transition ${actionVis}`}
                  >
                    <button
                      onClick={() => onTogglePin(c.id, !c.pinnedAt)}
                      className="p-0.5 text-muted hover:text-accent"
                      title={c.pinnedAt ? "Unpin" : "Pin"}
                    >
                      {c.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    <button
                      onClick={() => copyLink(c.id)}
                      className={`p-0.5 hover:text-accent ${
                        copiedId === c.id ? "text-accent" : "text-muted"
                      }`}
                      title={copiedId === c.id ? "Copied" : "Copy link"}
                    >
                      {copiedId === c.id ? <Check size={13} /> : <Link2 size={13} />}
                    </button>
                    <button
                      onClick={() => moveConversation(c.id)}
                      className="p-0.5 text-muted hover:text-foreground"
                      title="Move to project"
                    >
                      <FolderInput size={13} />
                    </button>
                    <button
                      onClick={() => onRename(c.id, c.title)}
                      className="p-0.5 text-muted hover:text-foreground"
                      title="Rename"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => onDelete(c.id)}
                      className="p-0.5 text-muted hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  const body = (
    <>
      <div className="flex items-center gap-2 px-4 py-3">
        {activeProject ? (
          <button
            onClick={onShowAll}
            className="text-muted hover:text-foreground"
            title="Back to all chats"
          >
            <ArrowLeft size={17} />
          </button>
        ) : (
          <Bot size={18} className="text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {activeProject?.name ?? "Local LLM Chat"}
        </span>
        {activeProject && (
          <button
            onClick={() => onEditProject(activeProject.id)}
            className="text-muted hover:text-foreground"
            title="Project settings"
          >
            <Settings size={15} />
          </button>
        )}
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm hover:border-accent"
        >
          <Plus size={16} /> {activeProject ? "New project chat" : "New chat"}
        </button>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
        {!activeProject && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
              <span>Projects</span>
              <button
                onClick={onCreateProject}
                className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground"
                title="New project"
              >
                <Plus size={13} />
              </button>
            </div>
            {projects.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted">No projects yet.</p>
            ) : (
              <ul className="space-y-1">
                {projects.map((p) => {
                  const count = allConversations.filter(
                    (c) => c.projectId === p.id,
                  ).length;
                  return (
                    <li key={p.id} className="group relative">
                      <button
                        onClick={() => onSelectProject(p.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted hover:bg-surface-2/60 hover:text-foreground"
                      >
                        <FolderKanban size={14} className="shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className="text-[11px] text-muted/70">{count}</span>
                      </button>
                      <button
                        onClick={() => onEditProject(p.id)}
                        className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-foreground ${
                          isMobile
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100"
                        }`}
                        title="Project settings"
                      >
                        <Settings size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {conversationList}
      </nav>

      <div className="border-t border-border p-2">
        <button
          onClick={onDeleteMany}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 hover:text-red-200"
        >
          <Trash2 size={15} />
          <span className="flex-1 text-left">
            {activeProject ? "Delete project chats" : "Delete chats"}
          </span>
        </button>
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
          Private, runs on your machine
        </div>
      </div>
    </>
  );

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
