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

/** Validate a Mermaid diagram; fails open (ok) if the validator is unavailable. */
export function validateMermaid(spec: string): Promise<ValidationResult> {
  const w = getWorker();
  if (!w) return Promise.resolve({ ok: true });
  return new Promise<ValidationResult>((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: true });
    }, 15000);
    const wrapped = (r: ValidationResult) => {
      clearTimeout(timer);
      resolve(r);
    };
    pending.set(id, wrapped);
    try {
      w.postMessage({ id, spec });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: true });
    }
  });
}

/** Validate a Vega-Lite spec as JSON (catches the common malformed-JSON error). */
export function validateChart(spec: string): ValidationResult {
  try {
    const obj = JSON.parse(spec);
    if (typeof obj !== "object" || obj === null) {
      return { ok: false, error: "spec must be a JSON object" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "invalid JSON: " + (e as Error).message };
  }
}

/** Minimal HTML check (it runs in a sandboxed iframe; just ensure non-empty). */
export function validateHtml(spec: string): ValidationResult {
  return spec.trim().length > 0
    ? { ok: true }
    : { ok: false, error: "empty HTML" };
}
