import type { AuxiliarySession } from "./auxiliary-session-state.js";

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
