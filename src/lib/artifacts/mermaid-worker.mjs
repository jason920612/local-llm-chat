// Runs in a worker thread so jsdom's window/document globals stay isolated from
// the Next server process. Validates Mermaid diagrams via mermaid.parse().
import { parentPort } from "node:worker_threads";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
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

parentPort.on("message", async ({ id, spec }) => {
  try {
    const mm = await getMermaid();
    await mm.parse(spec);
    parentPort.postMessage({ id, ok: true });
  } catch (e) {
    const msg = String((e && e.message) || e)
      .split("\n")
      .slice(0, 4)
      .join(" ")
      .slice(0, 400);
    parentPort.postMessage({ id, ok: false, error: msg });
  }
});
