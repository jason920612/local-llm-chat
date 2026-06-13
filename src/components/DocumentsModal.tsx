"use client";

import { useRef, useState } from "react";
import { Upload, Trash2, X, FileText, Loader2 } from "lucide-react";
import type { RagDocument } from "@/lib/types";
import { deleteDocumentApi, uploadDocuments } from "@/lib/api";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsModal({
  open,
  onClose,
  documents,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  documents: RagDocument[];
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { errors } = await uploadDocuments(files);
      if (errors.length > 0) {
        setError(errors.map((e) => `${e.name}: ${e.error}`).join("; "));
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteDocumentApi(id);
    onChanged();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Knowledge base</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-2 px-3 py-4 text-sm text-muted hover:border-accent hover:text-foreground disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Processing &
                embedding…
              </>
            ) : (
              <>
                <Upload size={16} /> Upload PDF, txt, md, csv, json
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,application/pdf,text/*"
            multiple
            hidden
            onChange={(e) => {
              handleFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {error && (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {documents.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">
              No documents yet. Upload files to ground answers in your content.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <FileText size={16} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{d.name}</div>
                    <div className="text-[11px] text-muted">
                      {formatSize(d.size)} · {d.chunkCount} chunks
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(d.id)}
                    className="shrink-0 text-muted hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
