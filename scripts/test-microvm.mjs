// Standalone smoke test of the Node->WSL->Node microVM round trip.
// Mirrors src/lib/sandbox/microvm.ts exactly (UNC file I/O + wsl.exe bridge).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DISTRO = "Ubuntu";
const WSL_ROOT = "/srv/llm-sandboxes";
const WSL_HOME = "/home/jason/llm-sandbox";
const CONV = "testnode";

const toUnc = (p) =>
  `\\\\wsl.localhost\\${DISTRO}\\` + p.replace(/^\/+/, "").replace(/\//g, "\\");
const ws = path.win32.join(toUnc(WSL_ROOT), CONV);
const runDir = path.win32.join(ws, ".run");

fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.win32.join(runDir, "in.json"),
  JSON.stringify({
    language: "python",
    code: "import sys,platform\nprint('from node-driven VM', sys.version.split()[0])\nopen('node_out.txt','w').write('ok')\n",
    timeoutMs: 30000,
    maxOutputChars: 20000,
  }),
);
fs.rmSync(path.win32.join(runDir, "out.json"), { force: true });

console.log("[host] in.json staged at", runDir);
const start = Date.now();
const child = spawn(
  "wsl.exe",
  ["-d", DISTRO, "--", "bash", `${WSL_HOME}/vm-run.sh`, CONV, "2", "1024", "30"],
  { windowsHide: true, stdio: "inherit" },
);
child.on("close", () => {
  const elapsed = Date.now() - start;
  try {
    const out = JSON.parse(fs.readFileSync(path.win32.join(runDir, "out.json"), "utf-8"));
    console.log("[host] out.json:", out);
    console.log("[host] node_out.txt:", fs.readFileSync(path.win32.join(ws, "node_out.txt"), "utf-8"));
    console.log(`[host] round trip ${elapsed} ms`);
    console.log(out.exitCode === 0 ? "PASS" : "FAIL");
  } catch (e) {
    console.log("FAIL - could not read result:", String(e));
  }
});
