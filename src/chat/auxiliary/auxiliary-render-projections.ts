import { useMemo } from "react";

import {
  buildMainAuxiliaryRuntimeSession,
  type AuxiliaryRuntimeProjectionInput,
} from "./auxiliary-runtime-projection.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";

/** 補助会話の表示に使う項目を取り出し、未指定のキャラクター情報を空の値にそろえる。 */
function toAuxiliaryRuntimeProjectionInput(
  session: AuxiliarySession,
): AuxiliaryRuntimeProjectionInput {
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
    withMateReviewerExplicit: session.withMateReviewerExplicit,
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

// 下書きを保存すると composerDraft と updatedAt は変わるが、表示する実行時の内容は変わらない。
// 内容に関わるフィールドが変わると入力を再構築して最新の時刻を取り込み、下書きだけの保存では既存の入力を再利用する。
/** 表示に必要な項目が変わるまで、前回組み立てた補助会話の投影入力を再利用する。 */
function useRuntimeProjectionSession(
  activeSession: AuxiliarySession | null,
): AuxiliaryRuntimeProjectionInput | null {
  return useMemo(
    () =>
      activeSession ? toAuxiliaryRuntimeProjectionInput(activeSession) : null,
    [
      activeSession?.approvalMode,
      activeSession?.codexSandboxMode,
      activeSession?.codexSpeed,
      activeSession?.codexReviewer,
      activeSession?.withMateReviewerExplicit,
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

/** 親と補助会話がそろえば会話表示用に合成し、補助会話がなければ親をそのまま返す。 */
export function useMainAuxiliaryRuntimeSession(
  parentSession: Session | null,
  activeSession: AuxiliarySession | null,
): Session | null {
  const runtimeSession = useRuntimeProjectionSession(activeSession);
  return useMemo(
    () =>
      parentSession && runtimeSession
        ? buildMainAuxiliaryRuntimeSession(parentSession, runtimeSession)
        : parentSession,
    [parentSession, runtimeSession],
  );
}
