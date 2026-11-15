import { useMemo } from "react";

import {
  buildMainAuxiliaryRuntimeSession,
  type AuxiliaryRuntimeProjectionInput,
} from "./auxiliary-runtime-projection.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";

function toAuxiliaryRuntimeProjectionInput(session: AuxiliarySession): AuxiliaryRuntimeProjectionInput {
  return {
    id: session.id,
    createdAt: session.createdAt,
    runState: session.runState,
    title: session.title,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    codexSpeed: session.codexSpeed,
    codexReviewer: session.codexReviewer,
    customAgentName: session.customAgentName,
    threadId: session.threadId,
    messages: session.messages,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    characterId: session.characterId ?? "",
    characterRuntimeSnapshot: session.characterRuntimeSnapshot ?? null,
    characterRuntimeSnapshotInvalid: session.characterRuntimeSnapshotInvalid,
  };
}

// Draft persistence changes composerDraft and updatedAt without changing rendered runtime content.
// Relevant content fields rebuild this input and capture the latest timestamp; draft-only saves reuse it.
function useRuntimeProjectionSession(
  activeSession: AuxiliarySession | null,
): AuxiliaryRuntimeProjectionInput | null {
  return useMemo(
    () => activeSession ? toAuxiliaryRuntimeProjectionInput(activeSession) : null,
    [
      activeSession?.approvalMode,
      activeSession?.codexSandboxMode,
      activeSession?.codexSpeed,
      activeSession?.codexReviewer,
      activeSession?.customAgentName,
      activeSession?.id,
      activeSession?.createdAt,
      activeSession?.messages,
      activeSession?.messageCount,
      activeSession?.model,
      activeSession?.provider,
      activeSession?.reasoningEffort,
      activeSession?.runState,
      activeSession?.threadId,
      activeSession?.title,
      activeSession?.characterId,
      activeSession?.characterRuntimeSnapshot,
      activeSession?.characterRuntimeSnapshotInvalid,
    ],
  );
}

export function useMainAuxiliaryRuntimeSession(
  parentSession: Session | null,
  activeSession: AuxiliarySession | null,
): Session | null {
  const runtimeSession = useRuntimeProjectionSession(activeSession);
  return useMemo(
    () => parentSession && runtimeSession
      ? buildMainAuxiliaryRuntimeSession(parentSession, runtimeSession)
      : parentSession,
    [parentSession, runtimeSession],
  );
}
