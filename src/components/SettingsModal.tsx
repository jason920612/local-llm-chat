"use client";

import { useCallback, useEffect, useState } from "react";
import { X, CheckCircle2, XCircle } from "lucide-react";
import {
  fetchAppConfig,
  fetchHealth,
  fetchSettings,
  updateSettings,
  type AppConfig,
  type HealthStatus,
  type RuntimeSettings,
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
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchAppConfig().then(setConfig).catch(() => setConfig(null));
    fetchHealth().then(setHealth);
    fetchSettings().then(setSettings).catch(() => setSettings(null));
  }, [open]);

  const applyPatch = useCallback(
    async (patch: {
      chatModel?: string;
      strictMonitor?: boolean;
      chatTarget?: "local" | "grok";
    }) => {
      setSaving(true);
      try {
        await updateSettings(patch);
        setSettings(await fetchSettings());
        setHealth(await fetchHealth()); // model change affects the indicator
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  if (!open) return null;

  // Model options = what LM Studio exposes, plus the current selection.
  const modelOptions = settings
    ? Array.from(
        new Set([settings.chatModel, ...settings.availableModels]),
      ).filter(Boolean)
    : [];

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

          {settings && (
            <>
              <h3 className="mb-1 mt-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Runtime controls
                {saving && <span className="text-[10px] normal-case">saving…</span>}
              </h3>
              <div className="space-y-3 rounded-xl border border-border bg-surface-2 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-muted">Backend</span>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    <button
                      onClick={() => applyPatch({ chatTarget: "local" })}
                      disabled={saving}
                      className={`px-3 py-1 text-xs ${
                        settings.chatTarget === "local"
                          ? "bg-accent-strong text-white"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      Local
                    </button>
                    <button
                      onClick={() => applyPatch({ chatTarget: "grok" })}
                      disabled={saving || !settings.grokAvailable}
                      title={
                        settings.grokAvailable
                          ? "Use xAI Grok (cloud, frontier)"
                          : "Set XAI_API_KEY to enable"
                      }
                      className={`px-3 py-1 text-xs disabled:opacity-40 ${
                        settings.chatTarget === "grok"
                          ? "bg-accent-strong text-white"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      Grok ☁
                    </button>
                  </div>
                </div>

                {settings.chatTarget === "grok" ? (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-muted">Cloud model</span>
                    <span className="font-mono text-xs text-emerald-400">
                      {settings.grokModel}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-muted">Chat model</span>
                    <select
                      value={settings.chatModel}
                      disabled={saving}
                      onChange={(e) => applyPatch({ chatModel: e.target.value })}
                      className="max-w-[260px] flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent disabled:opacity-50"
                    >
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-muted">
                    Strict monitor
                    <span className="ml-1 text-[11px] text-muted/70">
                      (off = faster streaming)
                    </span>
                  </span>
                  <button
                    onClick={() =>
                      applyPatch({ strictMonitor: !settings.strictMonitor })
                    }
                    disabled={saving}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${
                      settings.strictMonitor ? "bg-accent-strong" : "bg-border"
                    }`}
                    title="Toggle strict monitor"
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        settings.strictMonitor ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  Changes take effect immediately — no restart. Switching models
                  uses LM Studio&apos;s loaded/available models (it loads on demand).
                </p>
              </div>
            </>
          )}

          {config && (
            <>
              <h3 className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
                Configuration (env defaults)
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
                <Row
                  label="Strict monitor"
                  value={<Flag on={config.sop.strictMonitor} />}
                />
                <Row
                  label="Max corrections"
                  value={config.sop.maxCorrections}
                />
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
            Runtime controls above override the env defaults and persist locally.
            The remaining values are read from <code>.env.local</code> at startup.
          </p>
        </div>
      </div>
    </div>
  );
}
