import { useCallback, useMemo, useRef } from "react";

import type { AuxiliaryDraftRecord } from "../../../src-shared/auxiliary/auxiliary-draft-contract.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { WithMateWindowAuxiliaryApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { currentTimestampLabel } from "../../../src-shared/time-state.js";
import {
  AuxiliaryDraftPersistenceOwner,
  type AuxiliaryDraftPersistenceSaveResult,
} from "../auxiliary-draft-persistence-owner.js";
import {
  ComposerControllerRegistry,
  type ComposerDraftCapture,
  type ComposerOwner,
} from "../composer-controller.js";

/** 送信に使う永続化済みの版と、その版だけを対象とする入力欄の操作。 */
export type AuxiliaryDraftSubmission = {
  durable: AuxiliaryDraftRecord;
  /** 入力欄が送信準備時に捕捉した版と本文のままかを返す。 */
  isCurrent(): boolean;
  /** 捕捉後に再編集されていない場合だけ入力欄を消去する。 */
  clear(): void;
  /** この送信で消去した入力欄を、消去後に再編集されていない場合だけ復元する。 */
  restore(): void;
  /** Turn の起動または入力の受付に応じた方式で下書きの消費処理を呼ぶ。 */
  consume<T>(operation: () => Promise<T>): Promise<T>;
  /** 保存待ちがないときに永続化された下書きを読み直す。 */
  reload(): Promise<AuxiliaryDraftRecord | null>;
};

/** 補助会話ごとの入力欄の編集・保存・送信をつなぐ永続化インターフェース。 */
export type AuxiliaryDraftPersistence = {
  /** API が利用できる場合、会話の下書き保存を直列化する所有者を取得する。 */
  getOwner(session: AuxiliarySession): AuxiliaryDraftPersistenceOwner | null;
  /** 指定された入力版と照合して、保存処理の結果を入力欄へ反映する。 */
  observeSave(
    sessionId: string,
    draftRevision: number,
    operation: Promise<void>,
  ): Promise<void>;
  /** 入力欄の本文とカーソル位置を更新し、新しい本文を保存待ちにする。 */
  changeDraft(
    session: AuxiliarySession,
    value: string,
    selectionStart: number,
  ): Promise<void>;
  /** 保留中の編集、または現時点の入力欄の本文を保存し直す。 */
  retrySave(session: AuxiliarySession): void;
  /** 未完了の送信として処理を追跡し、呼び出し元には元の結果を返す。 */
  trackSend<T>(operation: Promise<T>): Promise<T>;
  /** 呼び出し時点で追跡中の送信が、成否を問わずすべて終了するまで待つ。 */
  waitForPendingSends(): Promise<void>;
  /** 登録済みのすべての補助会話について、待機中の下書き保存を進める。 */
  flushAll(): Promise<void>;
  /** 未保存の編集または実行中の保存がある補助会話の識別子を返す。 */
  pendingSessionIds(): string[];
  /** 捕捉した本文が永続化済みと確認できる場合に、その版に限った送信操作を組み立てる。 */
  prepareSubmission(
    session: AuxiliarySession,
    captured: ComposerDraftCapture,
    kind: "turn" | "input",
  ): Promise<AuxiliaryDraftSubmission | null>;
};

/** マウント中の各補助会話に保存所有者を保持し、入力欄と永続化 API を接続する。 */
export function useAuxiliaryDraftPersistence(input: {
  api: Pick<
    WithMateWindowAuxiliaryApi,
    "getAuxiliarySessionStatus" | "getAuxiliaryDraft" | "saveAuxiliaryDraft"
  > | null;
  composerRegistry: ComposerControllerRegistry;
  /** 本文が変わった会話を、編集時刻で最近の会話の並びに反映する。 */
  touchRecency(id: string, updatedAt: string): void;
  /** 現在の入力欄が編集・保存の再試行を受け付けない状態かを返す。 */
  isFrozen(): boolean;
}): AuxiliaryDraftPersistence {
  const ownersRef = useRef(new Map<string, AuxiliaryDraftPersistenceOwner>());
  const pendingSendsRef = useRef(new Set<Promise<unknown>>());
  const inputRef = useRef(input);
  inputRef.current = input;

  const getOwner = useCallback((session: AuxiliarySession) => {
    const { api } = inputRef.current;
    if (!api) return null;
    const { id: sessionId, parentSessionId } = session;
    let owner = ownersRef.current.get(sessionId);
    if (owner) return owner;
    let fixedIncarnation: string | null = null;
    owner = new AuxiliaryDraftPersistenceOwner({
      /** 状態と下書きの会話識別子を照合し、初回に確認した世代のレコードだけを読み込む。 */
      load: async () => {
        const status = await api.getAuxiliarySessionStatus(sessionId);
        const record = await api.getAuxiliaryDraft(sessionId);
        if (
          !status ||
          !record ||
          record.auxiliarySessionId !== sessionId ||
          status.id !== sessionId ||
          status.parentSessionId !== parentSessionId ||
          !status.incarnation ||
          record.parentSessionId !== status.parentSessionId ||
          record.incarnation !== status.incarnation
        ) {
          return null;
        }
        if (fixedIncarnation && fixedIncarnation !== record.incarnation)
          return null;
        fixedIncarnation = record.incarnation;
        return record;
      },
      now: currentTimestampLabel,
      /** 下書きが属する世代と永続化リビジョンを指定して保存し、受付確認の版を次の保存へ引き継ぐ。 */
      save: async (
        record: AuxiliaryDraftRecord,
      ): Promise<AuxiliaryDraftPersistenceSaveResult> => {
        if (fixedIncarnation && record.incarnation !== fixedIncarnation) {
          return { outcome: "stale" };
        }
        const result = await api.saveAuxiliaryDraft({
          auxiliarySessionId: record.auxiliarySessionId,
          parentSessionId: record.parentSessionId,
          incarnation: record.incarnation,
          expectedDurableRevision: record.durableRevision,
          text: record.text,
          updatedAt: record.updatedAt,
        });
        if (result.outcome !== "saved" || !result.ack) {
          return result.outcome === "saved"
            ? { outcome: "rejected" }
            : { outcome: result.outcome };
        }
        return {
          outcome: "saved",
          record: {
            ...record,
            durableRevision: result.ack.durableRevision,
            updatedAt: result.ack.updatedAt,
          },
        };
      },
    });
    ownersRef.current.set(sessionId, owner);
    return owner;
  }, []);

  const ownerForId = useCallback(
    (sessionId: string): ComposerOwner => ({
      kind: "auxiliary",
      id: sessionId,
    }),
    [],
  );

  const observeSave = useCallback(
    async (
      sessionId: string,
      draftRevision: number,
      operation: Promise<void>,
    ) => {
      const owner = ownerForId(sessionId);
      inputRef.current.composerRegistry.setSaveState(owner, "saving");
      try {
        await operation;
        if (
          inputRef.current.composerRegistry.capture(owner).revision ===
          draftRevision
        ) {
          inputRef.current.composerRegistry.setSaveState(owner, "saved");
        }
      } catch (error) {
        console.error(error);
        if (
          inputRef.current.composerRegistry.capture(owner).revision ===
          draftRevision
        ) {
          inputRef.current.composerRegistry.setSaveState(
            owner,
            "error",
            "Draft could not be saved.",
          );
        }
      }
    },
    [ownerForId],
  );

  const changeDraft = useCallback(
    async (
      session: AuxiliarySession,
      value: string,
      selectionStart: number,
    ) => {
      if (inputRef.current.isFrozen()) return;
      const owner = ownerForId(session.id);
      const previousDraft = inputRef.current.composerRegistry.get(owner).draft;
      inputRef.current.composerRegistry.setDraft(owner, value, {
        start: selectionStart,
        end: selectionStart,
      });
      if (previousDraft !== value)
        inputRef.current.touchRecency(session.id, currentTimestampLabel());
      const draftRevision =
        inputRef.current.composerRegistry.capture(owner).revision;
      const persistenceOwner = getOwner(session);
      if (persistenceOwner)
        await observeSave(
          session.id,
          draftRevision,
          persistenceOwner.enqueue(value),
        );
    },
    [getOwner, observeSave, ownerForId],
  );

  const retrySave = useCallback(
    (session: AuxiliarySession) => {
      if (inputRef.current.isFrozen()) return;
      const persistenceOwner = getOwner(session);
      if (!persistenceOwner) return;
      const owner = ownerForId(session.id);
      const operation = persistenceOwner.hasPending
        ? persistenceOwner.flush()
        : persistenceOwner.enqueue(
            inputRef.current.composerRegistry.get(owner).draft,
          );
      void observeSave(
        session.id,
        inputRef.current.composerRegistry.capture(owner).revision,
        operation,
      );
    },
    [getOwner, observeSave, ownerForId],
  );

  /** 下書きの保存を待って本文を照合する。不成立は Turn では状態表示に反映し、入力受付では例外を呼び出し元へ伝える。 */
  const prepareSubmission = useCallback(
    async (
      session: AuxiliarySession,
      captured: ComposerDraftCapture,
      kind: "turn" | "input",
    ): Promise<AuxiliaryDraftSubmission | null> => {
      const registry = inputRef.current.composerRegistry;
      const owner = ownerForId(session.id);
      const persistence = getOwner(session);
      /** 保存待ちの間に別の編集が入っていないか、捕捉した入力版と本文の両方で照合する。 */
      const isCurrent = () => {
        const latest = registry.capture(owner);
        return (
          latest.revision === captured.revision &&
          latest.draft === captured.draft
        );
      };
      try {
        await persistence?.flush();
        if (kind === "input") await persistence?.reload();
        else await persistence?.ensureLoaded();
        if (registry.isFrozen) return null;
        if (kind === "turn" && !isCurrent()) {
          registry.setSaveState(owner, "saved");
          return null;
        }
        const durable = persistence?.durableRecord;
        if (!persistence || !durable || durable.text !== captured.draft)
          throw new Error("Draft could not be saved.");
        let clearedRevision: number | null = null;
        return {
          durable,
          isCurrent,
          /** 捕捉した版を消去し、成功した場合は失敗時の復元に使う版番号を控える。 */
          clear: () => {
            clearedRevision = registry.clearIfRevision(
              owner,
              captured.revision,
            );
          },
          /** 消去後の版が残っているときだけ入力欄を復元し、元の永続化済み版を照合元として再保存する。 */
          restore: () => {
            if (clearedRevision === null) return;
            const restored = registry.restoreIfRevision(
              owner,
              clearedRevision,
              () => captured.draft,
            );
            if (restored !== null)
              void observeSave(
                session.id,
                restored,
                persistence.enqueue(captured.draft, durable),
              );
          },
          /** Turn の終了を待つ送信と、消費中だけ保存を待機させる入力受付を別の経路で扱う。 */
          consume: (operation) =>
            kind === "turn"
              ? persistence.dispatchTurn(operation)
              : persistence.withDraftConsumption(operation),
          /** 受付後の永続化済み下書きを、他の編集の保存を妨げずに読み直す。 */
          reload: () => persistence.reload(),
        };
      } catch (error) {
        if (kind === "input") throw error;
        registry.setSaveState(owner, "error", "Draft could not be saved.");
        return null;
      }
    },
    [getOwner, observeSave, ownerForId],
  );

  /** 送信の結果を変えず、画面側が完了待ちできるよう処理中の集合に登録する。 */
  const trackSend = useCallback(<T>(operation: Promise<T>) => {
    const tracked = operation as Promise<unknown>;
    pendingSendsRef.current.add(tracked);
    /** 成功・失敗どちらでも完了した送信だけを追跡から外す。 */
    const release = () => pendingSendsRef.current.delete(tracked);
    void operation.then(release, release);
    return operation;
  }, []);

  const waitForPendingSends = useCallback(async () => {
    await Promise.allSettled(Array.from(pendingSendsRef.current));
  }, []);

  const flushAll = useCallback(async () => {
    await Promise.all(
      Array.from(ownersRef.current.values(), (owner) => owner.flush()),
    );
  }, []);

  const pendingSessionIds = useCallback(
    () =>
      Array.from(ownersRef.current.entries())
        .filter(([, owner]) => owner.hasPending)
        .map(([sessionId]) => sessionId),
    [],
  );

  return useMemo(
    () => ({
      getOwner,
      observeSave,
      changeDraft,
      retrySave,
      trackSend,
      waitForPendingSends,
      flushAll,
      pendingSessionIds,
      prepareSubmission,
    }),
    [
      changeDraft,
      flushAll,
      getOwner,
      observeSave,
      pendingSessionIds,
      prepareSubmission,
      retrySave,
      trackSend,
      waitForPendingSends,
    ],
  );
}
