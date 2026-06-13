import type OpenAI from "openai";
import type { ZodType } from "zod";
import { llm } from "../llm";
import { config } from "../config";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Call the model and force a JSON-schema-constrained response, then validate it
 * in code with a zod schema. Retries on malformed/invalid output up to the
 * configured limit. Returns null if every attempt fails — callers decide whether
 * to fail open (skip the gate) or fail closed (refuse).
 *
 * This is the core of "control by code, not by prompt": the structure is imposed
 * by response_format and verified by zod, not assumed from instructions.
 */
export async function callStructured<T>(args: {
  messages: ChatParam[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validate: ZodType<T>;
  temperature?: number;
  retries?: number;
}): Promise<T | null> {
  const retries = args.retries ?? config.sop.maxStructuredRetries;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await llm.chat.completions.create({
        model: config.llm.model,
        messages: args.messages,
        temperature: args.temperature ?? 0,
        // LM Studio honors JSON-schema structured output; if a given model
        // ignores it, the zod validation below catches it and we retry.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: args.schemaName,
            schema: args.jsonSchema,
            strict: true,
          },
        },
      });

      const content = res.choices[0]?.message?.content ?? "";
      const parsed = args.validate.safeParse(JSON.parse(content));
      if (parsed.success) return parsed.data;
    } catch {
      // network / JSON / schema error — fall through to retry
    }
  }

  return null;
}
