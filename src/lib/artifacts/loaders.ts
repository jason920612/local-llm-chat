"use client";

/**
 * Runtime loaders for heavy, client-only rendering libraries. CDN-only tools
 * are loaded on demand via injected <script> tags; Vega-Lite charts use the
 * locally installed vega/vega-lite packages so chart artifacts work offline.
 * Each loader is memoized so the library is fetched at most once per page.
 */

type AnyWindow = Window &
  typeof globalThis & {
    mermaid?: MermaidApi;
    vegaEmbed?: VegaEmbed;
    loadPyodide?: (opts: { indexURL: string }) => Promise<PyodideApi>;
    pdfjsLib?: PdfjsApi;
    mammoth?: MammothApi;
    XLSX?: SheetJsApi;
  };

export interface SheetJsApi {
  read: (data: ArrayBuffer, opts?: { type: string }) => SheetWorkbook;
  utils: {
    sheet_to_html: (ws: unknown, opts?: { id?: string }) => string;
  };
}
export interface SheetWorkbook {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}

export interface PdfPage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}
export interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
export interface PdfjsApi {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (o: {
    data: ArrayBuffer;
    cMapUrl?: string;
    cMapPacked?: boolean;
  }) => { promise: Promise<PdfDoc> };
}

/** CMap pack for rendering non-embedded CJK (CID) fonts in the browser. */
export const PDF_CMAP_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/";
export interface MammothApi {
  convertToHtml: (
    input: { arrayBuffer: ArrayBuffer },
  ) => Promise<{ value: string }>;
}

export interface MermaidApi {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, def: string) => Promise<{ svg: string }>;
}

export type VegaEmbed = (
  el: HTMLElement,
  spec: unknown,
  opts?: Record<string, unknown>,
) => Promise<{ finalize: () => void }>;

export interface PyodideApi {
  runPythonAsync: (code: string) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<void>;
  loadPackage: (names: string | string[]) => Promise<void>;
  setStdout: (opts: { batched: (s: string) => void }) => void;
  setStderr: (opts: { batched: (s: string) => void }) => void;
  globals: { get: (k: string) => unknown };
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    readdir: (path: string) => string[];
  };
}

const PYODIDE_VERSION = "v0.26.2";
const scriptCache = new Map<string, Promise<void>>();

/** Inject a <script src> once; resolve when it has loaded. */
function loadScript(src: string): Promise<void> {
  const cached = scriptCache.get(src);
  if (cached) return cached;
  const p = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}

let mermaidReady: Promise<MermaidApi> | null = null;
export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = (async () => {
      await loadScript(
        "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
      );
      const m = (window as AnyWindow).mermaid;
      if (!m) throw new Error("mermaid did not load");
      m.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        // Don't inject the "Syntax error" bomb graphic into the page on failure.
        suppressErrorRendering: true,
      });
      return m;
    })();
  }
  return mermaidReady;
}

let vegaReady: Promise<VegaEmbed> | null = null;
export function loadVega(): Promise<VegaEmbed> {
  if (!vegaReady) {
    vegaReady = (async () => {
      const [vega, vegaLite] = await Promise.all([
        import("vega"),
        import("vega-lite"),
      ]);
      const embed: VegaEmbed = async (el, spec, opts = {}) => {
        el.innerHTML = "";
        const compiled = vegaLite.compile(spec as never).spec;
        const runtime = vega.parse(compiled);
        const view = new vega.View(runtime, {
          renderer: String(opts.renderer ?? "canvas") as "canvas" | "svg",
        }).initialize(el);
        await view.runAsync();
        return { finalize: () => view.finalize() };
      };
      return embed;
    })();
  }
  return vegaReady;
}

let pdfjsReady: Promise<PdfjsApi> | null = null;
export function loadPdfjs(): Promise<PdfjsApi> {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
      );
      const lib = (window as AnyWindow).pdfjsLib;
      if (!lib) throw new Error("pdf.js did not load");
      lib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      return lib;
    })();
  }
  return pdfjsReady;
}

let mammothReady: Promise<MammothApi> | null = null;
export function loadMammoth(): Promise<MammothApi> {
  if (!mammothReady) {
    mammothReady = (async () => {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
      );
      const m = (window as AnyWindow).mammoth;
      if (!m) throw new Error("mammoth did not load");
      return m;
    })();
  }
  return mammothReady;
}

let sheetReady: Promise<SheetJsApi> | null = null;
export function loadSheetJs(): Promise<SheetJsApi> {
  if (!sheetReady) {
    sheetReady = (async () => {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
      );
      const x = (window as AnyWindow).XLSX;
      if (!x) throw new Error("SheetJS did not load");
      return x;
    })();
  }
  return sheetReady;
}

let pyodideReady: Promise<PyodideApi> | null = null;
export function loadPyodideRuntime(): Promise<PyodideApi> {
  if (!pyodideReady) {
    pyodideReady = (async () => {
      await loadScript(
        `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`,
      );
      const factory = (window as AnyWindow).loadPyodide;
      if (!factory) throw new Error("pyodide did not load");
      return factory({
        indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
      });
    })();
  }
  return pyodideReady;
}
