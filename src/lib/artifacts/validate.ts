import { Worker } from "node:worker_threads";
import path from "node:path";

/**
 * Server-side artifact validation, so the model gets a real compile/parse error
 * and can fix it before the artifact is shown. Mermaid is validated in an
 * isolated worker thread (jsdom + mermaid.parse) to avoid polluting the server's
 * globals; Vega-Lite charts are validated as JSON.
 */

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

type ArtType = "mermaid" | "chart";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: ValidationResult) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(
      path.join(process.cwd(), "src", "lib", "artifacts", "mermaid-worker.mjs"),
    );
    worker.on("message", (m: { id: number; ok: boolean; error?: string }) => {
      const resolve = pending.get(m.id);
      if (resolve) {
        pending.delete(m.id);
        resolve({ ok: m.ok, error: m.error });
      }
    });
    worker.on("error", () => {
      // On a worker crash, fail open for everyone waiting (don't block output).
      for (const resolve of pending.values()) resolve({ ok: true });
      pending.clear();
      worker = null;
    });
    worker.unref();
  } catch {
    worker = null;
  }
  return worker;
}

/** Compile/validate in the worker; fails open (ok) if the validator is down. */
function runWorker(type: ArtType, spec: string): Promise<ValidationResult> {
  const w = getWorker();
  if (!w) return Promise.resolve({ ok: true });
  return new Promise<ValidationResult>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: true });
    }, 20000);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    try {
      w.postMessage({ id, type, spec });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: true });
    }
  });
}

/** Validate a Mermaid diagram (mermaid.parse in an isolated worker). */
export function validateMermaid(spec: string): Promise<ValidationResult> {
  return runWorker("mermaid", spec);
}

/** Validate a chart by fully COMPILING the Vega-Lite spec (not just JSON). */
export function validateChart(spec: string): Promise<ValidationResult> {
  return runWorker("chart", spec);
}

/** Minimal HTML check (it runs in a sandboxed iframe; just ensure non-empty). */
export function validateHtml(spec: string): ValidationResult {
  return spec.trim().length > 0
    ? { ok: true }
    : { ok: false, error: "empty HTML" };
}
