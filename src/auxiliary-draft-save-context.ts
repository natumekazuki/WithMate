import type { AuxiliarySession } from "./auxiliary-session-state.js";
import {
  applyAuxiliarySessionComposerDraftPatch,
  buildAuxiliaryDraftSaveRequest,
} from "./auxiliary-session-state.js";

type UpdateActiveAuxiliarySession = (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
) => Promise<void>;

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

export function resolveAuxiliaryDraftSaveOperationResult(
  current: AuxiliarySession | null,
  result: AuxiliaryDraftSaveOperationResult,
  options: { compareStatus?: boolean } = {},
): AuxiliarySession | null {
  if (!result) {
    return current;
  }

  return resolveAuxiliaryDraftSaveResult(current, result.request, result.saved, options);
}

export function applyScheduledAuxiliaryDraftSaveUiState(input: {
  scheduled: {
    nextSession: AuxiliarySession;
    saveOperation: Promise<AuxiliaryDraftSaveOperationResult>;
    draftSaveQueue: Promise<void>;
  };
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  draftSaveQueueRef: { current: Promise<void> };
  setActiveSession: (session: AuxiliarySession) => void;
}): Promise<AuxiliaryDraftSaveOperationResult> {
  input.mutationRevision.current += 1;
  input.activeSessionRef.current = input.scheduled.nextSession;
  input.setActiveSession(input.scheduled.nextSession);
  input.draftSaveQueueRef.current = input.scheduled.draftSaveQueue;
  return input.scheduled.saveOperation;
}

export function resolveAppliedAuxiliaryDraftSaveResult(input: {
  current: AuxiliarySession | null;
  result: AuxiliaryDraftSaveOperationResult;
  activeSessionRef: { current: AuxiliarySession | null };
  compareStatus?: boolean;
}): AuxiliarySession | null {
  const nextSession = resolveAuxiliaryDraftSaveOperationResult(input.current, input.result, {
    compareStatus: input.compareStatus,
  });
  if (input.result && nextSession === input.result.saved) {
    input.activeSessionRef.current = input.result.saved;
  }
  return nextSession;
}

export async function runAuxiliaryDraftPatchOperation(input: {
  draft: string;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionComposerDraftPatch(current, input.draft, input.createTimestampLabel())
  ));
}

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

export function scheduleAuxiliaryDraftSaveOperation(input: {
  currentSession: AuxiliarySession;
  draft: string;
  createTimestampLabel: () => string;
  draftSaveQueue: Promise<void>;
  getCurrentSession: () => AuxiliarySession | null;
  saveAuxiliarySession: (request: AuxiliarySession) => Promise<AuxiliarySession>;
}): {
  nextSession: AuxiliarySession;
  saveOperation: Promise<AuxiliaryDraftSaveOperationResult>;
  draftSaveQueue: Promise<void>;
} {
  const nextSession = applyAuxiliarySessionComposerDraftPatch(
    input.currentSession,
    input.draft,
    input.createTimestampLabel(),
  );
  const saveOperation = input.draftSaveQueue
    .catch(() => undefined)
    .then(() => (
      runAuxiliaryDraftSaveOperation({
        currentSession: input.getCurrentSession(),
        targetSessionId: nextSession.id,
        draft: input.draft,
        updatedAt: input.createTimestampLabel(),
        saveAuxiliarySession: input.saveAuxiliarySession,
      })
    ));

  return {
    nextSession,
    saveOperation,
    draftSaveQueue: saveOperation.then(() => undefined, () => undefined),
  };
}
