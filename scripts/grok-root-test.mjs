// End-to-end: drive the real Grok model to call run_code in the microVM sandbox
// and prove the model runs as root inside its own kernel.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const j = (r) => r.json();
const post = (p, b) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

const PROMPT =
  "Use the run_code tool to execute this bash exactly: `id; whoami; uname -r; " +
  "test -w / && echo ROOTFS=writable || echo ROOTFS=readonly`. " +
  "Then reply with the raw stdout verbatim inside a code block, nothing else.";

const main = async () => {
  // force the Grok cloud backend
  await post("/api/settings", { chatTarget: "grok" });

  const conv = await j(await post("/api/conversations", { title: "root sandbox test" }));
  console.log("conversation:", conv.id);

  const userId = randomUUID();
  await post(`/api/conversations/${conv.id}/messages`, {
    id: userId,
    role: "user",
    content: PROMPT,
    parentId: null,
    createdAt: Date.now(),
  });

  const chat = await j(await post("/api/chat", {
    conversationId: conv.id,
    parentId: userId,
    useGrok: true,
  }));
  const genId = chat.generationId;
  console.log("generation:", genId, "— waiting for Grok + microVM…");

  let asst = null;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const state = await j(await fetch(`${BASE}/api/conversations/${conv.id}`));
    asst = state.messages.find((m) => m.id === genId);
    if (asst && asst.status !== "streaming" && asst.content) break;
    process.stdout.write(".");
  }
  console.log("\n");

  if (!asst) {
    console.log("FAIL: no assistant message produced");
    return;
  }
  console.log("=== Grok tool calls ===");
  for (const t of asst.toolCalls ?? []) {
    console.log(`- ${t.tool ?? t.name}: ${JSON.stringify(t.args ?? t)}`.slice(0, 300));
  }
  console.log("\n=== Grok final reply ===\n" + asst.content);

  // ground truth: read the VM's out.json straight from the conversation workspace
  const outJson = `\\\\wsl.localhost\\Ubuntu\\srv\\llm-sandboxes\\${conv.id}\\.run\\out.json`;
  try {
    const o = JSON.parse(fs.readFileSync(outJson, "utf-8"));
    console.log("\n=== ground-truth .run/out.json (from the VM) ===");
    console.log("stdout:\n" + o.stdout);
    console.log("exitCode:", o.exitCode, "durationMs:", o.durationMs);
    console.log(/uid=0\(root\)/.test(o.stdout) ? "\n✅ PROVEN: model ran as ROOT (uid=0) in the microVM" : "\n⚠️ uid=0 not found in stdout");
  } catch (e) {
    console.log("(could not read VM out.json:", String(e) + ")");
  }
};
main();
