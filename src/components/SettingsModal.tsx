"use client";

import { useEffect, useState } from "react";
import { X, CheckCircle2, XCircle } from "lucide-react";
import {
  fetchAppConfig,
  fetchHealth,
  type AppConfig,
  type HealthStatus,
} from "@/lib/api";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="truncate text-right font-mono text-xs">{value}</span>
    </div>
  );
}

function Flag({ on }: { on: boolean }) {
  return (
    <span className={on ? "text-emerald-400" : "text-muted"}>
      {on ? "on" : "off"}
    </span>
  );
}

export function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchAppConfig().then(setConfig).catch(() => setConfig(null));
    fetchHealth().then(setHealth);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Connection
          </h3>
          <div className="rounded-xl border border-border bg-surface-2 px-4 py-3">
            <div className="mb-1 flex items-center gap-2 text-sm">
              {health?.ok ? (
                <CheckCircle2 size={16} className="text-emerald-400" />
              ) : (
                <XCircle size={16} className="text-red-400" />
              )}
              {health?.ok ? "Connected to local server" : "Server unreachable"}
            </div>
            {health?.ok ? (
              <div className="text-xs text-muted">
                Loaded models: {health.models?.join(", ") || "none"}
                <div className="mt-1 space-y-0.5">
                  <div>
                    Chat model{" "}
                    {health.chatLoaded ? (
                      <span className="text-emerald-400">loaded</span>
                    ) : (
                      <span className="text-amber-400">not loaded</span>
                    )}
                  </div>
                  <div>
                    Embedding model{" "}
                    {health.embedLoaded ? (
                      <span className="text-emerald-400">loaded</span>
                    ) : (
                      <span className="text-amber-400">not loaded</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-red-300">{health?.error}</div>
            )}
          </div>

          {config && (
            <>
              <h3 className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
                Configuration
              </h3>
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-2">
                <Row label="Base URL" value={config.baseURL} />
                <Row label="Chat model" value={config.chatModel} />
                <Row label="Embedding model" value={config.embeddingModel} />
                <Row
                  label="Grok search"
                  value={
                    config.grok.enabled ? (
                      <span className="text-emerald-400">
                        {config.grok.model}
                      </span>
                    ) : (
                      <span className="text-muted">disabled (no XAI_API_KEY)</span>
                    )
                  }
                />
                <Row label="RAG top-K" value={config.rag.topK} />
                <Row
                  label="Chunk size / overlap"
                  value={`${config.rag.chunkSize} / ${config.rag.chunkOverlap}`}
                />
              </div>

              <h3 className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
                SOP control (code-enforced)
              </h3>
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-2">
                <Row label="Intent gate" value={<Flag on={config.sop.intentGate} />} />
                <Row label="Blocking mode" value={<Flag on={config.sop.blocking} />} />
                <Row label="Verify gate" value={<Flag on={config.sop.verifyGate} />} />
                <Row
                  label="Structured retries"
                  value={config.sop.maxStructuredRetries}
                />
              </div>
            </>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            Configuration is read from <code>.env.local</code> at startup. Edit
            that file and restart the dev server to change models or toggle SOP
            gates.
          </p>
        </div>
      </div>
    </div>
  );
}
