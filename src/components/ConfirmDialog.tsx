"use client";

import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";

/**
 * An in-app confirmation modal — replaces the browser's generic window.confirm.
 * Controlled: render it with `open` and handle onConfirm / onCancel.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "確定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc cancels, Enter confirms while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              danger ? "bg-red-500/15 text-red-400" : "bg-surface-2 text-accent"
            }`}
          >
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{title}</h3>
            {message && (
              <p className="mt-1 text-xs leading-relaxed text-muted">{message}</p>
            )}
          </div>
          <button
            onClick={onCancel}
            className="shrink-0 text-muted hover:text-foreground"
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`rounded-lg px-3 py-1.5 text-sm text-white ${
              danger
                ? "bg-red-500 hover:bg-red-600"
                : "bg-accent-strong hover:bg-accent"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
