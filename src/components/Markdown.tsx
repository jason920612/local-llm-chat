"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

/** A code block that auto-collapses when it's tall, with an expand toggle. */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (ref.current) setOverflows(ref.current.scrollHeight > 380);
  }, [children]);

  return (
    <div className="group/code relative">
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
