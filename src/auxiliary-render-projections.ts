import { useMemo } from "react";

import {
  buildCompanionAuxiliaryRuntimeSession,
  buildMainAuxiliaryRuntimeSession,
  type AuxiliaryRuntimeProjectionInput,
} from "./auxiliary-runtime-projection.js";
import type { MessageListAuxiliarySession } from "./auxiliary-session-message-projection.js";
import type { AuxiliarySession } from "./auxiliary-session-state.js";
import type { CompanionSession } from "./companion-state.js";
import type { Session } from "./session-state.js";

function toMessageListAuxiliarySession(session: AuxiliarySession): MessageListAuxiliarySession {
  return {
    id: session.id,
    messages: session.messages,
    displayAfterMessageIndex: session.displayAfterMessageIndex,
    createdAt: session.createdAt,
  };
}

export function useMessageListAuxiliarySessions(
  closedSessions: AuxiliarySession[],
  activeSession: AuxiliarySession | null,
): MessageListAuxiliarySession[] {
  const closedProjection = useMemo(
    () => closedSessions.map(toMessageListAuxiliarySession),
    [closedSessions],
  );
  const activeProjection = useMemo(
    () => activeSession ? toMessageListAuxiliarySession(activeSession) : null,
    [
      activeSession?.createdAt,
      activeSession?.displayAfterMessageIndex,
      activeSession?.id,
      activeSession?.messages,
    ],
  );

  return useMemo(
    () => activeProjection ? [...closedProjection, activeProjection] : closedProjection,
    [activeProjection, closedProjection],
  );
}

function toAuxiliaryRuntimeProjectionInput(session: AuxiliarySession): AuxiliaryRuntimeProjectionInput {
  return {
    id: session.id,
    runState: session.runState,
    title: session.title,
    provider: session.provider,
    catalogRevision: session.catalogRevision,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    customAgentName: session.customAgentName,
    allowedAdditionalDirectories: session.allowedAdditionalDirectories,
    threadId: session.threadId,
    messages: session.messages,
    updatedAt: session.updatedAt,
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
      activeSession?.allowedAdditionalDirectories,
      activeSession?.approvalMode,
      activeSession?.catalogRevision,
      activeSession?.codexSandboxMode,
      activeSession?.customAgentName,
      activeSession?.id,
      activeSession?.messages,
      activeSession?.model,
      activeSession?.provider,
      activeSession?.reasoningEffort,
      activeSession?.runState,
      activeSession?.threadId,
      activeSession?.title,
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

export function useCompanionAuxiliaryRuntimeSession(
  parentSession: CompanionSession | null,
  activeSession: AuxiliarySession | null,
): CompanionSession | null {
  const runtimeSession = useRuntimeProjectionSession(activeSession);
  return useMemo(
    () => parentSession && runtimeSession
      ? buildCompanionAuxiliaryRuntimeSession(parentSession, runtimeSession)
      : parentSession,
    [parentSession, runtimeSession],
  );
}
