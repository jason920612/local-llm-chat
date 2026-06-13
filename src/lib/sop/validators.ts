/**
 * Deterministic, code-only validators. No model trust — these run in plain
 * TypeScript over the model's output to enforce SOP rules.
 */

export interface ValidationResult {
  /** Output after deterministic cleaning (e.g. stripped fake citations). */
  text: string;
  /** Human-readable rule violations detected. */
  violations: string[];
}

// Disclaimer / flattery boilerplate the SOP forbids. Stripped deterministically.
const BOILERPLATE_PATTERNS: RegExp[] = [
  /\bas an ai language model,?\s*/gi,
  /\bas an ai,?\s*/gi,
  /\bas a large language model,?\s*/gi,
  /^\s*(great|excellent|good)\s+question[!.]?\s*/i,
];

export function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of BOILERPLATE_PATTERNS) out = out.replace(re, "");
  return out.trimStart();
}

/**
 * Enforce citation integrity for RAG answers.
 * - Any [n] referencing a source outside 1..allowedCount is a fabricated source:
 *   it is stripped and recorded as a violation.
 * - If grounding is required (allowedCount > 0) and the answer makes claims but
 *   carries no valid citation (and is not the explicit refusal), that is flagged.
 */
export function enforceCitations(
  text: string,
  allowedCount: number,
  refusalMarker: string,
): ValidationResult {
  const violations: string[] = [];
  const refused = text.trim().startsWith(refusalMarker.trim().slice(0, 12));

  // Any [n] outside 1..allowedCount is fabricated and removed. When there are
  // no sources at all (allowedCount = 0), every [n] is fabricated.
  const citationRe = /\[(\d+)\]/g;
  const valid = new Set<number>();
  let cleaned = text.replace(citationRe, (match, numStr) => {
    const n = Number(numStr);
    if (n >= 1 && n <= allowedCount) {
      valid.add(n);
      return match;
    }
    violations.push(`fabricated source citation [${n}] removed`);
    return "";
  });
  // Tidy spacing left by removed markers (e.g. "energy [1]." -> "energy.").
  cleaned = cleaned
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");

  if (allowedCount > 0 && !refused && valid.size === 0) {
    violations.push("answer makes claims with no valid citation");
  }

  return { text: cleaned, violations };
}

/** Detect an empty or whitespace-only model response. */
export function isEmptyResponse(text: string): boolean {
  return text.trim().length === 0;
}
