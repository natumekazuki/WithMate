import type { AuxiliarySession } from "./auxiliary-session-state.js";
import { buildAuxiliaryDraftSaveRequest } from "./auxiliary-session-state.js";

export function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function hasSameAuxiliaryDraftSaveContext(
  current: AuxiliarySession,
  request: AuxiliarySession,
  options: { compareStatus?: boolean } = {},
): boolean {
  return current.id === request.id
    && current.runState === request.runState
    && (!options.compareStatus || current.status === request.status)
    && current.messages.length === request.messages.length
    && current.composerDraft === request.composerDraft
    && current.provider === request.provider
    && current.model === request.model
    && current.reasoningEffort === request.reasoningEffort
    && current.approvalMode === request.approvalMode
    && current.codexSandboxMode === request.codexSandboxMode
    && current.customAgentName === request.customAgentName
    && current.threadId === request.threadId
    && current.catalogRevision === request.catalogRevision
    && areStringArraysEqual(current.allowedAdditionalDirectories, request.allowedAdditionalDirectories);
}

export function resolveAuxiliaryDraftSaveResult(
  current: AuxiliarySession | null,
  request: AuxiliarySession,
  saved: AuxiliarySession,
  options: { compareStatus?: boolean } = {},
): AuxiliarySession | null {
  if (!current || !hasSameAuxiliaryDraftSaveContext(current, request, options)) {
    return current;
  }

  return saved;
}

export type AuxiliaryDraftSaveOperationResult = {
  request: AuxiliarySession;
  saved: AuxiliarySession;
} | null;

export async function runAuxiliaryDraftSaveOperation(input: {
  currentSession: AuxiliarySession | null;
  targetSessionId: string;
  draft: string;
  updatedAt: string;
  saveAuxiliarySession: (request: AuxiliarySession) => Promise<AuxiliarySession>;
}): Promise<AuxiliaryDraftSaveOperationResult> {
  const request = buildAuxiliaryDraftSaveRequest({
    currentSession: input.currentSession,
    targetSessionId: input.targetSessionId,
    draft: input.draft,
    updatedAt: input.updatedAt,
  });
  if (!request) {
    return null;
  }

  const saved = await input.saveAuxiliarySession(request);
  return { request, saved };
}
