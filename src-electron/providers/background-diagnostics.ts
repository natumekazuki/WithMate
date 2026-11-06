import type { BackgroundFailure, BackgroundFailureStage } from "./background-failure.js";
import { createProviderAgentRuntimeBindingRedactor } from "./provider-agent-runtime-binding.js";

export type BackgroundOperationObservation = Readonly<{
  requestId: string | number; operation: string; toolName?: string;
  transport: string; boundary: BackgroundFailureStage | "mcp";
  phase: "request" | "response"; timestamp: string;
  outcome?: "success" | "failure"; failure?: BackgroundFailure; result?: unknown;
}>;

/** Error text is retained, but transport credentials never cross the diagnostic boundary. */
export function redactBackgroundText(text: string, secrets: readonly string[] = []): string {
  const result = createProviderAgentRuntimeBindingRedactor(null, secrets).sanitizeText(text);
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, "$1 [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential|authorization)[\w-]*["']?\s*[:=]\s*["']?)(?:\[(?:REDACTED|WITHMATE_BINDING_REFERENCE_REDACTED)\]|[^\s,"'&<>}\]]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

const diagnosticKeys = new Set(["name", "code", "message", "reason", "stack", "cause", "errors", "issues", "path", "expected", "received", "minimum", "maximum", "inclusive", "origin", "format", "validation", "details", "field", "candidateIndex", "failedCandidateIndex", "backgroundRegistration", "bindingFailure", "failureStage", "expectedVersion", "actualVersion", "retryable", "effect", "conversationMayContinue"]);

/** Select causes and validation expectations, never provider partialResult or raw input. */
export function backgroundErrorDiagnostic(value: unknown, secrets: readonly string[] = [], seen = new Set<object>()): unknown {
  if (typeof value === "string") return redactBackgroundText(value, secrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => backgroundErrorDiagnostic(item, secrets, seen));
  const selected: Record<string, unknown> = {};
  for (const key of diagnosticKeys) {
    if (key in value) selected[key] = backgroundErrorDiagnostic((value as Record<string, unknown>)[key], secrets, seen);
  }
  return selected;
}

const resultKeys = new Set(["ok", "status", "index", "result", "id", "entryId", "objectId", "bytesWritten", "files", "memoryEntryId", "eventId", "episodeId", "characterId", "sessionId", "scope", "owner", "project", "character", "target", "targetId", "targetType", "type", "kind", "effect", "version", "saved", "accepted", "rejected", "results", "items", "events", "episode", "entry", "memory", "appraisal", "duplicate", "replayed", "created", "updated", "count", "savedCount", "candidateIndex", "error", "details"]);

/** Registration receipts identify effects without retaining memory bodies or history messages. */
export function backgroundOperationResult(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(backgroundOperationResult);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => resultKeys.has(key)).map(([key, item]) => [key, backgroundOperationResult(item)]));
}
