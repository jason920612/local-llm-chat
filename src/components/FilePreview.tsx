"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  loadPdfjs,
  loadMammoth,
  loadSheetJs,
  PDF_CMAP_URL,
} from "@/lib/artifacts/loaders";
import { Markdown } from "./Markdown";

function ext(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

const IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
const AUDIO = ["mp3", "wav", "ogg", "m4a", "aac", "flac"];
const VIDEO = ["mp4", "webm", "mov", "mkv", "ogv"];
const SHEET = ["xlsx", "xls", "csv", "tsv"];
const OFFICE_PDF = ["pptx", "ppt", "odp"]; // previewed by converting to PDF

/** Extensions that get a rich rendered preview (beyond plain text/code). */
export function isPreviewable(name: string): boolean {
  const e = ext(name);
  return (
    ["pdf", "docx", "html", "htm"].includes(e) ||
    IMG.includes(e) ||
    AUDIO.includes(e) ||
    VIDEO.includes(e) ||
    SHEET.includes(e) ||
    OFFICE_PDF.includes(e)
  );
}

function fileUrl(conversationId: string, name: string): string {
  return `/api/sandbox/${conversationId}/file?name=${encodeURIComponent(name)}`;
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 size={14} className="animate-spin" /> 載入中…
    </div>
  );
}
function ErrBox({ msg }: { msg: string }) {
  return <div className="p-4 text-sm text-amber-400">渲染失敗：{msg}</div>;
}

/** Render a PDF (from a data-fetching thunk) to stacked canvases via pdf.js. */
function PdfCanvases({ fetchData }: { fetchData: () => Promise<ArrayBuffer> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const data = await fetchData();
        const pdf = await pdfjs.getDocument({
          data,
          cMapUrl: PDF_CMAP_URL,
          cMapPacked: true,
        }).promise;
        if (!alive || !ref.current) return;
        ref.current.innerHTML = "";
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className =
            "mx-auto mb-3 max-w-full rounded border border-border";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ref.current.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (!alive) return;
        }
      } catch (e) {
        if (alive) setErr(String((e as Error)?.message || e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (err) return <ErrBox msg={err} />;
  return <div ref={ref} className="bg-[#0d0f15] p-3" />;
}

function DocxView({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mammoth = await loadMammoth();
        const arrayBuffer = await (await fetch(url)).arrayBuffer();
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        if (alive) setHtml(value);
      } catch (e) {
        if (alive) setErr(String((e as Error)?.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <ErrBox msg={err} />;
  if (html == null) return <Spinner />;
  const doc = `<!doctype html><meta charset="utf-8"><style>
    body{font-family:system-ui,"Noto Sans TC",sans-serif;color:#111;background:#fff;padding:24px;line-height:1.6;max-width:800px;margin:0 auto}
    img{max-width:100%} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:4px 8px}
  </style>${html}`;
  return (
    <iframe
      title="docx preview"
      sandbox=""
      srcDoc={doc}
      className="h-[78vh] w-full bg-white"
    />
  );
}

function HtmlView({ url }: { url: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => r.text())
      .then((t) => alive && setCode(t))
      .catch(() => alive && setCode(""));
    return () => {
      alive = false;
    };
  }, [url]);
  if (code == null) return <Spinner />;
  return (
    <iframe
      title="html preview"
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      srcDoc={code}
      className="h-[78vh] w-full bg-white"
    />
  );
}

/** xlsx / xls / csv / tsv rendered as HTML tables via SheetJS. */
function SheetView({ url, name }: { url: string; name: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const XLSX = await loadSheetJs();
        const ab = await (await fetch(url)).arrayBuffer();
        const wb = XLSX.read(ab, { type: "array" });
        const out = wb.SheetNames.map((n) => ({
          name: n,
          html: XLSX.utils.sheet_to_html(wb.Sheets[n]),
        }));
        if (alive) setSheets(out);
      } catch (e) {
        if (alive) setErr(String((e as Error)?.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, name]);
  if (err) return <ErrBox msg={err} />;
  if (!sheets) return <Spinner />;
  return (
    <div className="flex h-[78vh] flex-col bg-white text-black">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-300 bg-gray-100 p-1">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${
                i === active ? "bg-white font-medium shadow" : "text-gray-600"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="sheet-preview min-h-0 flex-1 overflow-auto p-2 text-sm [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-gray-300 [&_th]:px-2"
        dangerouslySetInnerHTML={{ __html: sheets[active].html }}
      />
    </div>
  );
}

/** pptx/ppt/odp: convert to PDF on the server (LibreOffice), then render. */
function PptxView({ conversationId, name }: { conversationId: string; name: string }) {
  const [status, setStatus] = useState<"loading" | "ok" | "fail">("loading");
  const convertUrl = `/api/sandbox/${conversationId}/convert?name=${encodeURIComponent(name)}`;
  useEffect(() => {
    let alive = true;
    fetch(convertUrl, { method: "HEAD" })
      .then((r) => alive && setStatus(r.ok ? "ok" : "fail"))
      .catch(() => alive && setStatus("fail"));
    return () => {
      alive = false;
    };
  }, [convertUrl]);
  if (status === "loading") return <Spinner />;
  if (status === "fail") {
    return (
      <div className="p-4 text-sm text-muted">
        無法在瀏覽器內預覽此簡報（需要伺服器安裝 LibreOffice 才能轉檔）。請改用上方「下載」。
      </div>
    );
  }
  return <PdfCanvases fetchData={() => fetch(convertUrl).then((r) => r.arrayBuffer())} />;
}

function TextView({ url, name }: { url: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => r.text())
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(""));
    return () => {
      alive = false;
    };
  }, [url]);
  if (text == null) return <Spinner />;
  const e = ext(name);
  if (e === "md" || e === "markdown") return <Markdown>{text}</Markdown>;
  return <Markdown>{"```" + e + "\n" + text + "\n```"}</Markdown>;
}

/** Render a sandbox file by type. */
export function FilePreview({
  conversationId,
  name,
}: {
  conversationId: string;
  name: string;
}) {
  const url = fileUrl(conversationId, name);
  const e = ext(name);

  if (e === "pdf")
    return (
      <PdfCanvases fetchData={() => fetch(url).then((r) => r.arrayBuffer())} />
    );
  if (e === "docx") return <DocxView url={url} />;
  if (e === "html" || e === "htm") return <HtmlView url={url} />;
  if (IMG.includes(e))
    return (
      <div className="flex justify-center bg-[#0d0f15] p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} className="max-h-[80vh] max-w-full" />
      </div>
    );
  if (AUDIO.includes(e))
    return (
      <div className="p-6">
        <audio controls src={url} className="w-full" />
      </div>
    );
  if (VIDEO.includes(e))
    return (
      <div className="flex justify-center bg-black p-2">
        <video controls src={url} className="max-h-[80vh] max-w-full" />
      </div>
    );
  if (SHEET.includes(e)) return <SheetView url={url} name={name} />;
  if (OFFICE_PDF.includes(e))
    return <PptxView conversationId={conversationId} name={name} />;
  return (
    <div className="p-3">
      <TextView url={url} name={name} />
    </div>
  );
}
