"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Code2, Eye, Maximize2, X, AlertTriangle, Loader2 } from "lucide-react";
import { loadMermaid, loadVega, type VegaEmbed } from "@/lib/artifacts/loaders";
import { fixMermaidApi } from "@/lib/api";

export type ArtifactKind = "mermaid" | "chart" | "html" | "tradingview";

/** Build a self-contained HTML doc for a TradingView artifact from its config. */
function buildTradingView(spec: string): string {
  let cfg: {
    mode?: string;
    symbol?: string;
    widget?: string;
    interval?: string;
    candles?: unknown[];
  };
  try {
    cfg = JSON.parse(spec);
  } catch {
    return "<p style='color:#fff;font-family:sans-serif;padding:1rem'>invalid chart spec</p>";
  }
  const base = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0b0c10}.tradingview-widget-container,.tradingview-widget-container__widget{height:100%;width:100%}#c{position:absolute;inset:0}</style>`;

  if (cfg.mode === "data") {
    const candles = JSON.stringify(Array.isArray(cfg.candles) ? cfg.candles : []);
    return `${base}<div id="c"></div>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<script>
  const chart = LightweightCharts.createChart(document.getElementById('c'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0b0c10' }, textColor: '#e7e9ee' },
    grid: { vertLines: { color: '#23262f' }, horzLines: { color: '#23262f' } },
    timeScale: { timeVisible: true, borderColor: '#2a2e3a' },
    rightPriceScale: { borderColor: '#2a2e3a' },
  });
  const s = chart.addCandlestickSeries({ upColor:'#26a69a', downColor:'#ef5350', borderVisible:false, wickUpColor:'#26a69a', wickDownColor:'#ef5350' });
  s.setData(${candles});
  chart.timeScale().fitContent();
</script>`;
  }

  const symbol = String(cfg.symbol || "NASDAQ:AAPL");
  const widget = cfg.widget || "advanced";
  const tv = (src: string, conf: object) =>
    `${base}<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><script type="text/javascript" src="${src}" async>${JSON.stringify(conf)}</script></div>`;

  if (widget === "mini") {
    return tv(
      "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js",
      { symbol, width: "100%", height: "100%", dateRange: "3M", colorTheme: "dark", isTransparent: true, autosize: true },
    );
  }
  if (widget === "symbol_overview") {
    return tv(
      "https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js",
      { symbols: [[symbol]], chartOnly: false, width: "100%", height: "100%", colorTheme: "dark", isTransparent: true, autosize: true },
    );
  }
  return tv(
    "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js",
    { autosize: true, symbol, interval: cfg.interval || "D", timezone: "Etc/UTC", theme: "dark", style: "1", locale: "zh_TW", allow_symbol_change: true, hide_side_toolbar: false },
  );
}

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
function HtmlFrame({
  code,
  className,
  sandbox = "allow-scripts allow-popups allow-forms allow-modals",
}: {
  code: string;
  className?: string;
  sandbox?: string;
}) {
  return (
    <iframe
      title="interactive artifact"
      sandbox={sandbox}
      srcDoc={code}
      className={className}
    />
  );
}

function MermaidView({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const [fixing, setFixing] = useState(false);
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const renderSeq = useRef(0);
  useEffect(() => {
    let alive = true;
    setErr("");
    setFixing(false);
    const seq = ++renderSeq.current;
    (async () => {
      const m = await loadMermaid().catch(() => null);
      if (!m) {
        if (alive) setErr("mermaid 載入失敗");
        return;
      }
      // Unique id per render attempt (mermaid rejects a reused id). Clean up any
      // temp/error node mermaid may leave attached to <body> on failure.
      const draw = async (src: string, tag: string) => {
        const fullId = `mmd${rawId}${seq}${tag}`;
        try {
          const { svg } = await m.render(fullId, src);
          return svg;
        } finally {
          document.getElementById(fullId)?.remove();
          document.getElementById(`d${fullId}`)?.remove();
        }
      };
      try {
        const svg = await draw(code, "a");
        if (alive && ref.current) ref.current.innerHTML = svg;
      } catch {
        // Render-failure fallback: ask the model to repair the syntax, retry once.
        if (!alive) return;
        setFixing(true);
        const fixed = await fixMermaidApi(code);
        if (!alive) return;
        setFixing(false);
        if (fixed && fixed.trim() && fixed.trim() !== code.trim()) {
          try {
            const svg = await draw(fixed, "b");
            if (alive && ref.current) ref.current.innerHTML = svg;
            return;
          } catch {
            /* fall through to error */
          }
        }
        if (alive) setErr("圖表語法錯誤，無法渲染（可看原始碼）");
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, rawId]);
  if (err) return <ErrLine msg={err} />;
  if (fixing)
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" /> 自動修正圖表語法中…
      </div>
    );
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
  if (kind === "tradingview")
    return (
      // TradingView's embed needs same-origin to render; this HTML is built by us
      // (not arbitrary model markup), so granting it is safe here.
      <HtmlFrame
        code={buildTradingView(code)}
        sandbox="allow-scripts allow-same-origin allow-popups"
        className={expanded ? "h-full w-full" : "h-[440px] w-full"}
      />
    );
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
  tradingview: "K 線圖",
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
