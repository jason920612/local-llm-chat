import type OpenAI from "openai";
import { llm } from "../llm";
import { config } from "../config";
import { callStructured } from "./structured";
import { VerifyResult, verifyJsonSchema } from "./schemas";
import {
  enforceCitations,
  isEmptyResponse,
  stripBoilerplate,
} from "./validators";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const RAG_REFUSAL = "The provided documents do not contain this information.";
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

function buildScoldCorrection(violations: string[]): string {
  const list = violations.map((v) => `- ${v}`).join("\n");
  return `${SCOLD_LINES.join(" ")}

Your previous answer FAILED these mandatory checks:
${list}

Rewrite it so EVERY failure is fixed. Cite each factual claim with [n] using only the provided sources. If you cannot support a claim with a source, remove it.

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

interface MonitorOptions {
  /** Number of valid sources available (RAG/Grok). 0 = no sources. */
  allowedSources: number;
  /** Require at least one valid citation (true when sources exist). */
  requireCitations: boolean;
}

export interface MonitorResult {
  text: string;
  /** Neutral, user-safe note about what monitoring corrected (no scolding). */
  controlNote: string | null;
}

async function generate(
  messages: ChatParam[],
  temperature: number,
): Promise<string> {
  const res = await llm.chat.completions.create({
    model: config.llm.model,
    messages,
    temperature,
  });
  return stripBoilerplate(res.choices[0]?.message?.content ?? "");
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

async function audit(
  userMessages: ChatParam[],
  draft: string,
): Promise<string[]> {
  const lastUser = [...userMessages].reverse().find((m) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : "[multimodal message]";
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
  let draft =
    initialDraft != null
      ? stripBoilerplate(initialDraft)
      : await generate(messages, 0.4);

  for (let round = 0; round <= config.sop.maxCorrections; round++) {
    const det = inspect(draft, opts);
    draft = det.text;
    // Deterministic checks are the hard gate (reliable). The LLM self-audit is
    // opt-in (SOP_VERIFY_GATE) — a small model auditing itself is too noisy to
    // drive mandatory rewrites, but useful with a stronger model.
    const violations = [
      ...det.violations,
      ...(config.sop.verifyGate ? await audit(messages, draft) : []),
    ];

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
          controlNote:
            "Control check: refused — could not produce a properly cited answer after correction.",
        };
      }
      break;
    }

    // Harsh internal correction — never shown to the user.
    correctionRounds++;
    draft = await generate(
      [
        ...messages,
        { role: "assistant", content: draft },
        { role: "user", content: buildScoldCorrection(violations) },
      ],
      0.2,
    );
    draft = stripBoilerplate(draft);
  }

  // Final guarantee: strip any leaked reprimand and re-clean citations.
  draft = sanitize(draft);
  draft = enforceCitations(draft, opts.allowedSources, RAG_REFUSAL).text;
  if (isEmptyResponse(draft)) draft = "I don't know.";

  const controlNote =
    correctionRounds > 0
      ? `Control check: answer auto-corrected (${correctionRounds} round${
          correctionRounds > 1 ? "s" : ""
        }) to meet sourcing and accuracy rules.`
      : null;

  return { text: draft, controlNote };
}
