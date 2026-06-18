"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Project } from "@/lib/types";

export function ProjectSettingsModal({
  project,
  onClose,
  onSave,
  onDelete,
}: {
  project: Project | null;
  onClose: () => void;
  onSave: (
    id: string,
    patch: {
      name: string;
      description: string | null;
      systemPrompt: string | null;
      includeGlobalDocuments: boolean;
    },
  ) => Promise<void>;
  onDelete: (id: string, deleteConversations: boolean) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [includeGlobalDocuments, setIncludeGlobalDocuments] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setSystemPrompt(project.systemPrompt ?? "");
    setIncludeGlobalDocuments(project.includeGlobalDocuments);
  }, [project]);

  if (!project) return null;

  async function save() {
    if (!project || !name.trim()) return;
    setBusy(true);
    try {
      await onSave(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        systemPrompt: systemPrompt.trim() || null,
        includeGlobalDocuments,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!project) return;
    const deleteConversations = window.confirm(
      "Also delete every conversation in this project? Cancel keeps conversations and moves them out of the project.",
    );
    const typed = window.prompt(
      `Type DELETE to delete project "${project.name}".`,
    );
    if (typed !== "DELETE") return;
    setBusy(true);
    try {
      await onDelete(project.id, deleteConversations);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Project settings</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Project system prompt
            </span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              placeholder="Leave empty to use only the global system prompt."
              className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed outline-none focus:border-accent"
            />
            <p className="mt-1 text-[11px] text-muted">
              Empty means the project uses the global system prompt only. Filled
              text is appended after the global prompt.
            </p>
          </label>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div>
              <div className="text-sm">Include global documents</div>
              <div className="text-[11px] text-muted">
                Project RAG searches project documents plus global documents.
              </div>
            </div>
            <button
              onClick={() => setIncludeGlobalDocuments((v) => !v)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                includeGlobalDocuments ? "bg-accent-strong" : "bg-border"
              }`}
              title="Toggle global documents"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                  includeGlobalDocuments ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <button
            onClick={remove}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={13} /> Delete project
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy || !name.trim()}
              className="rounded-lg bg-accent-strong px-3 py-1 text-xs text-white transition hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
