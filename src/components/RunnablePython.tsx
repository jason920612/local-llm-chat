"use client";

import { useState } from "react";
import { Play, Loader2, X } from "lucide-react";
import { runPythonPreview, type PyRunResult } from "@/lib/artifacts/python";

/**
 * A Python code block with a "Run" button that executes it in the browser via
 * Pyodide and shows stdout/stderr plus any matplotlib figures inline.
 */
export function RunnablePython({ children }: { children: React.ReactNode }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PyRunResult | null>(null);
  const [code, setCode] = useState<string>("");

  // Pull the raw code text out of the rendered <code> element once mounted.
  const refCb = (el: HTMLElement | null) => {
    if (el) setCode(el.textContent ?? "");
  };

  async function run() {
    if (!code.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await runPythonPreview(code));
    } catch (e) {
      setResult({
        stdout: "",
        stderr: "",
        error: String((e as Error)?.message || e),
        images: [],
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="group/code relative my-2 min-w-0 max-w-full overflow-hidden">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-accent hover:text-foreground disabled:opacity-60"
        >
          {running ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Play size={11} />
          )}
          {running ? "執行中…" : "執行"}
        </button>
      </div>
      <pre ref={refCb} className="max-w-full overflow-x-auto">
        {children}
      </pre>

      {result && (
        <div className="mt-1 overflow-hidden rounded-lg border border-border bg-[#0d0f15] text-xs">
          <div className="flex items-center justify-between border-b border-border px-3 py-1 text-muted">
            <span>輸出</span>
            <button
              onClick={() => setResult(null)}
              className="hover:text-foreground"
              title="清除"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[360px] overflow-auto p-3">
            {result.stdout && (
              <pre className="whitespace-pre-wrap break-words text-foreground">
                {result.stdout}
              </pre>
            )}
            {result.stderr && (
              <pre className="whitespace-pre-wrap break-words text-amber-400">
                {result.stderr}
              </pre>
            )}
            {result.error && (
              <pre className="whitespace-pre-wrap break-words text-red-400">
                {result.error}
              </pre>
            )}
            {!result.stdout && !result.stderr && !result.error && (
              <span className="text-muted">（無輸出）</span>
            )}
            {result.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`figure ${i + 1}`}
                className="mt-2 max-w-full rounded border border-border bg-white"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
