import { z } from "zod";

import { createMemoryRuntimeError } from "./withmate-memory-runtime-client.js";

export const memoryInputErrorSchema = z.object({
  schemaVersion: z.literal("withmate-memory-v1"),
  error: z.object({
    code: z.literal("WITHMATE_MEMORY_INVALID_INPUT"),
    message: z.string(),
    retryable: z.literal(false),
    conversationMayContinue: z.literal(true),
    effect: z.literal("none"),
    details: z.object({ tool: z.string(), issues: z.array(z.record(z.string(), z.unknown())) }).strict(),
  }).strict(),
}).strict();

function publicIssue(issue: z.core.$ZodIssue, parentPath: PropertyKey[] = []): Record<string, unknown> {
  const path = [...parentPath, ...issue.path];
  // Select schema diagnostics explicitly; never serialize input, custom params or the Error itself.
  const result: Record<string, unknown> = {
    code: issue.code,
    path: path.filter((part) => typeof part === "string" || typeof part === "number"),
    message: issue.message,
  };
  switch (issue.code) {
    case "invalid_type":
      result.expected = issue.expected;
      break;
    case "too_small":
    case "too_big": {
      const bound = issue.code === "too_small" ? issue.minimum : issue.maximum;
      result[issue.code === "too_small" ? "minimum" : "maximum"] = typeof bound === "bigint" ? String(bound) : bound;
      result.origin = issue.origin;
      if (issue.inclusive !== undefined) result.inclusive = issue.inclusive;
      if (issue.exact !== undefined) result.exact = issue.exact;
      break;
    }
    case "invalid_value":
      result.values = issue.values.map((value) => typeof value === "bigint" ? String(value) : value);
      break;
    case "unrecognized_keys":
      result.keys = issue.keys;
      break;
    case "invalid_format":
      result.format = issue.format;
      if (issue.pattern !== undefined) result.pattern = issue.pattern;
      break;
    case "not_multiple_of":
      result.divisor = issue.divisor;
      break;
    case "invalid_union":
      result.message = issue.discriminator !== undefined
        ? "Discriminator must match one of the options."
        : "Input must satisfy one of the alternatives.";
      result.alternatives = issue.errors.map((issues) => ({ issues: issues.map((child) => publicIssue(child, path)) }));
      if (issue.discriminator !== undefined) result.discriminator = issue.discriminator;
      if ("options" in issue) result.options = issue.options;
      break;
    case "invalid_key":
    case "invalid_element":
      result.issues = issue.issues.map((child) => publicIssue(child, path));
      break;
  }
  return result;
}

/** Public schemas use schema-defined messages, not messages interpolated from input values. */
export function createMemoryInputValidationError(tool: string, error: z.ZodError) {
  return createMemoryRuntimeError(
    "WITHMATE_MEMORY_INVALID_INPUT",
    `Invalid arguments for tool ${tool}. See error.details.issues.`,
    {
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
      details: { tool, issues: error.issues.map((issue) => publicIssue(issue)) },
    },
  );
}
