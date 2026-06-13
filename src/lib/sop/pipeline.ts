import type OpenAI from "openai";
import { llm } from "../llm";
import { config } from "../config";
import { buildSystemPrompt } from "../prompts";
import { toOpenAIMessages } from "../openai-format";
import type { ChatRequestBody, UIMessage } from "../types";
import { retrieve } from "../rag/retrieve";
import { askGrok, mapGrokCitations } from "../grok/search";
import { grokSearchTool } from "../grok/tool";
import type { Citation } from "../types";
import { callStructured } from "./structured";
import {
  IntentResult,
  intentJsonSchema,
  VerifyResult,
  verifyJsonSchema,
} from "./schemas";
import {
  enforceCitations,
  isEmptyResponse,
  stripBoilerplate,
} from "./validators";
import { runMonitor, type MonitorResult } from "./monitor";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const RAG_REFUSAL = "The provided documents do not contain this information.";

/** Input the route gathers before invoking the controlled pipeline. */
export interface PipelineInput {
  messages: UIMessage[];
  /** Retrieved RAG context (Phase 4). */
  ragContext?: string;
  /** Number of valid sources for citation enforcement (Phase 4). */
  allowedSources?: number;
}

/** Entry point: run a chat turn under full code-enforced SOP control. */
export async function runControlledChat(
  body: ChatRequestBody,
): Promise<Response> {
  const messages = (body.messages ?? []) as UIMessage[];
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  const hasImages = messages.some(
    (m) => m.role === "user" && m.images && m.images.length > 0,
  );

  try {
    // GATE 1 — intent (code short-circuit). Runs before any answer is produced.
    if (config.sop.intentGate) {
      const clarification = await runIntentGate(messages);
      if (clarification) return textResponse(clarification);
    }

    // RAG retrieval (Phase 4). Grounding + citation enforcement kick in only
    // when documents are toggled on and something is actually retrieved.
    let ragContext: string | undefined;
    let citations: Citation[] = [];
    let allowedSources = 0;
    if (body.useRag) {
      const query = lastUserText(messages);
      const result = await retrieve(query);
      if (result.context) {
        ragContext = result.context;
        citations = result.citations;
        allowedSources = citations.length;
      }
    }

    const useGrok = Boolean(body.useGrok) && config.grok.enabled;

    const systemPrompt = buildSystemPrompt({
      hasImages,
      ragContext,
      hasGrokTool: useGrok,
    });
    const openaiMessages: ChatParam[] = [
      { role: "system", content: systemPrompt },
      ...toOpenAIMessages(messages),
    ];

    // Grok search tool path: let the model call grok_search; resolve it server
    // side and finalize the answer with collected citations.
    if (useGrok) {
      return await runWithGrokTool(openaiMessages, citations);
    }

    // Strict monitor takes precedence: aggressive monitor + scold-correct path.
    if (config.sop.strictMonitor) {
      const result = await runMonitor(openaiMessages, {
        allowedSources,
        requireCitations: allowedSources > 0,
      });
      return monitorResponse(result, citations);
    }

    return config.sop.blocking
      ? await runBlocking(openaiMessages, allowedSources, citations)
      : await runStreaming(openaiMessages, allowedSources, citations);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      {
        error: `Could not reach the local model at ${config.llm.baseURL}. Is LM Studio running with a model loaded? (${message})`,
      },
      { status: 502 },
    );
  }
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content ?? "";
  }
  return "";
}

// --- Gate 1: intent --------------------------------------------------------

const INTENT_SYSTEM = `You are a STRICT intent classifier. Output JSON only, conforming exactly to the schema. Determine whether the LAST user message can be acted on.
Rules:
- Set "ambiguous" to true ONLY when a competent assistant genuinely could not proceed without more information.
- Bias STRONGLY toward ambiguous=false. Greetings, small talk, and clear requests are NOT ambiguous.
- If ambiguous is true, "clarifyingQuestion" must be the single most useful question, in the user's language. Otherwise it must be null.`;

async function runIntentGate(messages: UIMessage[]): Promise<string | null> {
  const transcript = messages
    .slice(-6)
    .map(
      (m) =>
        `${m.role.toUpperCase()}: ${m.content}${
          m.images?.length ? " [image attached]" : ""
        }`,
    )
    .join("\n");

  const result = await callStructured({
    schemaName: "intent_check",
    jsonSchema: intentJsonSchema as unknown as Record<string, unknown>,
    validate: IntentResult,
    messages: [
      { role: "system", content: INTENT_SYSTEM },
      {
        role: "user",
        content: `Conversation so far:\n${transcript}\n\nClassify the LAST user message.`,
      },
    ],
  });

  // Fail OPEN: if the gate itself fails, do not block the user — proceed.
  if (!result) return null;
  if (
    result.ambiguous &&
    result.clarifyingQuestion &&
    result.clarifyingQuestion.trim().length > 0
  ) {
    return result.clarifyingQuestion.trim();
  }
  return null;
}

// --- Streaming path (default) ----------------------------------------------

async function runStreaming(
  openaiMessages: ChatParam[],
  allowedSources: number,
  citations: Citation[],
): Promise<Response> {
  const completion = await llm.chat.completions.create({
    model: config.llm.model,
    messages: openaiMessages,
    stream: true,
    temperature: 0.4,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let acc = "";
      try {
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            acc += delta;
            controller.enqueue(encoder.encode(delta));
          }
        }
        // Deterministic post-check. In streaming mode this is transparency:
        // hard enforcement (rewriting/refusing) happens in blocking mode.
        const { violations } = enforceCitations(acc, allowedSources, RAG_REFUSAL);
        if (violations.length > 0) {
          controller.enqueue(
            encoder.encode(
              `\n\n> ⚠️ Control check: ${violations.join("; ")}`,
            ),
          );
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "stream interrupted";
        controller.enqueue(encoder.encode(`\n\n[stream error: ${message}]`));
      } finally {
        controller.close();
      }
    },
  });

  return streamResponse(stream, citations);
}

// --- Grok search tool path -------------------------------------------------

/** Stream an existing message list (no tools) and attach citations. */
function streamFinal(
  messages: ChatParam[],
  citations: Citation[],
): Promise<Response> {
  return llm.chat.completions
    .create({
      model: config.llm.model,
      messages,
      stream: true,
      temperature: 0.4,
    })
    .then((completion) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of completion) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) controller.enqueue(encoder.encode(delta));
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "stream interrupted";
            controller.enqueue(encoder.encode(`\n\n[stream error: ${message}]`));
          } finally {
            controller.close();
          }
        },
      });
      return streamResponse(stream, citations);
    });
}

/**
 * Resolve grok_search tool calls server-side, then stream the final answer.
 * The local model only ever sees Grok's synthesized answer (+ source list),
 * never the raw search results — keeping its context small.
 */
async function runWithGrokTool(
  openaiMessages: ChatParam[],
  baseCitations: Citation[],
): Promise<Response> {
  const messages = [...openaiMessages];
  const citations: Citation[] = [...baseCitations];
  let usedTool = false;

  for (let round = 0; round < config.grok.maxRounds; round++) {
    const resp = await llm.chat.completions.create({
      model: config.llm.model,
      messages,
      tools: [grokSearchTool],
      tool_choice: "auto",
      temperature: 0.3,
    });

    const msg = resp.choices[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      // Model answered directly without searching.
      if (!usedTool && !config.sop.strictMonitor) {
        return textResponse(msg?.content ?? "", citations);
      }
      break; // finalize below (streamed, or monitored under strict mode)
    }

    usedTool = true;
    messages.push(msg as ChatParam);

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let query = "";
      try {
        query = JSON.parse(call.function.arguments || "{}").query ?? "";
      } catch {
        /* leave empty */
      }

      let toolContent: string;
      try {
        const result = await askGrok(query);
        const mapped = mapGrokCitations(
          result.citations.map((c) => c.snippet),
          citations.length,
        );
        citations.push(...mapped);
        toolContent = result.answer || "(Grok returned no answer)";
        if (mapped.length > 0) {
          toolContent +=
            "\n\nSources:\n" +
            mapped.map((m) => `[${m.index}] ${m.snippet}`).join("\n");
        }
      } catch (err) {
        toolContent = `grok_search failed: ${
          err instanceof Error ? err.message : "error"
        }`;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolContent,
      });
    }
  }

  // Final answer. Under strict monitor, run the scold-correction loop but leave
  // citations unmanaged (-1): Grok already sourced the answer with inline links,
  // so numeric [n] stripping would mangle them and trigger false corrections.
  if (config.sop.strictMonitor) {
    const result = await runMonitor(messages, {
      allowedSources: -1,
      requireCitations: false,
    });
    return monitorResponse(result, citations);
  }
  return streamFinal(messages, citations);
}

/** Wrap a monitor result as a response: answer + neutral control note. */
function monitorResponse(
  result: MonitorResult,
  citations: Citation[],
): Response {
  const footer = result.controlNote ? `\n\n> ${result.controlNote}` : "";
  return textResponse(result.text + footer, citations);
}

// --- Blocking path (full code enforcement) ---------------------------------

async function runBlocking(
  openaiMessages: ChatParam[],
  allowedSources: number,
  citations: Citation[],
): Promise<Response> {
  const res = await llm.chat.completions.create({
    model: config.llm.model,
    messages: openaiMessages,
    temperature: 0.4,
  });

  let text = stripBoilerplate(res.choices[0]?.message?.content ?? "");
  const violations: string[] = [];

  const cited = enforceCitations(text, allowedSources, RAG_REFUSAL);
  text = cited.text;
  violations.push(...cited.violations);

  if (isEmptyResponse(text)) text = "I don't know.";

  // GATE 2 — verify (structured self-check) with one corrective regeneration.
  if (config.sop.verifyGate) {
    const verdict = await runVerifyGate(openaiMessages, text);
    if (verdict && !verdict.passed && verdict.violations.length > 0) {
      violations.push(...verdict.violations);
      const corrected = await regenerate(
        openaiMessages,
        text,
        verdict.violations,
      );
      if (corrected) {
        text = stripBoilerplate(corrected);
        const recited = enforceCitations(text, allowedSources, RAG_REFUSAL);
        text = recited.text;
      }
    }
  }

  const footer =
    violations.length > 0
      ? `\n\n> ⚠️ Control check flagged: ${[...new Set(violations)].join("; ")}`
      : "";

  return textResponse(text + footer, citations);
}

const VERIFY_SYSTEM = `You are a STRICT answer auditor. Given the user's request and a DRAFT answer, output JSON only per the schema. Set "passed" false if the draft: invents facts/citations, answers something not asked, pads with disclaimers/flattery, or is in the wrong language. List concrete failures in "violations".`;

async function runVerifyGate(
  openaiMessages: ChatParam[],
  draft: string,
): Promise<VerifyResult | null> {
  const lastUser = [...openaiMessages]
    .reverse()
    .find((m) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : "[multimodal message]";

  return callStructured({
    schemaName: "verify_check",
    jsonSchema: verifyJsonSchema as unknown as Record<string, unknown>,
    validate: VerifyResult,
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      {
        role: "user",
        content: `USER REQUEST:\n${userText}\n\nDRAFT ANSWER:\n${draft}`,
      },
    ],
  });
}

async function regenerate(
  openaiMessages: ChatParam[],
  draft: string,
  violations: string[],
): Promise<string | null> {
  try {
    const res = await llm.chat.completions.create({
      model: config.llm.model,
      temperature: 0.2,
      messages: [
        ...openaiMessages,
        { role: "assistant", content: draft },
        {
          role: "user",
          content: `Your draft FAILED these checks: ${violations.join(
            "; ",
          )}. Output ONLY a corrected answer that fixes every one. No apologies, no preamble.`,
        },
      ],
    });
    return res.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

// --- Response helpers ------------------------------------------------------

/** Base64(UTF-8 JSON) of citations, for the X-Citations response header. */
function citationsHeader(citations: Citation[]): Record<string, string> {
  if (!citations || citations.length === 0) return {};
  const json = JSON.stringify(citations);
  return { "X-Citations": Buffer.from(json, "utf-8").toString("base64") };
}

function streamResponse(
  stream: ReadableStream<Uint8Array>,
  citations: Citation[] = [],
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...citationsHeader(citations),
    },
  });
}

function textResponse(text: string, citations: Citation[] = []): Response {
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      ...citationsHeader(citations),
    },
  });
}
