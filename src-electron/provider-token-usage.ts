import type { AuditLogUsage } from "../src/app-state.js";

export type CodexTokenUsageLike = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
};

export type CopilotTokenUsageLike = {
  inputTokens?: unknown;
  cacheReadTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningOutputTokens?: unknown;
  totalTokens?: unknown;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTokenUsage(input: {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningOutputTokens?: unknown;
  totalTokens?: unknown;
}): AuditLogUsage | null {
  const inputTokens = finiteNumber(input.inputTokens);
  const cachedInputTokens = finiteNumber(input.cachedInputTokens);
  const outputTokens = finiteNumber(input.outputTokens);

  if (inputTokens === null && cachedInputTokens === null && outputTokens === null) {
    return null;
  }

  const normalized: AuditLogUsage = {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };

  const reasoningOutputTokens = finiteNumber(input.reasoningOutputTokens);
  if (reasoningOutputTokens !== null) {
    normalized.reasoningOutputTokens = reasoningOutputTokens;
  }

  const totalTokens = finiteNumber(input.totalTokens);
  normalized.totalTokens = totalTokens ?? normalized.inputTokens + normalized.outputTokens;

  return normalized;
}

export function normalizeCodexTokenUsage(usage: CodexTokenUsageLike | null | undefined): AuditLogUsage | null {
  if (!usage) {
    return null;
  }

  return normalizeTokenUsage({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  });
}

export function normalizeCopilotTokenUsage(usage: CopilotTokenUsageLike | null | undefined): AuditLogUsage | null {
  if (!usage) {
    return null;
  }

  return normalizeTokenUsage({
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  });
}
