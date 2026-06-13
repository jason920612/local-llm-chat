"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Code2, Eye, Maximize2, X, AlertTriangle } from "lucide-react";
import { loadMermaid, loadVega, type VegaEmbed } from "@/lib/artifacts/loaders";

export type ArtifactKind = "mermaid" | "chart" | "html";

/** Map a fenced code-block language to an artifact kind (or null if plain). */
export function artifactKind(lang: string): ArtifactKind | null {
  const l = lang.toLowerCase();
  if (l === "mermaid") return "mermaid";
  if (l === "chart" || l === "vega" || l === "vega-lite" || l === "vegalite")
    return "chart";
  if (l === "html") return "html";
  return null;
}

function ErrLine({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 text-xs text-amber-400">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span className="break-words">渲染失敗：{msg}</span>
    </div>
  );
}

/** Model-generated HTML/JS in a locked-down iframe (no same-origin access). */
function HtmlFrame({ code, className }: { code: string; className?: string }) {
  return (
    <iframe
      title="interactive artifact"
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      srcDoc={code}
      className={className}
    />
  );
}

function MermaidView({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    let alive = true;
    setErr("");
    loadMermaid()
      .then((m) => m.render("mmd" + rawId, code))
      .then(({ svg }) => {
        if (alive && ref.current) ref.current.innerHTML = svg;
      })
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [code, rawId]);
  if (err) return <ErrLine msg={err} />;
  return (
    <div
      ref={ref}
      className="flex justify-center p-2 [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}

function ChartView({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    let result: Awaited<ReturnType<VegaEmbed>> | undefined;
    setErr("");
    let spec: unknown;
    try {
      spec = JSON.parse(code);
    } catch (e) {
      setErr("JSON 解析失敗：" + (e as Error).message);
      return;
    }
    loadVega()
      .then((embed) => {
        if (!alive || !ref.current) return undefined;
        return embed(ref.current, spec, {
          actions: false,
          renderer: "canvas",
        });
      })
      .then((r) => {
        result = r;
      })
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => {
      alive = false;
      result?.finalize?.();
    };
  }, [code]);
  if (err) return <ErrLine msg={err} />;
  // White card so default (dark-text) Vega charts stay readable on the dark UI.
  return (
    <div className="overflow-auto rounded bg-white p-2">
      <div ref={ref} />
    </div>
  );
}

function View({ kind, code, expanded }: { kind: ArtifactKind; code: string; expanded?: boolean }) {
  if (kind === "mermaid") return <MermaidView code={code} />;
  if (kind === "chart") return <ChartView code={code} />;
  return (
    <HtmlFrame
      code={code}
      className={expanded ? "h-full w-full" : "h-[360px] w-full"}
    />
  );
}

const LABELS: Record<ArtifactKind, string> = {
  mermaid: "圖解",
  chart: "圖表",
  html: "互動內容",
};

/** A rendered artifact card: inline preview + source toggle + expand modal. */
export function Artifact({ kind, code }: { kind: ArtifactKind; code: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [expanded, setExpanded] = useState(false);

  const header = (inModal: boolean) => (
    <div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-1.5 text-xs">
      <span className="font-medium text-muted">{LABELS[kind]}</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={() => setMode(mode === "preview" ? "source" : "preview")}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:text-foreground"
          title={mode === "preview" ? "看原始碼" : "看預覽"}
        >
          {mode === "preview" ? <Code2 size={13} /> : <Eye size={13} />}
          {mode === "preview" ? "原始碼" : "預覽"}
        </button>
        {inModal ? (
          <button
            onClick={() => setExpanded(false)}
            className="rounded px-1.5 py-0.5 text-muted hover:text-foreground"
            title="關閉"
          >
            <X size={14} />
          </button>
        ) : (
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:text-foreground"
            title="展開"
          >
            <Maximize2 size={13} />
          </button>
        )}
      </div>
    </div>
  );

  const source = (
    <pre className="max-h-[360px] overflow-auto bg-[#0d0f15] p-3 text-xs">
      <code>{code}</code>
    </pre>
  );

  return (
    <>
      <div className="my-2 overflow-hidden rounded-lg border border-border">
        {header(false)}
        {mode === "preview" ? <View kind={kind} code={code} /> : source}
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            {header(true)}
            <div className="min-h-0 flex-1 overflow-auto">
              {mode === "preview" ? (
                <View kind={kind} code={code} expanded />
              ) : (
                source
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
