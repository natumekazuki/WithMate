import type { Session } from "../../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";

/** 親会話に重ねる補助会話固有の識別情報・実行設定・履歴・キャラクター情報。 */
export type AuxiliaryRuntimeProjectionInput = Pick<
  AuxiliarySession,
  | "id"
  | "runState"
  | "title"
  | "provider"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "codexSpeed"
  | "codexReviewer"
  | "withMateReviewerExplicit"
  | "customAgentName"
  | "threadId"
  | "messages"
  | "messageCount"
  | "createdAt"
  | "updatedAt"
  | "characterId"
  | "characterRuntimeSnapshot"
  | "characterRuntimeSnapshotInvalid"
>;
/** 親の作業文脈を引き継いだ表示用セッションを、補助会話の識別情報・履歴で組み立てる。無効なキャラクタースナップショットは例外とする。 */
export function buildMainAuxiliaryRuntimeSession(
  parent: Session,
  auxiliary: AuxiliaryRuntimeProjectionInput,
): Session {
  if (auxiliary.characterRuntimeSnapshotInvalid)
    throw new Error("Auxiliary character runtime snapshot is invalid.");
  const snapshot = auxiliary.characterRuntimeSnapshot;
  const projection: Session &
    Pick<AuxiliaryRuntimeProjectionInput, "characterRuntimeSnapshotInvalid"> = {
    ...parent,
    id: auxiliary.id,
    incarnationId: auxiliary.createdAt,
    taskTitle: parent.taskTitle,
    status: auxiliary.runState === "running" ? "running" : "idle",
    updatedAt: auxiliary.updatedAt,
    provider: auxiliary.provider,
    runState: auxiliary.runState,
    approvalMode: auxiliary.approvalMode,
    codexSandboxMode: auxiliary.codexSandboxMode,
    codexSpeed: auxiliary.codexSpeed,
    codexReviewer: auxiliary.codexReviewer,
    withMateReviewerExplicit: auxiliary.withMateReviewerExplicit,
    model: auxiliary.model,
    reasoningEffort: auxiliary.reasoningEffort,
    customAgentName: auxiliary.customAgentName,
    allowedAdditionalDirectories: parent.allowedAdditionalDirectories,
    threadId: auxiliary.threadId,
    messages: auxiliary.messages,
    messageCount: auxiliary.messageCount,
    latestUserMessage: undefined,
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
