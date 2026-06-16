import { z } from "zod";

/**
 * Structured-output contracts for the code-controlled SOP gates.
 * Each has BOTH a JSON Schema (sent to the model via response_format) and a zod
 * schema (used in code to validate what comes back). The model is never trusted;
 * code validates and retries.
 */

// --- Intent gate -----------------------------------------------------------
export const intentJsonSchema = {
  type: "object",
  properties: {
    restatement: {
      type: "string",
      description: "One-sentence restatement of what the user is asking.",
    },
    ambiguous: {
      type: "boolean",
      description:
        "True ONLY if a competent assistant genuinely could not proceed without more information. Casual messages and greetings are NOT ambiguous.",
    },
    clarifyingQuestion: {
      type: ["string", "null"],
      description:
        "If ambiguous is true, the single most important question to ask. Otherwise null.",
    },
  },
  required: ["restatement", "ambiguous", "clarifyingQuestion"],
  additionalProperties: false,
} as const;

export const IntentResult = z.object({
  restatement: z.string(),
  ambiguous: z.boolean(),
  clarifyingQuestion: z.string().nullable(),
});
export type IntentResult = z.infer<typeof IntentResult>;

// --- Verify gate -----------------------------------------------------------
export const verifyJsonSchema = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description: "True only if the draft satisfies EVERY checklist item.",
    },
    violations: {
      type: "array",
      items: { type: "string" },
      description: "Concrete checklist items the draft failed. Empty if passed.",
    },
  },
  required: ["passed", "violations"],
  additionalProperties: false,
} as const;

export const VerifyResult = z.object({
  passed: z.boolean(),
  violations: z.array(z.string()),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

// --- Stance / artificial-balance gate -------------------------------------
export const stanceJsonSchema = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description:
        "True if the draft's uncertainty, caveats, and opposing views match the real ambiguity of the user's request.",
    },
    issueType: {
      type: ["string", "null"],
      enum: [
        "artificial_balance",
        "false_equivalence",
        "vague_caveat",
        "unsupported_uncertainty",
        "unnecessary_tradeoff",
        "ignores_user_direction",
        null,
      ],
      description: "Main issue if passed is false; otherwise null.",
    },
    severity: {
      type: "string",
      enum: ["none", "low", "medium", "high"],
      description:
        "Only medium/high should block emission and trigger correction.",
    },
    reason: {
      type: "string",
      description:
        "Short explanation. Must be specific to the user's request and draft.",
    },
    offendingText: {
      type: "array",
      items: { type: "string" },
      description:
        "Exact short snippets from the draft that caused the issue. Empty if passed.",
    },
    rewriteInstruction: {
      type: ["string", "null"],
      description:
        "Targeted instruction for rewriting the answer if failed; otherwise null.",
    },
  },
  required: [
    "passed",
    "issueType",
    "severity",
    "reason",
    "offendingText",
    "rewriteInstruction",
  ],
  additionalProperties: false,
} as const;

export const StanceResult = z.object({
  passed: z.boolean(),
  issueType: z
    .enum([
      "artificial_balance",
      "false_equivalence",
      "vague_caveat",
      "unsupported_uncertainty",
      "unnecessary_tradeoff",
      "ignores_user_direction",
    ])
    .nullable(),
  severity: z.enum(["none", "low", "medium", "high"]),
  reason: z.string(),
  offendingText: z.array(z.string()),
  rewriteInstruction: z.string().nullable(),
});
export type StanceResult = z.infer<typeof StanceResult>;
