import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import {
  ComposerControllerRegistry,
  type ComposerOwner,
} from "../composer-controller.js";

/** 編集要求の開始・保存・中止の待機と、編集可否を区別する段階。 */
type EditPhase =
  "beginning" | "editing" | "saving" | "canceling" | "unavailable";
/** 予約入力を編集中の受付、段階、エラー、必要に応じて元の Main フレームを保持する。 */
export type QueuedTurnEdit = {
  receipt: SessionTurnQueueReceipt;
  phase: EditPhase;
  error: string;
  mainFrameId?: string;
};
/** 通常の下書きと混ざらないよう、予約編集専用の Composer 所有者を作る。 */
export const queuedTurnEditOwner = (sessionId: string): ComposerOwner => ({
  kind: "queue-edit",
  id: sessionId,
});
/** 開始・保存・中止の処理中は、重ねて編集操作を受け付けない。 */
export const isQueuedTurnEditBusy = (edit: QueuedTurnEdit) =>
  edit.phase === "beginning" ||
  edit.phase === "saving" ||
  edit.phase === "canceling";

/** 予約行が参照するセッション別の編集状態と、編集開始の入口。 */
type QueueEditContextValue = {
  edits: Readonly<Record<string, QueuedTurnEdit>>;
  /** 指定した受付を通常の下書きと分けて編集し始める。 */
  begin(receipt: SessionTurnQueueReceipt): void;
};
/** 予約行に編集操作を供給する。編集が提供されない表示では null。 */
export const QueuedTurnEditContext =
  createContext<QueueEditContextValue | null>(null);
/** 現在の予約行に編集操作が供給されていれば取得する。 */
export const useQueuedTurnEditContext = () => useContext(QueuedTurnEditContext);

/** 一つのセッションにつき一件の予約編集を扱い、確定できない保存や中止では編集した下書きを保つ。 */
export function useQueuedTurnEdit(
  api: WithMateWindowApi | null,
  registry: ComposerControllerRegistry,
) {
  const [edits, setEdits] = useState<Record<string, QueuedTurnEdit>>({});
  const current = useRef(edits);
  const put = useCallback((sessionId: string, edit: QueuedTurnEdit | null) => {
    const next = { ...current.current };
    if (edit) next[sessionId] = edit;
    else delete next[sessionId];
    current.current = next;
    setEdits(next);
  }, []);
  const begin = useCallback(
    async (receipt: SessionTurnQueueReceipt, mainFrameId?: string) => {
      if (!api || registry.isFrozen || current.current[receipt.sessionId])
        return;
      const owner = queuedTurnEditOwner(receipt.sessionId);
      registry.replaceDraft(owner, receipt.captured.request.userMessage, {
        start: receipt.captured.request.userMessage.length,
        end: receipt.captured.request.userMessage.length,
      });
      const pending: QueuedTurnEdit = {
        receipt,
        phase: "beginning",
        error: "",
        mainFrameId,
      };
      put(receipt.sessionId, pending);
      try {
        const accepted = await api.beginQueuedSessionTurnEdit(
          receipt.sessionId,
          { incarnationId: receipt.incarnationId, id: receipt.id },
        );
        if (current.current[receipt.sessionId] !== pending) return;
        registry.replaceDraft(owner, accepted.captured.request.userMessage, {
          start: accepted.captured.request.userMessage.length,
          end: accepted.captured.request.userMessage.length,
        });
        put(receipt.sessionId, {
          ...pending,
          receipt: accepted,
          phase: "editing",
        });
      } catch (error) {
        if (current.current[receipt.sessionId] === pending)
          put(receipt.sessionId, {
            ...pending,
            phase: "unavailable",
            error: `Editing could not be started. Cancel Edit to return to your draft. ${error instanceof Error ? error.message : String(error)}`,
          });
      }
    },
    [api, registry, put],
  );
  const finish = useCallback(
    async (sessionId: string, submit: boolean) => {
      const edit = current.current[sessionId];
      if (
        !api ||
        !edit ||
        registry.isFrozen ||
        isQueuedTurnEditBusy(edit) ||
        (submit && edit.phase !== "editing")
      )
        return;
      const owner = queuedTurnEditOwner(sessionId);
      const text = registry.get(owner).draft;
      if (submit && (!text.trim() || registry.get(owner).preview.errors.length))
        return;
      const pending: QueuedTurnEdit = {
        ...edit,
        phase: submit ? "saving" : "canceling",
        error: "",
      };
      put(sessionId, pending);
      try {
        const request = {
          incarnationId: edit.receipt.incarnationId,
          id: edit.receipt.id,
        };
        if (submit)
          await api.updateQueuedSessionTurn(sessionId, {
            ...request,
            userMessage: text,
          });
        else await api.cancelQueuedSessionTurnEdit(sessionId, request);
        if (current.current[sessionId] !== pending) return;
        registry.discardOwner(owner);
        put(sessionId, null);
        return true;
      } catch (error) {
        if (current.current[sessionId] === pending)
          put(sessionId, {
            ...edit,
            error: `${submit ? "The update could not be confirmed. Your edit is preserved. Check the queue before trying again." : "The end of editing could not be confirmed. Your edit is preserved."} ${error instanceof Error ? error.message : String(error)}`,
          });
      }
    },
    [api, registry, put],
  );
  return {
    edits,
    begin,
    /** 更新元が編集可能な段階か、開始失敗後に下書きを保持している段階かを判定する。 */
    canChangeDraft: (sessionId: string) =>
      current.current[sessionId]?.phase === "editing" ||
      current.current[sessionId]?.phase === "unavailable",
    /** 予約入力の下書きを検証し、保存が確定した場合にだけ編集を終了する。 */
    submit: (sessionId: string) => finish(sessionId, true),
    /** 中止が確定した場合にだけ予約編集用の下書きを破棄する。 */
    cancel: (sessionId: string) => finish(sessionId, false),
  };
}
