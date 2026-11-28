import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueOwner,
  SessionTurnQueueReceipt,
  SessionTurnQueueStore,
  SessionTurnQueueOrigin,
} from "../../src-shared/session/session-turn-queue.js";

/** 通常 Turn の送出側で確定した完了・失敗・取消と、必要な説明。 */
export type SessionTurnQueueDispatchResult = {
  state: "completed" | "failed" | "canceled";
  reason?: string;
};

/** 停止が対象実行に適用される際に処理を引き継ぐコールバック。 */
type ApplyStop = () => void;
/** 送出後の実行を止め、適用できたか返す。適用した場合にだけ指定処理を呼べる。 */
type CancelDispatchedRun = (onApply?: ApplyStop) => boolean;
/** 先に予約したキュー受付と、あとから開始するランタイムの停止処理を関連付ける。 */
export type SessionTurnQueueDispatchControl = {
  /** 該当するランタイム実行をひも付ける。その実行権がすでに取り消されていれば false を返す。 */
  bindCancel(cancel: CancelDispatchedRun): boolean;
};
/** 一件の通常 Turn の送出予約。開始前の取消またはランタイムの停止手段と、予約の解放を追跡する。 */
type NormalTurnClaim = {
  receipt: SessionTurnQueueReceipt;
  canceled: boolean;
  cancel?: CancelDispatchedRun;
  released: Promise<void>;
  /** 処理の確定後、予約の解放を待っている側を再開させる。 */
  release(): void;
};

/** キューの正本と、通常実行・追加入力、それぞれの受付や回復を投影するための依存。 */
export type SessionTurnQueueServiceDeps = {
  store: SessionTurnQueueStore;
  /** Session に実行中または終了待ちの処理が残っているかを確かめる。 */
  isRunInFlight(sessionId: string): boolean | Promise<boolean>;
  /** 処理終了の保存後も、実行側で解放されていない起点 Turn の ID を取得する。 */
  getUnreleasedSourceTurnIds?(): readonly string[];
  /** 取得済みの入力権に対応する特定の実行中 Turn へ追加入力を送る。 */
  sendInput?(
    receipt: SessionTurnQueueReceipt,
    expectedTurnId: string,
  ): Promise<unknown>;
  /** 受付済みの Coordination を現在の関連 Turn に配信できるかを調べ、対象がなければ null を返す。 */
  getCoordinationInputTurnId?(
    receipt: SessionTurnQueueReceipt,
  ): Promise<string | null>;
  /** 予約済みの通常受付を実行し、実際の開始を保存する窓口と停止の接続先を使って終了状態を返す。 */
  dispatch(
    receipt: SessionTurnQueueReceipt,
    onStarted: (input: {
      turnId: string;
      userMessageSeq: number;
    }) => Promise<void>,
    control: SessionTurnQueueDispatchControl,
  ): Promise<SessionTurnQueueDispatchResult>;
  /** 中断受付について保存済み Turn の回復結果が分かったとき、表示側へ通知する。 */
  onTurnRecovered?(receipt: SessionTurnQueueReceipt): void;
  /** 指定の所有世代に関するキューの変化と、分かる場合は受付時の出所を通知する。 */
  onChanged?(
    owner: SessionTurnQueueOwner,
    origin?: SessionTurnQueueOrigin,
  ): void;
};

/** プロバイダーへ入力が渡る前に失敗し、取得済みの入力枠を戻せることを表す。 */
export class QueuedInputPreDispatchError extends Error {}
/** 受付が確定済みでも、ランタイム側の回復が必要であることを表す。 */
export class QueuedInputRuntimeRecoveryError extends Error {}

/** 所有者ごとにキュー操作を直列化し、実際の送出・編集と、結果不明からの回復を管理する。 */
export class SessionTurnQueueService {
  private readonly owners = new Map<string, SessionTurnQueueOwner>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly dispatching = new Map<string, NormalTurnClaim>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly blocked = new Set<string>();
  private readonly lastClaim = new Map<string, SessionTurnQueueReceipt>();
  private readonly edits = new Map<
    string,
    { incarnationId: string; id: string }
  >();
  private closing = false;
  private closed = false;

  /** 永続ストア、ランタイムへの送出、表示への通知を、それぞれの境界として受け取る。 */
  constructor(private readonly deps: SessionTurnQueueServiceDeps) {}

  /** 起動時の中断状態を回復した後、待機入力のある所有者を読み込んで受付処理を再開する。 */
  async start(refreshRecoveredSessions?: () => Promise<void>): Promise<void> {
    this.requireAccepting();
    await this.track(
      (async () => {
        await this.deps.store.recoverInterrupted();
        await refreshRecoveredSessions?.();
        const owners = await this.deps.store.listPendingOwners();
        for (const owner of owners) {
          this.adoptOwner(owner);
          this.notify(owner);
          this.wake(owner.sessionId);
        }
      })(),
    );
  }

  /** 認可を確認して入力を受け付ける。実行枠が空いていれば同じ保存操作で予約し、ロックの外で送出する。 */
  enqueue(
    owner: SessionTurnQueueOwner,
    captured: SessionTurnQueueCapturedInput,
    assertAuthorized?: () => void | Promise<void>,
  ): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    const admission = this.withLock(owner.sessionId, async () => {
      const available = await this.canClaim(owner);
      await assertAuthorized?.();
      const claim =
        available && !this.claimHeld(owner)
          ? {
              unreleasedSourceTurnIds:
                this.deps.getUnreleasedSourceTurnIds?.() ?? [],
            }
          : undefined;
      const { receipt, claimed } = await this.deps.store.admit(
        owner,
        captured,
        claim,
      );
      this.adoptOwner(owner);
      if (claimed) this.reserveDispatch(claimed);
      this.notify(receipt);
      if (claimed && claimed.id !== receipt.id) this.notify(claimed);
      return { receipt, claimed };
    });
    return this.track(
      admission.then(({ receipt, claimed }) => {
        if (claimed) this.dispatchClaim(claimed);
        else this.wake(owner.sessionId);
        return receipt;
      }),
    );
  }

  /** 別の操作とともに保存された受付をキューに反映する。Coordination は関連 Turn への配信を試せる。 */
  acceptCommittedReceipt(receipt: SessionTurnQueueReceipt): void {
    this.adoptOwner(receipt);
    this.notify(receipt);
    if (
      receipt.state === "queued" &&
      receipt.captured.coordination &&
      this.deps.getCoordinationInputTurnId
    ) {
      void this.track(
        (async () => {
          try {
            const turnId = await this.deps.getCoordinationInputTurnId!(receipt);
            if (turnId) await this.sendInput(receipt, receipt.id, turnId, true);
          } finally {
            this.wake(receipt.sessionId);
          }
        })().catch(() => {
          // 送出前の復旧や結果不明の状態は、既存のキューに記録する。
          // 受付済みの操作では、失敗を隠すために 2 件目の受付レコードを作らない。
        }),
      );
    } else this.wake(receipt.sessionId);
  }

  /** 正本から読んだ受付を回復状態と照合し、再通知せずキューを起こす。 */
  reconcileKnownReceipt(receipt: SessionTurnQueueReceipt): void {
    this.adoptOwner(receipt);
    this.rememberCanonicalClaim(receipt);
    // 受付レコードの読み取りから復旧した処理を再開できるが、キュー変更を再通知して
    // その読み取り自体を無効化してはならない。
    this.wake(receipt.sessionId);
  }

  /** 指定の起点 Session の終了を待つ宛先を読み、キューの条件を再評価する。終了準備中は起こさない。 */
  async wakeSourceTurnDependents(sourceSessionId: string): Promise<void> {
    if (this.closing || this.closed) return;
    await this.track(
      (async () => {
        const owners = await this.deps.store.listPendingOwners(sourceSessionId);
        if (this.closing || this.closed) return;
        for (const owner of owners) {
          this.adoptOwner(owner);
          this.notify(owner);
          this.wake(owner.sessionId);
        }
      })(),
    );
  }

  /** 権限と編集状態を確認して、該当受付が待機中の場合にだけ取り消す。 */
  cancelQueued(
    owner: SessionTurnQueueOwner,
    id: string,
    assertAuthorized?: () => void | Promise<void>,
  ): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(
      this.withLock(owner.sessionId, async () => {
        await assertAuthorized?.();
        this.assertNotEditing(owner, id);
        const receipt = await this.deps.store.cancelQueued(owner, id);
        if (this.isCurrentOwner(owner)) {
          this.notify(receipt);
          this.wake(owner.sessionId);
        }
        return receipt;
      }),
    );
  }

  /** 対象と同じ実行予約だけを停止する。ランタイムに接続前なら取消を記録して予約の解放を待つ。 */
  async stopClaim(
    owner: SessionTurnQueueOwner,
    receiptId: string,
    onApply?: ApplyStop,
  ): Promise<void> {
    const claim = this.dispatching.get(owner.sessionId);
    if (
      !claim ||
      !this.isCurrentOwner(owner) ||
      claim.receipt.incarnationId !== owner.incarnationId ||
      claim.receipt.id !== receiptId
    )
      return;
    if (claim.cancel) {
      claim.cancel(onApply);
      return;
    }
    claim.canceled = true;
    await claim.released;
  }

  /** 対象の世代と待機状態を確認し、一件だけ編集用に保持する。Coordination 配信は対象外。 */
  beginQueuedEdit(
    owner: SessionTurnQueueOwner,
    id: string,
    validateOwner: () => Promise<void>,
  ): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(
      this.withLock(owner.sessionId, async () => {
        this.requireAccepting();
        await validateOwner();
        const edit = this.edits.get(owner.sessionId);
        if (
          edit &&
          (edit.incarnationId !== owner.incarnationId || edit.id !== id)
        )
          throw new Error("Another queued message is being edited.");
        const receipt = (await this.deps.store.listActive(owner)).find(
          (entry) => entry.id === id,
        );
        if (!receipt || receipt.state !== "queued")
          throw new Error("Only a queued receipt can be edited.");
        if (receipt.captured.coordination)
          throw new Error(
            "Coordination delivery cannot be edited as a queued message.",
          );
        this.adoptOwner(owner);
        this.edits.set(owner.sessionId, {
          incarnationId: owner.incarnationId,
          id,
        });
        return receipt;
      }),
    );
  }

  /** 保持中の同じ待機入力へ本文・添付の変更を保存し、成功時だけ編集状態を解除する。 */
  updateQueued(
    owner: SessionTurnQueueOwner,
    id: string,
    prepare: (receipt: SessionTurnQueueReceipt) => Promise<{
      userMessage: string;
      attachments: SessionTurnQueueCapturedInput["attachments"];
    }>,
  ): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(
      this.withLock(owner.sessionId, async () => {
        this.requireAccepting();
        const edit = this.edits.get(owner.sessionId);
        if (edit?.incarnationId !== owner.incarnationId || edit.id !== id)
          throw new Error("The queued message is not being edited.");
        const current = (await this.deps.store.listActive(owner)).find(
          (entry) => entry.id === id,
        );
        if (!current || current.state !== "queued")
          throw new Error("Only a queued receipt can be edited.");
        const input = await prepare(current);
        const receipt = await this.deps.store.updateQueued(owner, id, input);
        this.edits.delete(owner.sessionId);
        this.notify(receipt);
        this.wake(owner.sessionId);
        return receipt;
      }),
    );
  }

  /** 同じ世代・受付の編集だけを解除し、編集内容は保存せずキューを再開する。 */
  cancelQueuedEdit(owner: SessionTurnQueueOwner, id: string): Promise<void> {
    return this.track(
      this.withLock(owner.sessionId, async () => {
        const edit = this.edits.get(owner.sessionId);
        if (!edit) return;
        if (edit.incarnationId !== owner.incarnationId || edit.id !== id)
          throw new Error("The queued edit identity changed.");
        this.edits.delete(owner.sessionId);
        this.wake(owner.sessionId);
      }),
    );
  }

  /** Window の解放などで指定 Session の編集枠を解除し、待機処理を進められるようにする。 */
  releaseQueuedEdit(sessionId: string): Promise<void> {
    return this.track(
      this.withLock(sessionId, async () => {
        this.edits.delete(sessionId);
        this.wake(sessionId);
      }),
    );
  }

  /** 該当世代の受付が編集用に保持されている場合は、競合する取消や送出を防ぐ。 */
  private assertNotEditing(owner: SessionTurnQueueOwner, id: string): void {
    const edit = this.edits.get(owner.sessionId);
    if (edit?.incarnationId === owner.incarnationId && edit.id === id)
      throw new Error("The queued message is being edited.");
  }

  /** 想定した ID 順と現在の保存順をストアで照合して並べ替え、競合時も表示の再取得を促す。 */
  reorderQueued(
    owner: SessionTurnQueueOwner,
    expectedQueuedIds: string[],
    queuedIds: string[],
  ) {
    this.requireAccepting();
    return this.track(
      this.withLock(owner.sessionId, async () => {
        this.requireAccepting();
        try {
          return await this.deps.store.reorderQueued(
            owner,
            expectedQueuedIds,
            queuedIds,
          );
        } finally {
          if (this.isCurrentOwner(owner)) this.notify(owner);
        }
      }),
    );
  }

  /** 指定の通常待機入力を、現在の想定 Turn への追加入力として送る。 */
  sendQueuedInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
  ): Promise<SessionTurnQueueReceipt> {
    return this.sendInput(owner, id, expectedTurnId, false);
  }

  /** 対象と起点を照合して入力権を取得し、ロック外で送出する。失敗時は正本を読み、送出前の失敗と結果不明を区別する。 */
  private sendInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
    coordination: boolean,
  ): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    if (!expectedTurnId?.trim())
      return Promise.reject(new Error("The active turn is required."));
    return this.track(
      (async () => {
        const receipt = await this.withLock(owner.sessionId, async () => {
          this.requireAccepting();
          if (
            coordination &&
            (this.blocked.has(owner.sessionId) ||
              this.edits.has(owner.sessionId))
          )
            throw new Error("The queue is held for recovery or editing.");
          this.assertNotEditing(owner, id);
          if (!this.deps.sendInput)
            throw new Error("Queued Session input is unavailable.");
          const candidate = (await this.deps.store.listActive(owner)).find(
            (entry) => entry.id === id,
          );
          if (!candidate || candidate.state !== "queued")
            throw new Error("The queued input is no longer available.");
          if (candidate.captured.retrySource)
            throw new Error("A failed Turn retry must start a new Turn.");
          if (Boolean(candidate.captured.coordination) !== coordination)
            throw new Error(
              "Coordination input requires automatic related-Turn delivery.",
            );
          let claimed: SessionTurnQueueReceipt;
          try {
            claimed = await this.deps.store.claimForInput(
              owner,
              id,
              expectedTurnId,
              this.deps.getUnreleasedSourceTurnIds?.(),
            );
          } catch (error) {
            try {
              const canonical = await this.deps.store.getReceipt(
                owner,
                candidate.requestId,
              );
              if (
                canonical?.state === "starting" ||
                canonical?.state === "interrupted"
              ) {
                this.adoptOwner(owner);
                this.lastClaim.set(owner.sessionId, canonical);
                this.blocked.add(owner.sessionId);
                if (
                  canonical.state === "starting" &&
                  canonical.sessionId === owner.sessionId &&
                  canonical.incarnationId === owner.incarnationId &&
                  canonical.id === id &&
                  canonical.inputTurnId === expectedTurnId &&
                  canonical.userMessageSeq === null
                ) {
                  // プロバイダーの呼び出しはまだ始まっていない。確認済みのこの入力の実行権だけを元に戻す。
                  // 応答を受け取れなかった場合は再試行せず、読み取りで結果を確認する。
                  await this.restoreInputClaim(
                    owner,
                    id,
                    expectedTurnId,
                    candidate.requestId,
                  );
                  if (this.isCurrentOwner(owner)) {
                    this.blocked.delete(owner.sessionId);
                    this.lastClaim.delete(owner.sessionId);
                    this.wake(owner.sessionId);
                  }
                }
              }
            } catch {
              if (this.isCurrentOwner(owner)) this.blocked.add(owner.sessionId);
            }
            this.notify(candidate);
            throw error;
          }
          this.adoptOwner(owner);
          this.lastClaim.set(owner.sessionId, claimed);
          this.notify(claimed);
          return claimed;
        });
        try {
          await this.deps.sendInput!(receipt, expectedTurnId);
          const canonical = await this.deps.store.getReceipt(
            owner,
            receipt.requestId,
          );
          if (!canonical || canonical.state !== "completed")
            throw new Error("The queued input commit could not be confirmed.");
          this.reconcileKnownReceipt(canonical);
          this.notify(canonical);
          return canonical;
        } catch (error) {
          return this.withLock(owner.sessionId, async () => {
            if (this.isCurrentOwner(owner)) this.blocked.add(owner.sessionId);
            const canonical = await this.deps.store.getReceipt(
              owner,
              receipt.requestId,
            );
            if (canonical?.state === "completed") {
              if (error instanceof QueuedInputRuntimeRecoveryError) {
                this.notify(canonical);
                throw error;
              }
              this.reconcileKnownReceipt(canonical);
              this.notify(canonical);
              return canonical;
            }
            if (error instanceof QueuedInputPreDispatchError) {
              try {
                await this.restoreInputClaim(
                  owner,
                  id,
                  expectedTurnId,
                  receipt.requestId,
                );
                if (this.isCurrentOwner(owner)) {
                  this.blocked.delete(owner.sessionId);
                  this.lastClaim.delete(owner.sessionId);
                  this.wake(owner.sessionId);
                }
              } finally {
                this.notify(receipt);
              }
              throw error;
            }
            if (this.isCurrentOwner(owner)) this.blocked.add(owner.sessionId);
            try {
              const saved = await this.deps.store.settle(
                owner,
                id,
                "interrupted",
                error instanceof Error
                  ? error.message
                  : "The input outcome could not be confirmed.",
              );
              if (
                this.isCurrentOwner(owner) &&
                (saved.state === "interrupted" || isConfirmedTerminal(saved))
              ) {
                this.blocked.delete(owner.sessionId);
                this.wake(owner.sessionId);
              }
            } finally {
              this.notify(receipt);
            }
            throw error;
          });
        }
      })(),
    );
  }

  /** 取得した入力権を待機へ戻す。応答が失われた場合は現在の保存状態を読み、同じ変更を繰り返さない。 */
  private async restoreInputClaim(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
    requestId: string,
  ): Promise<SessionTurnQueueReceipt> {
    try {
      return await this.deps.store.restoreQueuedInput(
        owner,
        id,
        expectedTurnId,
      );
    } catch (error) {
      const current = await this.deps.store.getReceipt(owner, requestId);
      if (current?.state === "queued") return current;
      if (
        current?.state === "starting" &&
        current.id === id &&
        current.inputTurnId === expectedTurnId &&
        current.userMessageSeq === null
      ) {
        return this.deps.store.settle(
          owner,
          id,
          "interrupted",
          "The input claim recovery could not be confirmed.",
        );
      }
      throw error;
    }
  }

  /** 現行の所有者の回復と実行状況を確認し、送出できる次の受付があれば予約して処理を開始する。 */
  wake(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner || (this.claimHeld(owner) && !this.recoverableClaim(owner)))
      return;
    const claim = this.withLock(sessionId, async () => {
      if (!this.isCurrentOwner(owner)) return null;
      const recovery = this.recoverableClaim(owner);
      if (recovery) await this.recoverReleasedClaim(recovery);
      if (
        !this.isCurrentOwner(owner) ||
        !(await this.canClaim(owner)) ||
        !this.isCurrentOwner(owner)
      )
        return null;
      const receipt = await this.deps.store.claimNext(
        owner,
        this.deps.getUnreleasedSourceTurnIds?.(),
      );
      if (!receipt || !this.isCurrentOwner(owner)) return null;
      this.reserveDispatch(receipt);
      this.notify(receipt);
      return receipt;
    });
    void this.track(
      claim
        .then((receipt) => {
          if (receipt) this.dispatchClaim(receipt);
        })
        .catch(() => {
          // 実行権の取得や終了状態のコミットは、応答の失敗前に成功していた可能性がある。
          // 送出結果が不明なら、再送出も後続項目への自動進行も行わない。
          if (this.isCurrentOwner(owner)) this.blocked.add(sessionId);
        }),
    );
  }

  /** 新しい受付と実行枠の取得を止める。すでに予約した処理は追跡を続ける。 */
  beginShutdown(): void {
    this.closing = true;
  }

  /** 現在の処理と、待機中に新たに追跡された処理についても、成功・失敗に関係なく確定まで待つ。 */
  async waitForPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** 恒久的に閉じていなければ受付を再開し、登録済みの全所有者に送出の再評価をかける。 */
  resume(): void {
    if (this.closed) return;
    this.closing = false;
    for (const sessionId of this.owners.keys()) this.wake(sessionId);
  }

  /** 恒久的に受付を終了し、既存の追跡処理が確定するまで待つ。 */
  async close(): Promise<void> {
    this.closed = true;
    this.beginShutdown();
    await this.waitForPending();
  }

  /** 終了準備・実行予約・現行世代の回復または編集によって新しい通常実行枠を取れないかを確認する。 */
  private claimHeld(owner: SessionTurnQueueOwner): boolean {
    const { sessionId } = owner;
    return (
      this.closing ||
      this.dispatching.has(sessionId) ||
      (this.isCurrentOwner(owner) &&
        (this.blocked.has(sessionId) || this.edits.has(sessionId)))
    );
  }

  /** ランタイムに実行が残っていないことを確認し、その非同期確認の前後でローカルの予約状態を照合する。 */
  private async canClaim(owner: SessionTurnQueueOwner): Promise<boolean> {
    return (
      !this.claimHeld(owner) &&
      !(await this.deps.isRunInFlight(owner.sessionId)) &&
      !this.claimHeld(owner)
    );
  }

  /** 終了準備中ではなく、同じ世代の中断された通常受付があり、まだ送出予約がなければ回復対象として返す。 */
  private recoverableClaim(
    owner: SessionTurnQueueOwner,
  ): SessionTurnQueueReceipt | null {
    if (
      this.closing ||
      !this.blocked.has(owner.sessionId) ||
      this.dispatching.has(owner.sessionId)
    )
      return null;
    const last = this.lastClaim.get(owner.sessionId);
    return last?.state === "interrupted" &&
      !last.inputTurnId &&
      last.incarnationId === owner.incarnationId
      ? last
      : null;
  }

  /** ライブ処理が解放された特定受付を正本で照合し、確定結果または中断の残存を確認して次の受付を止める条件を見直す。 */
  private async recoverReleasedClaim(
    claim: SessionTurnQueueReceipt,
  ): Promise<void> {
    if (
      (await this.deps.isRunInFlight(claim.sessionId)) ||
      this.recoverableClaim(claim)?.id !== claim.id ||
      !this.isCurrentOwner(claim)
    )
      return;
    /** 元の送信キーを使って受付を読み、ID・宛先・世代が指定と今の所有者に一致する場合だけ採用する。 */
    const read = async () => {
      const current = await this.deps.store.getReceipt(claim, claim.requestId);
      return current &&
        current.id === claim.id &&
        current.sessionId === claim.sessionId &&
        current.incarnationId === claim.incarnationId &&
        this.isCurrentOwner(claim)
        ? current
        : null;
    };
    const before = await read();
    if (!before) return;
    if (isConfirmedTerminal(before)) {
      this.rememberCanonicalClaim(before);
      this.notify(before);
      return;
    }
    if (
      before.state !== "interrupted" ||
      before.inputTurnId ||
      this.recoverableClaim(claim)?.id !== claim.id
    )
      return;
    // 保存済みの中断状態にある該当の実行権に対して、新たに整合を取る。
    // 元の終了状態の書き込みやプロバイダーへの送出を繰り返す処理ではない。
    const changed = await this.deps.store.recoverInterrupted({
      sessionId: claim.sessionId,
      incarnationId: claim.incarnationId,
      receiptId: claim.id,
    });
    const canonical = await read();
    if (!canonical) return;
    this.rememberCanonicalClaim(canonical);
    if (isConfirmedTerminal(canonical)) this.notify(canonical);
    else if (canonical.state === "interrupted" && !canonical.inputTurnId) {
      // 今回の試行結果は不明のままだが、保存済みの受付レコードから、
      // 送出待ちの古い実行権が残っていないことは確認できる。
      this.blocked.delete(claim.sessionId);
      this.lastClaim.delete(claim.sessionId);
      if (changed) this.publishRecoveredTurn(canonical);
    }
  }

  /** 最後に追った受付と同じ保存結果だけで、回復待ちの解除または中断状態を更新する。 */
  private rememberCanonicalClaim(receipt: SessionTurnQueueReceipt): void {
    const last = this.lastClaim.get(receipt.sessionId);
    if (
      !last ||
      last.id !== receipt.id ||
      last.incarnationId !== receipt.incarnationId
    )
      return;
    if (isConfirmedTerminal(receipt)) {
      this.blocked.delete(receipt.sessionId);
      this.lastClaim.set(receipt.sessionId, receipt);
      if (last.state === "interrupted" && !last.inputTurnId) {
        this.publishRecoveredTurn(receipt);
      }
    } else if (receipt.state === "interrupted") {
      if (!receipt.inputTurnId) this.lastClaim.set(receipt.sessionId, receipt);
      else if (receipt.userMessageSeq === null)
        this.blocked.delete(receipt.sessionId);
    }
  }

  /** 回復済みの結果を表示へ通知する。通知の例外で保存結果を変えない。 */
  private publishRecoveredTurn(receipt: SessionTurnQueueReceipt): void {
    try {
      this.deps.onTurnRecovered?.(receipt);
    } catch {
      /* 監視側は永続状態を制御しない。 */
    }
  }

  /** 受付の送出をロック内で予約し、停止要求が追跡できるよう解放待ちを作る。 */
  private reserveDispatch(receipt: SessionTurnQueueReceipt): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.dispatching.set(receipt.sessionId, {
      receipt,
      canceled: false,
      released,
      release,
    });
    this.lastClaim.set(receipt.sessionId, receipt);
  }

  /** 予約済みの実行を追跡して開始し、確定後に予約を解放して次の候補を再評価する。 */
  private dispatchClaim(receipt: SessionTurnQueueReceipt): void {
    const { sessionId } = receipt;
    const claim = this.dispatching.get(sessionId)!;
    // 予約はロック中に記録し、送出はその後に行う。
    // 確定した実行権は、シャットダウン中でも処理の結果が確定するまで追跡する。
    void this.track(
      this.executeClaim(claim)
        .catch(() => {
          if (this.isCurrentOwner(receipt)) this.blocked.add(sessionId);
        })
        .finally(() => {
          this.dispatching.delete(sessionId);
          claim.release();
          // 次の試行でも、実際のランタイム状態と後片付けのガードを確認する。
          this.wake(sessionId);
        }),
    );
  }

  /** 予約した通常 Turn を開始・保存・確定する。応答が失われたときは元の受付を再照会し、再送出しない。 */
  private async executeClaim(claim: NormalTurnClaim): Promise<void> {
    const { receipt } = claim;
    const { sessionId } = receipt;
    if (!this.isCurrentOwner(receipt)) return;
    let result: SessionTurnQueueDispatchResult;
    try {
      result = claim.canceled
        ? { state: "canceled", reason: "Session setup was canceled" }
        : await this.deps.dispatch(
            receipt,
            async (input) => {
              if (!this.isCurrentOwner(receipt))
                throw new Error("The queue owner changed before turn start.");
              await this.deps.store.markStarted(receipt, receipt.id, input);
              if (!this.isCurrentOwner(receipt))
                throw new Error("The queue owner changed during turn start.");
              this.notify(receipt);
            },
            {
              /** 予約がまだ取り消されていなければ、実際に開始したランタイムの停止処理を結び付ける。 */
              bindCancel(cancel) {
                if (claim.canceled) return false;
                claim.cancel = cancel;
                return true;
              },
            },
          );
    } catch (error) {
      if (!this.isCurrentOwner(receipt)) return;
      this.blocked.add(sessionId);
      // 並行するキュー経由の Steer が lastClaim を置き換えている可能性がある。
      // 通常の送出から戻った後は、その送出自体の受付レコードを照合し、Steer 入力とは区別する。
      this.lastClaim.set(sessionId, receipt);
      this.notify(receipt);
      const canonical = await this.deps.store.settle(
        receipt,
        receipt.id,
        "interrupted",
        error instanceof Error
          ? error.message
          : "The execution outcome could not be confirmed.",
      );
      if (!this.isCurrentOwner(receipt)) return;
      this.notify(receipt);
      this.rememberCanonicalClaim(canonical);
      return;
    }
    if (!this.isCurrentOwner(receipt)) return;
    try {
      await this.deps.store.settle(
        receipt,
        receipt.id,
        result.state,
        result.reason,
      );
    } catch {
      // コミットの応答が失われた場合、結果を確かめる手段は正本の読み取りだけ。
      // 結果を確定させるために、変更処理やプロバイダーへの送出を繰り返さない。
      if (!this.isCurrentOwner(receipt)) return;
      this.blocked.add(sessionId);
      this.notify(receipt);
      const current = await this.deps.store.getReceipt(
        receipt,
        receipt.requestId,
      );
      if (
        !this.isCurrentOwner(receipt) ||
        !current ||
        !isConfirmedTerminal(current)
      )
        return;
      this.blocked.delete(sessionId);
    }
    if (this.isCurrentOwner(receipt)) this.notify(receipt);
  }

  /** 終了準備に入った後、新しい操作を受け付けない。 */
  private requireAccepting(): void {
    if (this.closing) throw new Error("Session turn queue is shutting down.");
  }

  /** Session ID について記録した所有世代が指定と同じかを確認する。 */
  private isCurrentOwner(owner: SessionTurnQueueOwner): boolean {
    return (
      this.owners.get(owner.sessionId)?.incarnationId === owner.incarnationId
    );
  }

  /** 現行所有者を更新する。世代が変わった場合は以前の回復・編集の状態を持ち越さない。 */
  private adoptOwner(owner: SessionTurnQueueOwner): void {
    if (!this.isCurrentOwner(owner)) {
      this.blocked.delete(owner.sessionId);
      this.lastClaim.delete(owner.sessionId);
      this.edits.delete(owner.sessionId);
    }
    this.owners.set(owner.sessionId, { ...owner });
  }

  /** 受付時の出所を優先して変更を表示側へ伝える。監視側の失敗はキューへ伝えない。 */
  private notify(owner: SessionTurnQueueOwner | SessionTurnQueueReceipt): void {
    try {
      const origin =
        "captured" in owner
          ? (owner.accepted ?? owner.captured).origin
          : undefined;
      this.deps.onChanged?.(
        { sessionId: owner.sessionId, incarnationId: owner.incarnationId },
        origin,
      );
    } catch {
      // 永続的な受付とキューの進行は、表示反映の監視側に依存しない。
    }
  }

  /** 非同期処理を終了時の待機対象に加え、結果が確定したら外す。 */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  /** Session ごとに保存・予約処理を直列に実行し、前の失敗で後続のロックを止めない。 */
  private withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run);
    const released = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sessionId, released);
    void released.then(() => {
      if (this.locks.get(sessionId) === released) this.locks.delete(sessionId);
    });
    return next;
  }
}

/** 結果が確定した完了・失敗・取消だけを終了扱いとし、結果不明の中断は含めない。 */
function isConfirmedTerminal(receipt: SessionTurnQueueReceipt): boolean {
  return (
    receipt.state === "completed" ||
    receipt.state === "failed" ||
    receipt.state === "canceled"
  );
}
