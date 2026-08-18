import type { RunSessionTurnRequest } from "../src/runtime-state.js";
import type { SessionScheduleTurn } from "../src/session-schedule.js";
import { extractComposerAttachmentReferenceCandidates } from "../src/path-reference.js";
import {
  buildComposerReferenceInsertionState,
  normalizePathForReference,
} from "../src/session-composer-paths.js";

export function buildScheduledTurnRequest(
  turn: SessionScheduleTurn,
  clientRequestId: string,
): RunSessionTurnRequest {
  const existingPaths = new Set(
    extractComposerAttachmentReferenceCandidates(turn.userMessage)
      .map((attachment) => normalizePathForReference(attachment.path.trim())),
  );
  const missingReferences = (turn.attachments ?? [])
    .filter((attachment) => !existingPaths.has(normalizePathForReference(attachment.path.trim())))
    .map((attachment) => ({
      path: attachment.path,
      presentation: attachment.source === "markdown-image" ? "image" as const : "path" as const,
    }));
  const userMessage = buildComposerReferenceInsertionState(
    turn.userMessage,
    turn.userMessage.length,
    missingReferences,
  )?.draft ?? turn.userMessage;
  return {
    userMessage,
    clientRequestId,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    approvalMode: turn.approvalMode,
    ...(turn.provider === "codex"
      ? { codexSandboxMode: turn.codexSandboxMode }
      : { customAgentName: turn.customAgentName }),
  };
}
