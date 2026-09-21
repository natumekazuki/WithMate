import type { Session } from "../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../src-shared/auxiliary/auxiliary-session-state.js";

export type AuxiliaryRuntimeProjectionInput = Pick<AuxiliarySession, "id" | "runState" | "title" | "provider" | "catalogRevision" | "model" | "reasoningEffort" | "approvalMode" | "codexSandboxMode" | "codexSpeed" | "codexReviewer" | "customAgentName" | "allowedAdditionalDirectories" | "threadId" | "messages" | "updatedAt" | "characterId" | "characterRuntimeSnapshot" | "characterRuntimeSnapshotInvalid">;
export function buildMainAuxiliaryRuntimeSession(parent: Session, auxiliary: AuxiliaryRuntimeProjectionInput): Session {
  if (auxiliary.characterRuntimeSnapshotInvalid) throw new Error("Auxiliary Character runtime snapshot is invalid.");
  const snapshot = auxiliary.characterRuntimeSnapshot;
  const projection: Session & Pick<AuxiliaryRuntimeProjectionInput, "characterRuntimeSnapshotInvalid"> = {
    ...parent,
    id: auxiliary.id,
    taskTitle: parent.taskTitle,
    status: auxiliary.runState === "running" ? "running" : "idle",
    updatedAt: auxiliary.updatedAt,
    provider: auxiliary.provider,
    catalogRevision: auxiliary.catalogRevision,
    runState: auxiliary.runState,
    approvalMode: auxiliary.approvalMode,
    codexSandboxMode: auxiliary.codexSandboxMode,
    codexSpeed: auxiliary.codexSpeed,
    codexReviewer: auxiliary.codexReviewer,
    model: auxiliary.model,
    reasoningEffort: auxiliary.reasoningEffort,
    customAgentName: auxiliary.customAgentName,
    allowedAdditionalDirectories: auxiliary.allowedAdditionalDirectories,
    threadId: auxiliary.threadId,
    messages: auxiliary.messages,
    characterId: auxiliary.characterId || parent.characterId,
    character: snapshot?.name ?? parent.character,
    characterIconPath: snapshot?.iconFilePath ?? parent.characterIconPath,
    characterThemeColors: snapshot?.theme ?? parent.characterThemeColors,
    characterRuntimeSnapshot: snapshot ?? parent.characterRuntimeSnapshot,
    characterRuntimeSnapshotInvalid: auxiliary.characterRuntimeSnapshotInvalid,
    stream: [],
  };
  return projection;
}
