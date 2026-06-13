"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadPdfjs, loadMammoth, PDF_CMAP_URL } from "@/lib/artifacts/loaders";
import { Markdown } from "./Markdown";

function ext(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

/** Extensions that get a rich rendered preview (beyond plain text/code). */
export function isPreviewable(name: string): boolean {
  return ["pdf", "docx", "html", "htm"].includes(ext(name));
}

function fileUrl(conversationId: string, name: string): string {
  return `/api/sandbox/${conversationId}/file?name=${encodeURIComponent(name)}`;
}

function PdfView({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const data = await (await fetch(url)).arrayBuffer();
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
          canvas.className = "mx-auto mb-3 max-w-full rounded border border-border";
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
  }, [url]);
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
  // Render the converted HTML inside a no-scripts sandbox iframe for safety.
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

/** Render a sandbox file by type: PDF, DOCX, HTML, or text/markdown/code. */
export function FilePreview({
  conversationId,
  name,
}: {
  conversationId: string;
  name: string;
}) {
  const url = fileUrl(conversationId, name);
  const e = ext(name);
  if (e === "pdf") return <PdfView url={url} />;
  if (e === "docx") return <DocxView url={url} />;
  if (e === "html" || e === "htm") return <HtmlView url={url} />;
  return (
    <div className="p-3">
      <TextView url={url} name={name} />
    </div>
  );
}
