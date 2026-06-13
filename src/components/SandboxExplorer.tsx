"use client";

import { useEffect, useState } from "react";
import { X, FileCode, Download, RefreshCw, Package } from "lucide-react";
import type { SandboxFileMeta } from "@/lib/types";
import { fetchSandboxFiles, downloadSandboxArchive } from "@/lib/api";
import { FilePreview, isPreviewable } from "./FilePreview";

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function SandboxExplorer({
  open,
  onClose,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string | null;
}) {
  const [files, setFiles] = useState<SandboxFileMeta[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!conversationId) return;
    setBusy(true);
    try {
      setFiles(await fetchSandboxFiles(conversationId));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setViewer(null);
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId]);

  if (!open) return null;

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const allSelected = files.length > 0 && selected.size === files.length;

  const fileUrl = (name: string, dl = false) =>
    `/api/sandbox/${conversationId}/file?name=${encodeURIComponent(name)}${
      dl ? "&download=1" : ""
    }`;

  function view(name: string) {
    if (!conversationId) return;
    setViewer(name);
  }

  async function downloadTar() {
    if (!conversationId || selected.size === 0) return;
    await downloadSandboxArchive(conversationId, [...selected]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">沙盒檔案總管</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={refresh}
              className="text-muted hover:text-foreground"
              title="重新整理"
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="text-muted hover:text-foreground">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 border-b border-border px-5 py-2 text-xs">
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? new Set(files.map((f) => f.name)) : new Set(),
                )
              }
            />
            全選
          </label>
          <span className="text-muted">已選 {selected.size} 個</span>
          <button
            onClick={downloadTar}
            disabled={selected.size === 0}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-accent-strong px-2.5 py-1 text-white hover:bg-accent disabled:opacity-40"
          >
            <Package size={13} /> 下載選取為 .tar
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {files.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">
              此對話的沙盒目前沒有檔案。上傳檔案或讓模型用 run_code 產生。
            </p>
          ) : (
            <ul className="space-y-1">
              {files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.name)}
                    onChange={() => toggle(f.name)}
                  />
                  <FileCode size={14} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-muted">{fmtSize(f.size)}</span>
                  {(f.isText || isPreviewable(f.name)) && (
                    <button
                      onClick={() => view(f.name)}
                      className="shrink-0 text-accent hover:text-foreground"
                    >
                      檢視
                    </button>
                  )}
                  <a
                    href={fileUrl(f.name, true)}
                    className="shrink-0 text-accent hover:text-foreground"
                    title="下載"
                  >
                    <Download size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {viewer && conversationId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setViewer(null)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate font-mono text-xs">{viewer}</span>
              <div className="flex items-center gap-3">
                <a
                  href={fileUrl(viewer, true)}
                  className="text-xs text-accent hover:text-foreground"
                >
                  下載
                </a>
                <button
                  onClick={() => setViewer(null)}
                  className="text-muted hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <FilePreview conversationId={conversationId} name={viewer} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
