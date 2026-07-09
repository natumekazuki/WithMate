import type { AuditLogicalPrompt } from "../src/app-state.js";

export type PromptTokenEstimate = {
  charCount: number;
  estimatedTokens: number;
};

export type LogicalPromptTokenEstimate = {
  system: PromptTokenEstimate;
  input: PromptTokenEstimate;
  composed: PromptTokenEstimate;
};

export function estimatePromptTokens(text: string): PromptTokenEstimate {
  const charCount = text.length;
  return {
    charCount,
    estimatedTokens: charCount === 0 ? 0 : Math.ceil(charCount / 4),
  };
}

export function estimateLogicalPromptTokens(logicalPrompt: AuditLogicalPrompt): LogicalPromptTokenEstimate {
  return {
    system: estimatePromptTokens(logicalPrompt.systemText),
    input: estimatePromptTokens(logicalPrompt.inputText),
    composed: estimatePromptTokens(logicalPrompt.composedText),
  };
}
