import { config } from "../config";
import type { Citation, UIMessage, SandboxFileMeta, ArtifactMeta } from "../types";
import {
  validateMermaid,
  validateChart,
  validateHtml,
  validateTradingView,
} from "../artifacts/validate";
import { mapGrokCitations } from "./search";
import { generateImage } from "./image";
import { generateVideo } from "./video";
import {
  runCode,
  cloneRepo,
  saveMediaToSandbox,
  mountSkill,
} from "../sandbox/run";
import { getSkill, installSkill } from "../skills";

/**
 * Native xAI Responses API agent (POST /v1/responses).
 *
 * Unlike chat-completions, this uses xAI's own tool model:
 *  - server-side tools (web_search, x_search) run automatically on xAI;
 *  - client-side function tools use the FLAT shape {type:"function", name, ...}
 *    and come back as `function_call` items, answered with `function_call_output`.
 */

const IMAGE_FN = "generate_image";
const VIDEO_FN = "generate_video";
const ARTIFACT_FN = "create_artifact";
const TRADINGVIEW_FN = "embed_tradingview";
const CODE_FN = "run_code";
const SKILL_FN = "use_skill";
const CLONE_FN = "clone_repo";
const INSTALL_FN = "install_skill";

const BASE_TOOLS = [
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
  {
    type: "function",
    name: VIDEO_FN,
    description:
      "Generate a short video (~6s) from a text prompt using Grok Imagine (it auto-creates a still image from the prompt and animates it). Use only when the user explicitly asks for a video/animation/clip. Takes a couple of minutes; the video is shown automatically.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "A vivid English description of the video and its motion.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: ARTIFACT_FN,
    description:
      "Validate and register a rich visual artifact to embed in your reply: a diagram, data chart, or interactive widget. The app COMPILES it and returns any syntax error so you can fix it and call again. On success you get an index N — then write [[artifact:N]] on its own line in your reply where it should appear. ALWAYS use this instead of writing raw ```mermaid/```chart/```html in the message.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["mermaid", "chart", "html"],
          description:
            "mermaid = diagram; chart = Vega-Lite v5 JSON; html = self-contained interactive HTML.",
        },
        spec: {
          type: "string",
          description:
            "The artifact source: Mermaid text, a Vega-Lite v5 JSON spec, or a full HTML document.",
        },
      },
      required: ["type", "spec"],
    },
  },
  {
    type: "function",
    name: TRADINGVIEW_FN,
    description:
      "Embed a TradingView candlestick (K-line) chart for an asset. It's validated, then you place it with [[artifact:N]] in your reply. Two modes: mode='widget' uses TradingView's own live data — ONLY for assets that ACTUALLY trade on TradingView with a real symbol like NASDAQ:AAPL or BINANCE:BTCUSDT (a wrong/non-existent symbol shows 'Invalid symbol'). If the asset is not publicly listed, hypothetical, or you're unsure the symbol exists, use mode='data' with your own OHLC candles instead. Use for any stock/crypto/forex price chart.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["widget", "data"] },
        symbol: {
          type: "string",
          description:
            'widget mode: TradingView symbol "EXCHANGE:TICKER" (e.g. NASDAQ:AAPL, BINANCE:BTCUSDT, FX:EURUSD).',
        },
        widget: {
          type: "string",
          enum: ["advanced", "mini", "symbol_overview"],
          description:
            "widget style (mode=widget). advanced = full interactive chart (default); mini/symbol_overview = lightweight.",
        },
        interval: {
          type: "string",
          description: "advanced widget interval, e.g. D, W, M, 60, 15.",
        },
        candles: {
          type: "array",
          description: "mode=data: OHLC bars in ascending time order.",
          items: {
            type: "object",
            properties: {
              time: {
                type: "string",
                description: "UNIX seconds (number) or a 'YYYY-MM-DD' string.",
              },
              open: { type: "number" },
              high: { type: "number" },
              low: { type: "number" },
              close: { type: "number" },
              volume: { type: "number" },
            },
            required: ["time", "open", "high", "low", "close"],
          },
        },
        title: { type: "string", description: "Optional chart title." },
      },
      required: ["mode"],
    },
  },
];

const RUN_CODE_TOOL = {
  type: "function",
  name: CODE_FN,
  description:
    "Execute bash or python code in a per-conversation sandbox workspace and get stdout/stderr back. Use it to compute, test code, or process data. Files you create in the working directory are shown to the user. State persists within the conversation.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["bash", "python"] },
      code: { type: "string", description: "The code to execute." },
    },
    required: ["language", "code"],
  },
};

const USE_SKILL_TOOL = {
  type: "function",
  name: SKILL_FN,
  description:
    "Load the full step-by-step playbook for a named skill before doing the matching task. Call this FIRST when the request matches an available skill (see the SKILLS section of your instructions).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill name to load." },
    },
    required: ["name"],
  },
};

const CLONE_REPO_TOOL = {
  type: "function",
  name: CLONE_FN,
  description:
    "Shallow-clone a GitHub (or any git) repository into the conversation sandbox and get back its top-level file tree, so you can then explore the real files with run_code (ripgrep/grep). Use when the user gives a repo URL or asks you to look at a project.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Repo reference: a full git URL, https://github.com/owner/repo, or owner/repo.",
      },
    },
    required: ["url"],
  },
};

const INSTALL_SKILL_TOOL = {
  type: "function",
  name: INSTALL_FN,
  description:
    "Install one or more skills from a git repository into the skill library so they become available. Accepts a repo (owner/repo or git URL) or a GitHub folder URL (.../tree/<branch>/<path>). Use when the user asks to add/install a skill (e.g. an Anthropic skill from github.com/anthropics/skills). After installing, call use_skill to load it.",
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          "owner/repo, a git URL, or a GitHub tree URL pointing at a skill folder.",
      },
    },
    required: ["source"],
  },
};

/**
 * Tools sent to the Responses API. The sandbox-backed tools (run_code, clone_repo,
 * use_skill, install_skill) are only offered when the sandbox is enabled.
 */
function toolset() {
  if (!config.sandbox.enabled) return BASE_TOOLS;
  return [
    ...BASE_TOOLS,
    RUN_CODE_TOOL,
    CLONE_REPO_TOOL,
    USE_SKILL_TOOL,
    INSTALL_SKILL_TOOL,
  ];
}

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
  videos: string[];
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

/** Sentinel that separates the streamed answer from trailing media metadata. */
export const MEDIA_MARKER = "<<<XAI_MEDIA>>>";

/** Inline marker emitted live when a tool is invoked: marker + base64(JSON). */
export const TOOL_MARKER = "<<<XAI_TOOL>>>";

/** Parse an SSE byte stream into decoded event objects. */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
  }
}

interface FnCall {
  call_id: string;
  name: string;
  args: string;
}

/**
 * Streaming variant of the Grok Responses agent. Returns a text byte stream:
 * answer tokens (reasoning wrapped in <think>), then a trailing MEDIA_MARKER +
 * base64(JSON {citations, images, videos}) since headers can't follow a body.
 */
export function streamGrokResponses(
  instructions: string,
  messages: UIMessage[],
  baseCitations: Citation[] = [],
  conversationId = "default",
  contextSummary = "",
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const fullInstructions = contextSummary
    ? `${instructions}\n\n# EARLIER CONVERSATION (compacted summary — treat as established context you already know)\n${contextSummary}`
    : instructions;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enq = (s: string) => controller.enqueue(enc.encode(s));
      const emitTool = (tool: string, args: Record<string, unknown> = {}) => {
        const b64 = Buffer.from(
          JSON.stringify({ tool, args }),
          "utf-8",
        ).toString("base64");
        enq(`\n${TOOL_MARKER}${b64}\n`);
      };
      const seenServer = new Set<string>();
      const emitServerTool = (name: string) => {
        if (seenServer.has(name)) return;
        seenServer.add(name);
        emitTool(name);
      };
      const images: string[] = [];
      const videos: string[] = [];
      const files: SandboxFileMeta[] = [];
      const artifacts: ArtifactMeta[] = [];
      let citations: Citation[] = [...baseCitations];
      let thinkOpen = false;
      let contentStarted = false;

      // Stable cache key per conversation so xAI reuses the cached prompt prefix
      // (system prompt + history) across turns — cheaper and lower latency.
      const cacheKey = `conv:${conversationId}`;

      let body: Record<string, unknown> = {
        model: config.grok.model,
        instructions: fullInstructions,
        input: toInput(messages),
        tools: toolset(),
        stream: true,
        prompt_cache_key: cacheKey,
      };

      let answered = false;
      try {
        for (let round = 0; round < config.grok.maxRounds; round++) {
          const res = await fetch(`${config.grok.baseURL}/responses`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.grok.apiKey}`,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => "");
            throw new Error(`xAI responses ${res.status}: ${detail.slice(0, 200)}`);
          }

          const fns: Record<string, FnCall> = {};
          let respId: string | undefined;

          for await (const ev of sseEvents(res.body)) {
            const type = ev.type as string;
            if (type === "response.output_text.delta") {
              if (thinkOpen && !contentStarted) enq("</think>\n\n");
              contentStarted = true;
              enq((ev.delta as string) ?? "");
            } else if (
              type === "response.reasoning_text.delta" ||
              type === "response.reasoning_summary_text.delta"
            ) {
              if (!thinkOpen) {
                enq("<think>");
                thinkOpen = true;
              }
              enq((ev.delta as string) ?? "");
            } else if (type === "response.output_item.added") {
              const item = ev.item as
                | { id?: string; type?: string; call_id?: string; name?: string }
                | undefined;
              if (item?.type === "function_call" && item.id) {
                fns[item.id] = {
                  call_id: item.call_id ?? "",
                  name: item.name ?? "",
                  args: "",
                };
              } else if (item?.type === "web_search_call") {
                emitServerTool("web_search");
              } else if (item?.type === "x_search_call") {
                emitServerTool("x_search");
              }
            } else if (type === "response.function_call_arguments.delta") {
              const id = ev.item_id as string;
              if (fns[id]) fns[id].args += (ev.delta as string) ?? "";
            } else if (type === "response.completed") {
              const r = ev.response as
                | {
                    id?: string;
                    citations?: unknown[];
                    output?: { type?: string }[];
                    usage?: { num_server_side_tools_used?: number };
                  }
                | undefined;
              respId = r?.id;
              if (Array.isArray(r?.citations)) {
                citations = [
                  ...citations,
                  ...mapGrokCitations(r.citations, citations.length),
                ];
              }
              // Server-side search trace: prefer specific call items, else fall
              // back to the usage counter (the reliable signal xAI provides).
              for (const it of r?.output ?? []) {
                if (it?.type === "web_search_call") emitServerTool("web_search");
                else if (it?.type === "x_search_call")
                  emitServerTool("x_search");
              }
              if (
                (r?.usage?.num_server_side_tools_used ?? 0) > 0 &&
                !seenServer.has("web_search") &&
                !seenServer.has("x_search")
              ) {
                emitServerTool("search");
              }
            }
          }

          const calls = Object.values(fns);
          if (calls.length === 0) {
            answered = true;
            break;
          }

          const outputs: unknown[] = [];
          for (const c of calls) {
            let args: {
              prompt?: string;
              language?: string;
              code?: string;
              name?: string;
              url?: string;
              source?: string;
              type?: string;
              spec?: string;
              mode?: string;
              symbol?: string;
              widget?: string;
              interval?: string;
              candles?: unknown[];
              title?: string;
            } = {};
            try {
              args = JSON.parse(c.args || "{}");
            } catch {
              /* ignore */
            }
            let out: string;
            if (c.name === IMAGE_FN) {
              emitTool("generate_image", { prompt: args.prompt ?? "" });
              try {
                const src = await generateImage(args.prompt ?? "");
                images.push(src);
                const n = images.length;
                // Also persist a copy into the conversation sandbox so it shows up
                // in the file explorer / is usable by run_code.
                // Persist a copy into the sandbox (for the explorer / run_code),
                // but DON'T add it to the message file list — it's already shown
                // inline via [[image:N]], so a file chip would duplicate it.
                const saved = await saveMediaToSandbox(
                  conversationId,
                  src,
                  `image_${n}`,
                  "jpg",
                );
                out = `Image #${n} generated. Place it inline by writing the marker [[image:${n}]] at the exact point in your reply where it should appear (omit it to append at the end).${
                  saved ? ` Saved to the sandbox as ${saved.name}.` : ""
                }`;
              } catch (err) {
                out = `generate_image failed: ${
                  err instanceof Error ? err.message : "error"
                }`;
              }
            } else if (c.name === VIDEO_FN) {
              emitTool("generate_video", { prompt: args.prompt ?? "" });
              try {
                const src = await generateVideo(args.prompt ?? "");
                videos.push(src);
                const n = videos.length;
                const saved = await saveMediaToSandbox(
                  conversationId,
                  src,
                  `video_${n}`,
                  "mp4",
                );
                out = `Video #${n} generated. Place it inline by writing the marker [[video:${n}]] where it should appear in your reply (omit it to append at the end).${
                  saved ? ` Saved to the sandbox as ${saved.name}.` : ""
                }`;
              } catch (err) {
                out = `generate_video failed: ${
                  err instanceof Error ? err.message : "error"
                }`;
              }
            } else if (c.name === CODE_FN) {
              const lang = args.language === "bash" ? "bash" : "python";
              emitTool("run_code", { language: lang, code: args.code ?? "" });
              const r = await runCode(conversationId, lang, args.code ?? "");
              for (const f of r.files) {
                if (!files.some((x) => x.name === f.name)) files.push(f);
              }
              out = r.error
                ? `error: ${r.error}`
                : [
                    `exit_code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`,
                    r.stdout ? `stdout:\n${r.stdout}` : "stdout: (empty)",
                    r.stderr ? `stderr:\n${r.stderr}` : "",
                    r.files.length
                      ? `files: ${r.files
                          .map((f) => f.name)
                          .join(
                            ", ",
                          )}. You MUST present each deliverable to the user by writing the marker [[file:EXACT_NAME]] on its own line in your reply (use the exact filename). Don't just say it's done — emit the marker so the file is shown/downloadable.`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n");
            } else if (c.name === SKILL_FN) {
              emitTool("use_skill", { name: args.name ?? "" });
              const skill = getSkill(args.name ?? "");
              if (skill) {
                const mounted = mountSkill(conversationId, skill.name);
                out =
                  `Skill "${skill.name}" loaded. Follow this playbook:\n\n${skill.body}` +
                  (mounted
                    ? `\n\n---\nThis skill's bundled files (scripts/resources) are in your sandbox at "${mounted}/". Run them with run_code, e.g. \`cd ${mounted} && python scripts/<script>.py ...\`. The skill may need Python packages — pip install them in run_code first (e.g. python-docx, pdfplumber/pypdf, python-pptx, openpyxl).\n\nDELIVER THE RESULT: the moment you have produced the output file (e.g. report.pdf, data.xlsx), you MUST present it to the user by writing the marker [[file:EXACT_FILENAME]] on its own line in your reply. Do NOT end the turn just saying "done" — always emit the [[file:...]] marker so the file is actually shown/downloadable.`
                    : "");
              } else {
                out = `Unknown skill: ${args.name ?? ""}`;
              }
            } else if (c.name === ARTIFACT_FN) {
              const t =
                args.type === "chart"
                  ? "chart"
                  : args.type === "html"
                    ? "html"
                    : "mermaid";
              const spec = args.spec ?? "";
              emitTool("create_artifact", { type: t });
              const v =
                t === "mermaid"
                  ? await validateMermaid(spec)
                  : t === "chart"
                    ? await validateChart(spec)
                    : validateHtml(spec);
              if (!v.ok) {
                out = `Artifact invalid (${t}): ${v.error}. Fix the ${t} and call ${ARTIFACT_FN} again.`;
              } else {
                artifacts.push({ type: t, spec });
                const n = artifacts.length;
                out = `Artifact #${n} (${t}) compiled OK. Place it by writing the marker [[artifact:${n}]] on its own line where it should appear in your reply.`;
              }
            } else if (c.name === TRADINGVIEW_FN) {
              emitTool("embed_tradingview", {
                mode: args.mode ?? "",
                symbol: args.symbol ?? "",
              });
              const spec = JSON.stringify({
                mode: args.mode === "data" ? "data" : "widget",
                symbol: args.symbol,
                widget: args.widget,
                interval: args.interval,
                candles: args.candles,
                title: args.title,
              });
              const v = validateTradingView(spec);
              if (!v.ok) {
                out = `embed_tradingview invalid: ${v.error}. Fix and call ${TRADINGVIEW_FN} again.`;
              } else {
                artifacts.push({ type: "tradingview", spec });
                const n = artifacts.length;
                out = `Chart #${n} ready. Place it by writing the marker [[artifact:${n}]] on its own line where it should appear in your reply.`;
              }
            } else if (c.name === INSTALL_FN) {
              emitTool("install_skill", { source: args.source ?? "" });
              const r = await installSkill(args.source ?? "");
              out = r.installed.length
                ? `Installed skill(s): ${r.installed.join(", ")}. Call use_skill with one of these names to load it.`
                : `install_skill failed: ${r.error ?? "no skills found"}`;
            } else if (c.name === CLONE_FN) {
              emitTool("clone_repo", { url: args.url ?? "" });
              const r = await cloneRepo(conversationId, args.url ?? "");
              out = r.ok
                ? `Cloned into "${r.dir}/". Top-level tree:\n${r.tree}\n\nNow explore it with run_code (cd ${r.dir} && rg ...). Do NOT read every file.`
                : `clone_repo failed: ${r.error ?? "error"}`;
            } else {
              out = `Unknown tool: ${c.name}`;
            }
            outputs.push({
              type: "function_call_output",
              call_id: c.call_id,
              output: out,
            });
          }

          body = {
            model: config.grok.model,
            tools: toolset(),
            input: outputs,
            previous_response_id: respId,
            stream: true,
            prompt_cache_key: cacheKey,
          };
        }

        // Hit the round cap while still calling tools → force one final answer
        // (no tools) so the turn never ends with empty output.
        if (!answered && !contentStarted) {
          body.tool_choice = "none";
          try {
            const res = await fetch(`${config.grok.baseURL}/responses`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.grok.apiKey}`,
              },
              body: JSON.stringify(body),
            });
            if (res.ok && res.body) {
              for await (const ev of sseEvents(res.body)) {
                const t = ev.type as string;
                if (t === "response.output_text.delta") {
                  if (thinkOpen && !contentStarted) enq("</think>\n\n");
                  contentStarted = true;
                  enq((ev.delta as string) ?? "");
                } else if (
                  t === "response.reasoning_text.delta" ||
                  t === "response.reasoning_summary_text.delta"
                ) {
                  if (!thinkOpen) {
                    enq("<think>");
                    thinkOpen = true;
                  }
                  enq((ev.delta as string) ?? "");
                } else if (t === "response.completed") {
                  const r = ev.response as { citations?: unknown[] } | undefined;
                  if (Array.isArray(r?.citations))
                    citations = [
                      ...citations,
                      ...mapGrokCitations(r.citations, citations.length),
                    ];
                }
              }
            }
          } catch {
            /* leave whatever we have */
          }
        }
        if (
          !contentStarted &&
          !images.length &&
          !videos.length &&
          !artifacts.length
        ) {
          enq("（未取得回覆，請再試一次或換個說法）");
        }

        if (thinkOpen && !contentStarted) enq("</think>\n\n");

        if (
          citations.length ||
          images.length ||
          videos.length ||
          files.length ||
          artifacts.length
        ) {
          const meta = Buffer.from(
            JSON.stringify({ citations, images, videos, files, artifacts }),
            "utf-8",
          ).toString("base64");
          enq(`\n${MEDIA_MARKER}${meta}`);
        }
      } catch (err) {
        enq(`\n\n[stream error: ${err instanceof Error ? err.message : "?"}]`);
      } finally {
        controller.close();
      }
    },
  });
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
  const videos: string[] = [];

  let resp = await postResponses({
    model: config.grok.model,
    instructions,
    input: toInput(messages),
    tools: toolset(),
  });

  for (let round = 0; round < config.grok.maxRounds; round++) {
    const output = resp.output ?? [];
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;

    const toolOutputs: unknown[] = [];
    for (const call of calls) {
      let out = "";
      let prompt = "";
      try {
        prompt = JSON.parse(call.arguments || "{}").prompt ?? "";
      } catch {
        /* ignore */
      }

      if (call.name === IMAGE_FN) {
        try {
          images.push(await generateImage(prompt));
          out = "Image generated and shown to the user. Briefly confirm it.";
        } catch (err) {
          out = `generate_image failed: ${
            err instanceof Error ? err.message : "error"
          }`;
        }
      } else if (call.name === VIDEO_FN) {
        try {
          videos.push(await generateVideo(prompt));
          out = "Video generated and shown to the user. Briefly confirm it.";
        } catch (err) {
          out = `generate_video failed: ${
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
      tools: toolset(),
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
    videos,
  };
}

const MERMAID_FIX_INSTRUCTIONS = `You repair Mermaid diagram code that fails to parse. Output ONLY a corrected, valid Mermaid diagram — no markdown code fences, no explanation, nothing but the diagram. Preserve the diagram type, every node id, every edge, and the visible label text. Apply the fixes needed to make it parse:
- Wrap EVERY node label in double quotes, e.g. A["text"], B(["text"]), C{"text"} — especially labels containing ( ) [ ] / : ; , • or <br/> or CJK.
- Inside a quoted label, keep <br/> but replace any inner double-quote with a single quote.
- Quote subgraph titles too: subgraph X["Title"].
- Balance brackets and fix obvious syntax slips.
Do NOT add or remove nodes/edges or change the structure.`;

/** Ask the model to repair invalid Mermaid; returns cleaned diagram code. */
export async function fixMermaid(code: string): Promise<string> {
  const resp = await postResponses({
    model: config.grok.model,
    instructions: MERMAID_FIX_INSTRUCTIONS,
    input: [{ role: "user", content: `Fix this Mermaid diagram:\n\n${code}` }],
    temperature: 0,
  });
  return extractText(resp.output ?? [])
    .replace(/^\s*```(?:mermaid)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

const COMPACTION_INSTRUCTIONS = `You are compacting a conversation so it fits the model's context window. Write a concise but COMPLETE summary that lets the assistant continue seamlessly.

ABSOLUTE FAITHFULNESS — this is critical:
- Summarize ONLY what is explicitly present in the messages above.
- Do NOT invent, infer, guess, or add ANY detail that was not actually stated — no extra places, people, dates, numbers, decisions, or preferences. Fabricating content corrupts the conversation.
- If something is unknown or wasn't discussed, omit it; never fill gaps with plausible-sounding guesses.

Capture exactly what was said: the user's goals and requests; decisions, preferences, and constraints they stated; concrete specifics needed to continue (names, file names, sandbox files, IDs, URLs, numbers, code identifiers); what has actually been done; the current state; and any open tasks/next steps that were raised. Output plain prose (short bullet lists are fine). Reply in the conversation's main language.`;

/**
 * Summarize older messages into a rolling compaction summary (text only — images
 * are dropped). `priorSummary` extends an existing summary instead of restarting.
 */
export async function summarizeForCompaction(
  messages: UIMessage[],
  priorSummary?: string,
): Promise<string> {
  // Feed the transcript as ONE text block to summarize (NOT as user/assistant
  // turns) — otherwise weaker models "continue the conversation" and invent
  // content instead of faithfully summarizing it.
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "ASSISTANT" : "USER"}: ${m.content}`)
    .join("\n\n");
  const content =
    (priorSummary
      ? `PREVIOUS SUMMARY (extend it, keep its facts):\n${priorSummary}\n\n`
      : "") +
    `TRANSCRIPT TO SUMMARIZE (this is past conversation text — summarize it, do NOT reply to it or continue it):\n<<<\n${transcript}\n>>>\n\nNow output ONLY the faithful summary, per the system instructions.`;

  const resp = await postResponses({
    model: config.grok.summaryModel, // stronger model for faithful summarization
    instructions: COMPACTION_INSTRUCTIONS,
    input: [{ role: "user", content }],
    temperature: 0, // faithful summarization, not creative
  });
  return extractText(resp.output ?? []);
}

