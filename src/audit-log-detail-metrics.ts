import type { AuditLogDetailFragment } from "./runtime-state.js";

export type AuditLogDetailMetrics = {
  hasFragment: boolean;
  sections: string[];
  logicalPromptChars: number;
  logicalSystemChars: number;
  logicalInputChars: number;
  logicalComposedChars: number;
  transportFieldCount: number;
  transportFieldChars: number;
  assistantTextChars: number;
  operationCount: number;
  operationDetailsChars: number;
  operationDetailsMaxChars: number;
  rawItemsJsonChars: number;
};

export function summarizeAuditLogDetailFragment(
  fragment: AuditLogDetailFragment | null,
): AuditLogDetailMetrics {
  if (!fragment) {
    return {
      hasFragment: false,
      sections: [],
      logicalPromptChars: 0,
      logicalSystemChars: 0,
      logicalInputChars: 0,
      logicalComposedChars: 0,
      transportFieldCount: 0,
      transportFieldChars: 0,
      assistantTextChars: 0,
      operationCount: 0,
      operationDetailsChars: 0,
      operationDetailsMaxChars: 0,
      rawItemsJsonChars: 0,
    };
  }

  const transportFields = fragment.transportPayload?.fields ?? [];
  const operations = fragment.operations ?? [];
  const operationDetailLengths = operations.map((operation) => operation.details?.length ?? 0);

  return {
    hasFragment: true,
    sections: [
      fragment.logicalPrompt ? "logical" : null,
      fragment.transportPayload ? "transport" : null,
      typeof fragment.assistantText === "string" ? "response" : null,
      fragment.operations ? "operations" : null,
      typeof fragment.rawItemsJson === "string" ? "raw" : null,
    ].filter((section): section is string => section !== null),
    logicalPromptChars:
      (fragment.logicalPrompt?.systemText.length ?? 0)
      + (fragment.logicalPrompt?.inputText.length ?? 0)
      + (fragment.logicalPrompt?.composedText.length ?? 0),
    logicalSystemChars: fragment.logicalPrompt?.systemText.length ?? 0,
    logicalInputChars: fragment.logicalPrompt?.inputText.length ?? 0,
    logicalComposedChars: fragment.logicalPrompt?.composedText.length ?? 0,
    transportFieldCount: transportFields.length,
    transportFieldChars: transportFields.reduce((total, field) => total + field.value.length, 0),
    assistantTextChars: fragment.assistantText?.length ?? 0,
    operationCount: operations.length,
    operationDetailsChars: operationDetailLengths.reduce((total, length) => total + length, 0),
    operationDetailsMaxChars: Math.max(0, ...operationDetailLengths),
    rawItemsJsonChars: fragment.rawItemsJson?.length ?? 0,
  };
}
