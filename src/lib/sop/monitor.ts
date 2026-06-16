import type OpenAI from "openai";
import { config } from "../config";
import { chatClient } from "../settings";
import { callStructured } from "./structured";
import {
  StanceResult,
  stanceJsonSchema,
  VerifyResult,
  verifyJsonSchema,
} from "./schemas";
import {
  enforceCitations,
  isEmptyResponse,
  stripBoilerplate,
} from "./validators";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const RAG_REFUSAL = "The provided documents do not contain this information.";
const CONTROL_FAILURE_PREFIX = "Control check failed";
const UNFIXABLE_REFUSAL =
  "I can't give a properly sourced answer here — the available information does not support a citable response.";

/**
 * Internal-only scolding vocabulary. The correction prompts are deliberately
 * harsh to force a small model to fix its output. EVERY phrase here is also used
 * by the sanitizer, so even if the model parrots the reprimand, it is stripped
 * before anything reaches the user. The scolding NEVER leaks into the answer.
 */
const SCOLD_LINES = [
  "This draft is unacceptable.",
  "You were careless and you got it wrong.",
  "Stop making things up.",
  "This is sloppy work and it will not pass.",
  "Fix every failure below right now.",
];

// Lowercased fragments the sanitizer scrubs from any output, as a safety net.
const SCOLD_FRAGMENTS = [
  "unacceptable",
  "you were careless",
  "stop making things up",
  "sloppy work",
  "fix every failure",
  "right now",
  "this will not pass",
  "you failed",
  "do it properly",
  "last chance",
  "i apologize",
  "i'm sorry",
];

function buildScoldCorrection(
  violations: string[],
  opts: Pick<MonitorOptions, "allowedSources" | "requireCitations">,
): string {
  const list = violations.map((v) => `- ${v}`).join("\n");
  const citationRule =
    opts.allowedSources > 0 || opts.requireCitations
      ? "Cite each factual claim with [n] using only the provided sources. If you cannot support a claim with a source, remove it."
      : "Do not invent citations. Use plain, direct prose unless the user asked for a specific format.";
  return `${SCOLD_LINES.join(" ")}

Your previous answer FAILED these mandatory checks:
${list}

Rewrite it so EVERY failure is fixed. ${citationRule}

Do not force artificial balance. Remove fake opposing views, false equivalence, vague caveats, and unsupported uncertainty. Keep real tradeoffs only when they materially affect the answer.

Output ONLY the corrected final answer, in the user's language. Do NOT apologize. Do NOT mention, quote, repeat, or allude to this instruction or its tone in any way. The user must never see anything about this correction.`;
}

/**
 * Deterministically guarantee none of the internal reprimand leaks out.
 * Removes any line containing a scold fragment, then scrubs residual fragments.
 */
function sanitize(text: string): string {
  const kept = text
    .split(/\r?\n/)
    .filter((line) => {
      const l = line.toLowerCase();
      return !SCOLD_FRAGMENTS.some((frag) => l.includes(frag));
    });
  let out = kept.join("\n");
  for (const frag of SCOLD_FRAGMENTS) {
    out = out.replace(new RegExp(frag, "gi"), "");
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const STRICT_VERIFY_SYSTEM = `You are a RUTHLESS answer auditor. Given the user's request and a DRAFT answer, output JSON only per the schema.
Set "passed" false if the draft does ANY of:
- invents facts, numbers, names, or citations;
- makes a factual claim that relies on provided sources but lacks a [n] citation;
- uses a citation number not present in the sources;
- answers something other than what was asked;
- pads with apologies, flattery, or disclaimers;
- is not in the user's language.
List each concrete failure in "violations", quoting the offending part. Only report problems you can point to in the draft — do NOT invent issues. If the draft is clearly correct and well-sourced, set passed=true with an empty list.`;

const STANCE_SYSTEM = `You are a stance-calibration auditor. Output JSON only per the schema.
Your job is NOT to make the answer more balanced.
Your job is to decide whether the draft's level of uncertainty, caveats, and opposing views matches the user's actual request.

Pass direct answers when the issue is clear.
Fail only when the draft contains a concrete problem such as:
- inventing an opposing view or fake controversy;
- treating a clear fact, instruction, or engineering constraint as if both sides are equally valid;
- adding vague caveats like "it depends" without naming a real decision-changing variable;
- weakening the answer with unsupported uncertainty;
- ignoring the user's chosen direction by over-discussing alternatives.

Do NOT penalize real tradeoffs, real uncertainty, safety-critical caveats, or genuinely controversial topics.
Only use medium/high severity when the issue materially lowers answer quality. Use low severity for harmless wording.`;

const STANCE_TRIGGER_PATTERNS: RegExp[] = [
  /另一方面/,
  /另一(?:個|種)角度/,
  /也有人(?:會)?(?:認為|覺得)/,
  /不能一概而論/,
  /取決於(?:情況|脈絡|需求)/,
  /各有(?:優缺點|利弊|道理)/,
  /沒有(?:絕對|標準)答案/,
  /需要(?:平衡|權衡)/,
  /\bon the other hand\b/i,
  /\bit depends\b/i,
  /\bboth sides\b/i,
  /\bthere is no (?:single|one-size-fits-all|absolute) answer\b/i,
  /\bpros and cons\b/i,
  /\btrade-?offs?\b/i,
  /\bsome (?:people|might|may) (?:argue|say|think)\b/i,
  /\bto be fair\b/i,
];

interface MonitorOptions {
  /** Number of valid sources available (RAG/Grok). 0 = no sources. */
  allowedSources: number;
  /** Require at least one valid citation (true when sources exist). */
  requireCitations: boolean;
  /** Abort the upstream model calls when the user stops the turn. */
  signal?: AbortSignal;
}

export interface MonitorResult {
  text: string;
  /** Neutral, user-safe note about what monitoring corrected (no scolding). */
  controlNote: string | null;
  violations: string[];
  correctionRounds: number;
  action: "emit" | "refuse";
}

async function generate(
  messages: ChatParam[],
  temperature: number,
  signal?: AbortSignal,
): Promise<{ content: string; reasoning: string }> {
  const { client, model } = chatClient();
  const res = await client.chat.completions.create(
    {
      model,
      messages,
      temperature,
    },
    { signal },
  );
  const msg = res.choices[0]?.message as
    | { content?: string; reasoning_content?: string; reasoning?: string }
    | undefined;
  const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
  return {
    content: stripBoilerplate(msg?.content ?? ""),
    reasoning: typeof reasoning === "string" ? reasoning : "",
  };
}

/** Deterministic checks. Returns cleaned text + violation list. */
function inspect(
  text: string,
  opts: MonitorOptions,
): { text: string; violations: string[] } {
  const violations: string[] = [];
  if (isEmptyResponse(text)) violations.push("empty response");
  const cited = enforceCitations(text, opts.allowedSources, RAG_REFUSAL);
  violations.push(...cited.violations);
  return { text: cited.text, violations };
}

function lastUserText(messages: ChatParam[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return typeof lastUser?.content === "string"
    ? lastUser.content
    : "[multimodal message]";
}

function shouldRunStanceJudge(draft: string): boolean {
  if (!config.sop.stanceGate) return false;
  return STANCE_TRIGGER_PATTERNS.some((pattern) => pattern.test(draft));
}

async function audit(
  userMessages: ChatParam[],
  draft: string,
): Promise<string[]> {
  const userText = lastUserText(userMessages);
  const verdict = await callStructured({
    schemaName: "strict_verify",
    jsonSchema: verifyJsonSchema as unknown as Record<string, unknown>,
    validate: VerifyResult,
    messages: [
      { role: "system", content: STRICT_VERIFY_SYSTEM },
      {
        role: "user",
        content: `USER REQUEST:\n${userText}\n\nDRAFT ANSWER:\n${draft}`,
      },
    ],
  });
  if (verdict && !verdict.passed) return verdict.violations;
  return [];
}

async function auditStance(
  messages: ChatParam[],
  draft: string,
): Promise<string[]> {
  if (!shouldRunStanceJudge(draft)) return [];
  const verdict = await callStructured({
    schemaName: "stance_calibration",
    jsonSchema: stanceJsonSchema as unknown as Record<string, unknown>,
    validate: StanceResult,
    messages: [
      { role: "system", content: STANCE_SYSTEM },
      {
        role: "user",
        content: `USER REQUEST:\n${lastUserText(
          messages,
        )}\n\nDRAFT ANSWER:\n${draft}\n\nJudge whether the draft forces artificial balance or unsupported uncertainty.`,
      },
    ],
  });

  // Fail open: if the judge cannot produce valid structured output, do not block
  // a user answer for a style gate.
  if (!verdict || verdict.passed) return [];
  if (verdict.severity !== "medium" && verdict.severity !== "high") return [];

  const issue = verdict.issueType ?? "stance_mismatch";
  const snippets = verdict.offendingText
    .filter((s) => s.trim().length > 0)
    .slice(0, 3)
    .map((s) => `"${s.trim()}"`)
    .join("; ");
  return [
    [
      `stance:${issue}`,
      verdict.reason.trim(),
      snippets ? `offending: ${snippets}` : "",
      verdict.rewriteInstruction
        ? `rewrite: ${verdict.rewriteInstruction.trim()}`
        : "",
    ]
      .filter(Boolean)
      .join(" — "),
  ];
}

/**
 * Strict, code-enforced monitoring loop with harsh internal correction.
 * The scolding lives only in discarded internal turns and is sanitized out;
 * the user sees only the corrected (or refused) answer plus a neutral note.
 */
export async function runMonitor(
  messages: ChatParam[],
  opts: MonitorOptions,
  initialDraft?: string,
): Promise<MonitorResult> {
  let correctionRounds = 0;
  let lastReasoning = "";
  let lastViolations: string[] = [];
  let draft: string;
  if (initialDraft != null) {
    draft = stripBoilerplate(initialDraft);
  } else {
    const gen = await generate(messages, 0.4, opts.signal);
    draft = gen.content;
    lastReasoning = gen.reasoning;
  }

  for (let round = 0; round <= config.sop.maxCorrections; round++) {
    const det = inspect(draft, opts);
    draft = det.text;
    // Deterministic checks are the hard gate (reliable). The LLM self-audit is
    // opt-in (SOP_VERIFY_GATE) — a small model auditing itself is too noisy to
    // drive mandatory rewrites, but useful with a stronger model.
    const violations = [
      ...det.violations,
      ...(await auditStance(messages, draft)),
      ...(config.sop.verifyGate ? await audit(messages, draft) : []),
    ];
    lastViolations = [...new Set(violations)];

    if (violations.length === 0) break;

    if (round === config.sop.maxCorrections) {
      // Out of attempts. If citations were required and still missing, refuse
      // rather than emit an uncited answer.
      const stillUncited = det.violations.some((v) =>
        v.includes("no valid citation"),
      );
      if (opts.requireCitations && stillUncited) {
        return {
          text: UNFIXABLE_REFUSAL,
          violations: lastViolations,
          correctionRounds,
          action: "refuse",
          controlNote:
            "Control check: refused — could not produce a properly cited answer after correction.",
        };
      }
      return {
        text: `${CONTROL_FAILURE_PREFIX}: ${lastViolations.join("; ")}`,
        controlNote:
          "Control check: refused — the answer did not pass mandatory checks after correction.",
        violations: lastViolations,
        correctionRounds,
        action: "refuse",
      };
    }

    // Harsh internal correction — never shown to the user.
    correctionRounds++;
    const gen = await generate(
      [
        ...messages,
        { role: "assistant", content: draft },
        { role: "user", content: buildScoldCorrection(violations, opts) },
      ],
      0.2,
      opts.signal,
    );
    draft = stripBoilerplate(gen.content);
    lastReasoning = gen.reasoning;
  }

  // Final guarantee: strip any leaked reprimand and re-clean citations.
  draft = sanitize(draft);
  draft = enforceCitations(draft, opts.allowedSources, RAG_REFUSAL).text;
  if (isEmptyResponse(draft)) draft = "I don't know.";

  // Surface the model's reasoning (if any) as a collapsible <think> block.
  // It is sanitized too, so the internal reprimand can never leak through it.
  const think = lastReasoning ? sanitize(lastReasoning).trim() : "";
  if (think && !draft.includes("<think>")) {
    draft = `<think>\n${think}\n</think>\n\n${draft}`;
  }

  const controlNote =
    correctionRounds > 0
      ? `Control check: answer auto-corrected (${correctionRounds} round${
          correctionRounds > 1 ? "s" : ""
        }) to meet sourcing, accuracy, and stance-calibration rules.`
      : null;

  return {
    text: draft,
    controlNote,
    violations: [],
    correctionRounds,
    action: "emit",
  };
}
