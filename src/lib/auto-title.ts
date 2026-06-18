import { config } from "./config";
import { grokClient } from "./llm";
import { computePath } from "./tree";
import { getConversation, getConversationMeta, renameConversation } from "./repo";

const inflight = new Set<string>();

function cleanTitle(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[#*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

export async function generateConversationTitle(
  conversationId: string,
): Promise<ReturnType<typeof getConversationMeta>> {
  if (!config.grok.enabled || inflight.has(conversationId)) return null;
  const data = getConversation(conversationId);
  if (!data || data.conversation.titleSource === "manual") return null;
  const active = computePath(data.messages, data.rootChildId).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  if (active.length < 2) return null;

  inflight.add(conversationId);
  try {
    const transcript = active
      .slice(-8)
      .map((m) => {
        const text = (m.content || "").replace(/\s+/g, " ").trim();
        return `${m.role}: ${text.slice(0, 900)}`;
      })
      .join("\n");
    const res = await grokClient.chat.completions.create({
      model: config.grok.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You generate concise chat titles. Output only one title, no quotes, no punctuation wrapper, no explanation. Use the user's main language. Prefer Traditional Chinese for Chinese conversations. 4-16 Chinese characters or 3-7 English words.",
        },
        {
          role: "user",
          content: `Create a useful title for this conversation:\n\n${transcript}`,
        },
      ],
    });
    const title = cleanTitle(res.choices[0]?.message?.content ?? "");
    if (!title) return null;
    const latest = getConversationMeta(conversationId);
    if (!latest || latest.titleSource === "manual") return null;
    renameConversation(conversationId, title, "auto");
    return getConversationMeta(conversationId);
  } catch {
    return null;
  } finally {
    inflight.delete(conversationId);
  }
}
