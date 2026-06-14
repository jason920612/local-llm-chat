// Runs in a worker thread so jsdom's window/document globals stay isolated from
// the Next server process. Validates artifacts by actually compiling them:
//   mermaid -> mermaid.parse()   chart -> vega-lite compile()
import { parentPort } from "node:worker_threads";
import { JSDOM, VirtualConsole } from "jsdom";

// Swallow jsdom's "not implemented" noise (e.g. canvas.getContext) — we only
// parse/compile, never render, so those warnings are irrelevant.
const vc = new VirtualConsole();
vc.on("jsdomError", () => {});
const dom = new JSDOM("<!DOCTYPE html><body></body>", {
  pretendToBeVisual: true,
  virtualConsole: vc,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let mermaidPromise = null;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mm = m.default;
      mm.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mm;
    });
  }
  return mermaidPromise;
}

let vlPromise = null;
function getVegaLite() {
  if (!vlPromise) vlPromise = import("vega-lite");
  return vlPromise;
}

function clean(e) {
  return String((e && e.message) || e)
    .split("\n")
    .slice(0, 4)
    .join(" ")
    .slice(0, 400);
}

parentPort.on("message", async ({ id, type, spec }) => {
  try {
    if (type === "chart") {
      let obj;
      try {
        obj = JSON.parse(spec);
      } catch (e) {
        parentPort.postMessage({ id, ok: false, error: "invalid JSON: " + clean(e) });
        return;
      }
      const vl = await getVegaLite();
      // Collect error-level log messages too (some issues warn instead of throw).
      const errors = [];
      const logger = {
        level() { return this; },
        error(...a) { errors.push(a.join(" ")); return this; },
        warn() { return this; },
        info() { return this; },
        debug() { return this; },
      };
      vl.compile(obj, { logger });
      if (errors.length) {
        parentPort.postMessage({ id, ok: false, error: errors.join("; ").slice(0, 400) });
        return;
      }
      parentPort.postMessage({ id, ok: true });
      return;
    }
    // default: mermaid
    const mm = await getMermaid();
    await mm.parse(spec);
    parentPort.postMessage({ id, ok: true });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: clean(e) });
  }
});
