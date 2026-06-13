import { config } from "../config";
import type { Citation, UIMessage } from "../types";
import { mapGrokCitations } from "./search";
import { generateImage } from "./image";

/**
 * Native xAI Responses API agent (POST /v1/responses).
 *
 * Unlike chat-completions, this uses xAI's own tool model:
 *  - server-side tools (web_search, x_search) run automatically on xAI;
 *  - client-side function tools use the FLAT shape {type:"function", name, ...}
 *    and come back as `function_call` items, answered with `function_call_output`.
 */

const IMAGE_FN = "generate_image";

// Tools sent to the Responses API. web/x search are server-side; generate_image
// is a client-side function we execute. Note the flat function shape.
const RESPONSES_TOOLS = [
  { type: "web_search" },
  { type: "x_search" },
  {
    type: "function",
    name: IMAGE_FN,
    description:
      "Generate an image from a text prompt using Grok Imagine. Use when the user asks to create/draw/generate/imagine a picture, image, logo, or artwork. The image is shown to the user automatically.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "A vivid, detailed English description of the image.",
        },
      },
      required: ["prompt"],
    },
  },
];

interface OutItem {
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  text?: string;
  content?: { type?: string; text?: string }[];
  summary?: { type?: string; text?: string }[];
}

export interface GrokResponseResult {
  text: string;
  reasoning: string;
  citations: Citation[];
  images: string[];
}

/** Map our chat messages into Responses API `input` items. */
function toInput(messages: UIMessage[]): unknown[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user" && m.images && m.images.length > 0) {
        return {
          role: "user",
          content: [
            { type: "input_text", text: m.content },
            ...m.images.map((url) => ({ type: "input_image", image_url: url })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
}

function extractText(output: OutItem[]): string {
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (Array.isArray(item.content)) {
      const t = item.content
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (t.trim()) return t.trim();
    }
  }
  return "";
}

function extractReasoning(output: OutItem[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "reasoning") continue;
    const src = item.content ?? item.summary ?? [];
    parts.push(...src.map((c) => c.text ?? "").filter(Boolean));
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n").trim();
}

async function postResponses(body: Record<string, unknown>): Promise<{
  id?: string;
  output?: OutItem[];
  citations?: unknown[];
}> {
  const res = await fetch(`${config.grok.baseURL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI responses ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Run the Grok Responses agent: native web/x search + client-side image tool.
 * Returns the final answer, reasoning, citations, and any generated images.
 */
export async function runGrokResponses(
  instructions: string,
  messages: UIMessage[],
): Promise<GrokResponseResult> {
  const images: string[] = [];

  let resp = await postResponses({
    model: config.grok.model,
    instructions,
    input: toInput(messages),
    tools: RESPONSES_TOOLS,
  });

  for (let round = 0; round < config.grok.maxRounds; round++) {
    const output = resp.output ?? [];
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;

    const toolOutputs: unknown[] = [];
    for (const call of calls) {
      let out = "";
      if (call.name === IMAGE_FN) {
        try {
          let prompt = "";
          try {
            prompt = JSON.parse(call.arguments || "{}").prompt ?? "";
          } catch {
            /* ignore */
          }
          const src = await generateImage(prompt);
          images.push(src);
          out = "Image generated and shown to the user. Briefly confirm it.";
        } catch (err) {
          out = `generate_image failed: ${
            err instanceof Error ? err.message : "error"
          }`;
        }
      } else {
        out = `Unknown tool: ${call.name}`;
      }
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: out,
      });
    }

    resp = await postResponses({
      model: config.grok.model,
      tools: RESPONSES_TOOLS,
      input: toolOutputs,
      previous_response_id: resp.id,
    });
  }

  const output = resp.output ?? [];
  const rawCitations = Array.isArray(resp.citations) ? resp.citations : [];
  return {
    text: extractText(output),
    reasoning: extractReasoning(output),
    citations: mapGrokCitations(rawCitations, 0),
    images,
  };
}
