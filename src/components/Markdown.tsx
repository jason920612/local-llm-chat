"use client";

import { isValidElement, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Artifact, artifactKind } from "./Artifact";
import { RunnablePython } from "./RunnablePython";

/** Recursively collect the raw text of a (possibly highlighted) node tree. */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** Read the `language-xxx` class off a fenced block's <code> child. */
function langOf(node: React.ReactNode): string {
  if (isValidElement(node)) {
    const cn = (node.props as { className?: string }).className;
    const m = cn?.match(/language-([\w-]+)/);
    if (m) return m[1];
  }
  return "";
}

/** A code block with a copy button that auto-collapses when it's tall. */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const lang = langOf(children);
  const kind = artifactKind(lang);
  // Route special fenced blocks to live renderers; the rest fall through to the
  // default collapsible code view below.
  if (kind) return <Artifact kind={kind} code={extractText(children)} />;
  if (lang === "python" || lang === "py")
    return <RunnablePython>{children}</RunnablePython>;
  return <PlainCodeBlock>{children}</PlainCodeBlock>;
}

function PlainCodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [overflows, setOverflows] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ref.current) setOverflows(ref.current.scrollHeight > 380);
  }, [children]);

  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="group/code relative">
      <button
        onClick={copy}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-muted opacity-0 transition hover:text-foreground group-hover/code:opacity-100"
      >
        {copied ? "已複製" : "複製"}
      </button>
      <pre
        ref={ref}
        className={
          collapsed && overflows ? "max-h-[380px] overflow-hidden" : ""
        }
      >
        {children}
      </pre>
      {overflows && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-[#0d0f15] via-[#0d0f15]/90 to-transparent py-1.5 text-xs text-accent hover:text-foreground"
        >
          {collapsed ? "展開程式碼 ▾" : "收合 ▴"}
        </button>
      )}
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ pre: CodeBlock }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
