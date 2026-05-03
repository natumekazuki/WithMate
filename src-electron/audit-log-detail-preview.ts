import type { AuditLogicalPrompt } from "../src/app-state.js";

export const AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_HEAD_CHARS = 10000;
export const AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_TAIL_CHARS = 10000;
export const AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS =
  AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_HEAD_CHARS + AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_TAIL_CHARS;

export function previewAuditLogDetailText(value: string, maxLength = AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.floor(maxLength / 2);
  const tailLength = maxLength - headLength;
  return [
    value.slice(0, headLength),
    "",
    `... truncated ${value.length - maxLength} chars ...`,
    "",
    value.slice(-tailLength),
  ].join("\n");
}

export function previewAuditLogicalPrompt(prompt: AuditLogicalPrompt): AuditLogicalPrompt {
  return {
    systemText: previewAuditLogDetailText(prompt.systemText),
    inputText: previewAuditLogDetailText(prompt.inputText),
    composedText: previewAuditLogDetailText(prompt.composedText),
  };
}
