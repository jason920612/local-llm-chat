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

/** Validate a TradingView embed config (widget symbol, or own-data OHLC). */
export function validateTradingView(spec: string): ValidationResult {
  let o: {
    mode?: string;
    symbol?: string;
    candles?: Array<Record<string, unknown>>;
  };
  try {
    o = JSON.parse(spec);
  } catch (e) {
    return { ok: false, error: "invalid JSON: " + (e as Error).message };
  }
  if (!o || typeof o !== "object") {
    return { ok: false, error: "spec must be an object" };
  }
  if (o.mode === "widget") {
    if (
      typeof o.symbol !== "string" ||
      !/^[A-Za-z0-9._^!&-]+:[A-Za-z0-9._^!&-]+$/.test(o.symbol)
    ) {
      return {
        ok: false,
        error:
          'widget mode needs a TradingView symbol like "EXCHANGE:TICKER" (e.g. NASDAQ:AAPL, BINANCE:BTCUSDT)',
      };
    }
    return { ok: true };
  }
  if (o.mode === "data") {
    const c = o.candles;
    if (!Array.isArray(c) || c.length === 0) {
      return { ok: false, error: "data mode needs a non-empty candles array" };
    }
    let prev = -Infinity;
    for (let i = 0; i < c.length; i++) {
      const k = c[i] as Record<string, unknown>;
      for (const f of ["open", "high", "low", "close"]) {
        if (typeof k?.[f] !== "number" || !isFinite(k[f] as number)) {
          return { ok: false, error: `candle ${i} is missing a numeric "${f}"` };
        }
      }
      const t = k.time;
      const tn =
        typeof t === "number"
          ? t
          : typeof t === "string"
            ? Date.parse(t) / 1000
            : NaN;
      if (!isFinite(tn)) {
        return {
          ok: false,
          error: `candle ${i} has an invalid "time" (use UNIX seconds or "YYYY-MM-DD")`,
        };
      }
      if (tn < prev) {
        return {
          ok: false,
          error: `candles must be in ascending time order (problem at candle ${i})`,
        };
      }
      prev = tn;
    }
    return { ok: true };
  }
  return { ok: false, error: 'mode must be "widget" or "data"' };
}
