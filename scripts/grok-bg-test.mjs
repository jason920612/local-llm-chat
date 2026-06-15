// E2E: a long run_code should auto-migrate to background (~10s), then the model
// is woken with the result. Verifies Route B end-to-end through Grok.
import { randomUUID } from "node:crypto";

const BASE = "http://localhost:3000";
const j = (r) => r.json();
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const MARK = "SLEPT_DONE_" + Math.floor(Math.random() * 1e6);

const main = async () => {
  await post("/api/settings", { chatTarget: "grok" });
  const conv = await j(await post("/api/conversations", { title: "bg run test" }));
  const userId = randomUUID();
  await post(`/api/conversations/${conv.id}/messages`, {
    id: userId, role: "user",
    content: `Use the run_code tool to run exactly this bash: \`sleep 15; echo ${MARK}\`. Just run it.`,
    parentId: null, createdAt: Date.now(),
  });
  const chat = await j(await post("/api/chat", { conversationId: conv.id, parentId: userId, useGrok: true }));
  console.log("conv", conv.id, "gen", chat.generationId);

  const t0 = Date.now();
  let firstSeen = 0, woke = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await j(await fetch(`${BASE}/api/conversations/${conv.id}`));
    const asst = st.messages.filter((m) => m.role === "assistant" && m.content);
    const first = asst.find((m) => m.id === chat.generationId);
    if (first && first.status !== "streaming" && !firstSeen) {
      firstSeen = Math.round((Date.now() - t0) / 1000);
      console.log(`\n[${firstSeen}s] FIRST reply (expect 'moved to background'):\n` + first.content.slice(0, 400));
    }
    // a woken reply = any assistant message after the first that mentions the marker
    const wokeMsg = asst.find((m) => m.id !== chat.generationId && m.content.includes(MARK));
    if (wokeMsg) {
      woke = true;
      console.log(`\n[${Math.round((Date.now()-t0)/1000)}s] WOKEN reply mentions ${MARK}:\n` + wokeMsg.content.slice(0, 400));
      break;
    }
  }
  console.log("\n=== RESULT ===");
  console.log("first reply at", firstSeen, "s; model woken with result:", woke ? "YES ✅" : "NO ❌");
};
main();
