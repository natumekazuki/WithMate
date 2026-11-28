import { useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { AuxiliaryDraftPersistence } from "../auxiliary/use-auxiliary-draft-persistence.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
} from "../composer-controller.js";
import {
  createSessionTurnClientRequestId,
  type SessionSubmitCoordinator,
} from "./session-submit-coordinator.js";
import { resolveSessionRunErrorMessage } from "./session-live-run-state.js";

/** 新しいターンの送信と枠を共有しながら、実行中ターンへの追加入力とその待機・失敗表示を管理する。 */
export function useSessionTurnInput(input: {
  api: Pick<
    WithMateWindowApi,
    "previewComposerInput" | "steerSessionTurn" | "steerAuxiliarySessionTurn"
  > | null;
  composerRegistry: ComposerControllerRegistry;
  drafts: AuxiliaryDraftPersistence;
  submitCoordinator: SessionSubmitCoordinator;
}) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<
    Record<string, { revision: number; message: string }>
  >({});

  /** 入力時点の下書きと対象ターンを検証し、同じターンへの受付を確認したら下書きを処理する。 */
  const send = async (target: {
    owner: ComposerOwner;
    auxiliarySession: AuxiliarySession | null;
    replyTo?: import("../../../src-shared/session/session-reply.js").SessionReply;
    /** 対象ターンでの受付を確認した後に呼び出す。 */
    onAccepted?(): void;
    turnId: string | null;
    canSendInput: boolean;
    blockedReason: string;
    isReadOnly: boolean;
    /** 事前確認の結果を反映して、同じ対象ターンへの入力を続けられるかを返す。 */
    isCurrent(): boolean;
    /** 非同期処理の完了後も下書きとエラーの対象が同じ所有者かを返す。 */
    isCurrentOwner(): boolean;
    /** 処理中に実行詳細を保持し、完了時に使う解除関数を返す。 */
    retainDetail(): () => void;
    /** 入力前の検査で問題を検出したときに、入力欄へフィードバックを出す。 */
    onBlocked(): void;
  }) => {
    const { api, composerRegistry: registry } = input;
    const { owner, turnId } = target;
    if (
      !api ||
      !target.canSendInput ||
      !turnId ||
      registry.isFrozen ||
      target.blockedReason ||
      target.isReadOnly
    )
      return;
    if (owner.kind === "auxiliary" && !target.auxiliarySession) return;
    const captured = registry.capture(owner);
    const current = registry.get(owner);
    if (
      !captured.draft.trim() ||
      current.isImeComposing ||
      current.saveState === "error" ||
      current.preview.errors.length > 0
    ) {
      target.onBlocked();
      return;
    }
    // React が無効状態を反映する前に、送信と直接の Steer が実行される場合がある。
    // どちらも同じコンポーザーのリビジョンを送るため、所有者ごとの同期的な使用権を共有する。
    const lease = input.submitCoordinator.tryAcquire(owner.id);
    if (!lease) return;
    setPendingIds((previous) => new Set(previous).add(owner.id));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[owner.id];
      return next;
    });
    const releaseDetail = target.retainDetail();
    /** 下書きの保存・プレビュー・送信から、受付に応じた下書きの更新と枠の解放までを行う。 */
    const operation = async () => {
      let submission: Awaited<
        ReturnType<AuxiliaryDraftPersistence["prepareSubmission"]>
      > = null;
      try {
        if (target.auxiliarySession) {
          submission = await input.drafts.prepareSubmission(
            target.auxiliarySession,
            captured,
            "input",
          );
          if (!submission) return;
        }
        const preview = await api.previewComposerInput(
          owner.id,
          captured.draft,
        );
        if (
          registry.isFrozen ||
          !target.isCurrent() ||
          registry.capture(owner).revision !== captured.revision
        )
          return;
        registry.setPreview(owner, preview);
        if (preview.errors.length > 0) {
          target.onBlocked();
          return;
        }
        const request = {
          expectedTurnId: turnId,
          userMessage: captured.draft,
          ...(target.replyTo ? { replyTo: target.replyTo } : {}),
          clientRequestId: createSessionTurnClientRequestId(),
          ...(submission
            ? {
                auxiliaryDraftIncarnation: submission.durable.incarnation,
                auxiliaryDraftDurableRevision:
                  submission.durable.durableRevision,
              }
            : {}),
        };
        const result = submission
          ? await submission.consume(() =>
              api.steerAuxiliarySessionTurn(owner.id, request),
            )
          : await api.steerSessionTurn(owner.id, request);
        if (result.turnId !== turnId)
          throw new Error("Input acceptance could not be confirmed.");
        target.onAccepted?.();
        if (!target.isCurrentOwner()) return;
        if (submission) submission.clear();
        else registry.clearIfRevision(owner, captured.revision);
        await submission?.reload().catch(() => undefined);
      } catch (error) {
        await submission?.reload().catch(() => undefined);
        if (!target.isCurrentOwner()) return;
        setErrors((previous) => ({
          ...previous,
          [owner.id]: {
            revision: captured.revision,
            message: `Input to ${owner.kind === "auxiliary" ? "Auxiliary" : "Main"} was not confirmed. Your draft is preserved. ${resolveSessionRunErrorMessage(error, "Could not send input.")}`,
          },
        }));
      } finally {
        releaseDetail();
        lease.release();
        setPendingIds((previous) => {
          const next = new Set(previous);
          next.delete(owner.id);
          return next;
        });
      }
    };
    await (owner.kind === "auxiliary"
      ? input.drafts.trackSend(operation())
      : operation());
  };
  return { send, pendingIds, errors };
}
