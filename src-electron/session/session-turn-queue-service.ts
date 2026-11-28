import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueOwner,
  SessionTurnQueueReceipt,
  SessionTurnQueueStore,
  SessionTurnQueueOrigin,
} from "../../src-shared/session/session-turn-queue.js";

export type SessionTurnQueueDispatchResult = {
  state: "completed" | "failed" | "canceled";
  reason?: string;
};

type ApplyStop = () => void;
type CancelDispatchedRun = (onApply?: ApplyStop) => boolean;
export type SessionTurnQueueDispatchControl = {
  /** 該当するランタイム実行をひも付ける。その実行権がすでに取り消されていれば false を返す。 */
  bindCancel(cancel: CancelDispatchedRun): boolean;
};
type NormalTurnClaim = {
  receipt: SessionTurnQueueReceipt;
  canceled: boolean;
  cancel?: CancelDispatchedRun;
  released: Promise<void>;
  release(): void;
};

export type SessionTurnQueueServiceDeps = {
  store: SessionTurnQueueStore;
  isRunInFlight(sessionId: string): boolean | Promise<boolean>;
  getUnreleasedSourceTurnIds?(): readonly string[];
  sendInput?(receipt: SessionTurnQueueReceipt, expectedTurnId: string): Promise<unknown>;
  getCoordinationInputTurnId?(receipt: SessionTurnQueueReceipt): Promise<string | null>;
  dispatch(
    receipt: SessionTurnQueueReceipt,
    onStarted: (input: { turnId: string; userMessageSeq: number }) => Promise<void>,
    control: SessionTurnQueueDispatchControl,
  ): Promise<SessionTurnQueueDispatchResult>;
  onTurnRecovered?(receipt: SessionTurnQueueReceipt): void;
  onChanged?(owner: SessionTurnQueueOwner, origin?: SessionTurnQueueOrigin): void;
};

export class QueuedInputPreDispatchError extends Error {}
export class QueuedInputRuntimeRecoveryError extends Error {}

export class SessionTurnQueueService {
  private readonly owners = new Map<string, SessionTurnQueueOwner>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly dispatching = new Map<string, NormalTurnClaim>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly blocked = new Set<string>();
  private readonly lastClaim = new Map<string, SessionTurnQueueReceipt>();
  private readonly edits = new Map<string, { incarnationId: string; id: string }>();
  private closing = false;
  private closed = false;

  constructor(private readonly deps: SessionTurnQueueServiceDeps) {}

  async start(refreshRecoveredSessions?: () => Promise<void>): Promise<void> {
    this.requireAccepting();
    await this.track((async () => {
      await this.deps.store.recoverInterrupted();
      await refreshRecoveredSessions?.();
      const owners = await this.deps.store.listPendingOwners();
      for (const owner of owners) {
        this.adoptOwner(owner);
        this.notify(owner);
        this.wake(owner.sessionId);
      }
    })());
  }

  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput, assertAuthorized?: () => void | Promise<void>): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    const admission = this.withLock(owner.sessionId, async () => {
      const available = await this.canClaim(owner);
      await assertAuthorized?.();
      const claim = available && !this.claimHeld(owner)
        ? { unreleasedSourceTurnIds: this.deps.getUnreleasedSourceTurnIds?.() ?? [] } : undefined;
      const { receipt, claimed } = await this.deps.store.admit(owner, captured, claim);
      this.adoptOwner(owner);
      if (claimed) this.reserveDispatch(claimed);
      this.notify(receipt);
      if (claimed && claimed.id !== receipt.id) this.notify(claimed);
      return { receipt, claimed };
    });
    return this.track(admission.then(({ receipt, claimed }) => {
      if (claimed) this.dispatchClaim(claimed);
      else this.wake(owner.sessionId);
      return receipt;
    }));
  }

  acceptCommittedReceipt(receipt: SessionTurnQueueReceipt): void {
    this.adoptOwner(receipt);
    this.notify(receipt);
    if (receipt.state === "queued" && receipt.captured.coordination && this.deps.getCoordinationInputTurnId) {
      void this.track((async () => {
        try {
          const turnId = await this.deps.getCoordinationInputTurnId!(receipt);
          if (turnId) await this.sendInput(receipt, receipt.id, turnId, true);
        } finally {
          this.wake(receipt.sessionId);
        }
      })().catch(() => {
        // 送出前の復旧や結果不明の状態は、既存のキューに記録する。
        // 受付済みの操作では、失敗を隠すために 2 件目の受付レコードを作らない。
      }));
    } else this.wake(receipt.sessionId);
  }

  reconcileKnownReceipt(receipt: SessionTurnQueueReceipt): void {
    this.adoptOwner(receipt);
    this.rememberCanonicalClaim(receipt);
    // 受付レコードの読み取りから復旧した処理を再開できるが、キュー変更を再通知して
    // その読み取り自体を無効化してはならない。
    this.wake(receipt.sessionId);
  }

  async wakeSourceTurnDependents(sourceSessionId: string): Promise<void> {
    if (this.closing || this.closed) return;
    await this.track((async () => {
      const owners = await this.deps.store.listPendingOwners(sourceSessionId);
      if (this.closing || this.closed) return;
      for (const owner of owners) {
        this.adoptOwner(owner);
        this.notify(owner);
        this.wake(owner.sessionId);
      }
    })());
  }

  cancelQueued(owner: SessionTurnQueueOwner, id: string, assertAuthorized?: () => void | Promise<void>): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      await assertAuthorized?.();
      this.assertNotEditing(owner, id);
      const receipt = await this.deps.store.cancelQueued(owner, id);
      if (this.isCurrentOwner(owner)) {
        this.notify(receipt);
        this.wake(owner.sessionId);
      }
      return receipt;
    }));
  }

  async stopClaim(owner: SessionTurnQueueOwner, receiptId: string, onApply?: ApplyStop): Promise<void> {
    const claim = this.dispatching.get(owner.sessionId);
    if (!claim || !this.isCurrentOwner(owner) || claim.receipt.incarnationId !== owner.incarnationId || claim.receipt.id !== receiptId) return;
    if (claim.cancel) {
      claim.cancel(onApply);
      return;
    }
    claim.canceled = true;
    await claim.released;
  }

  beginQueuedEdit(owner: SessionTurnQueueOwner, id: string, validateOwner: () => Promise<void>): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      this.requireAccepting();
      await validateOwner();
      const edit = this.edits.get(owner.sessionId);
      if (edit && (edit.incarnationId !== owner.incarnationId || edit.id !== id)) throw new Error("Another queued message is being edited.");
      const receipt = (await this.deps.store.listActive(owner)).find((entry) => entry.id === id);
      if (!receipt || receipt.state !== "queued") throw new Error("Only a queued receipt can be edited.");
      if (receipt.captured.coordination) throw new Error("Coordination delivery cannot be edited as a queued message.");
      this.adoptOwner(owner);
      this.edits.set(owner.sessionId, { incarnationId: owner.incarnationId, id });
      return receipt;
    }));
  }

  updateQueued(owner: SessionTurnQueueOwner, id: string,
    prepare: (receipt: SessionTurnQueueReceipt) => Promise<{ userMessage: string; attachments: SessionTurnQueueCapturedInput["attachments"] }>): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      this.requireAccepting();
      const edit = this.edits.get(owner.sessionId);
      if (edit?.incarnationId !== owner.incarnationId || edit.id !== id) throw new Error("The queued message is not being edited.");
      const current = (await this.deps.store.listActive(owner)).find((entry) => entry.id === id);
      if (!current || current.state !== "queued") throw new Error("Only a queued receipt can be edited.");
      const input = await prepare(current);
      const receipt = await this.deps.store.updateQueued(owner, id, input);
      this.edits.delete(owner.sessionId);
      this.notify(receipt);
      this.wake(owner.sessionId);
      return receipt;
    }));
  }

  cancelQueuedEdit(owner: SessionTurnQueueOwner, id: string): Promise<void> {
    return this.track(this.withLock(owner.sessionId, async () => {
      const edit = this.edits.get(owner.sessionId);
      if (!edit) return;
      if (edit.incarnationId !== owner.incarnationId || edit.id !== id) throw new Error("The queued edit identity changed.");
      this.edits.delete(owner.sessionId);
      this.wake(owner.sessionId);
    }));
  }

  releaseQueuedEdit(sessionId: string): Promise<void> {
    return this.track(this.withLock(sessionId, async () => {
      this.edits.delete(sessionId);
      this.wake(sessionId);
    }));
  }

  private assertNotEditing(owner: SessionTurnQueueOwner, id: string): void {
    const edit = this.edits.get(owner.sessionId);
    if (edit?.incarnationId === owner.incarnationId && edit.id === id) throw new Error("The queued message is being edited.");
  }

  reorderQueued(owner: SessionTurnQueueOwner, expectedQueuedIds: string[], queuedIds: string[]) {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      this.requireAccepting();
      try {
        return await this.deps.store.reorderQueued(owner, expectedQueuedIds, queuedIds);
      } finally {
        if (this.isCurrentOwner(owner)) this.notify(owner);
      }
    }));
  }

  sendQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt> {
    return this.sendInput(owner, id, expectedTurnId, false);
  }

  private sendInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string, coordination: boolean): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    if (!expectedTurnId?.trim()) return Promise.reject(new Error("The active turn is required."));
    return this.track((async () => {
      const receipt = await this.withLock(owner.sessionId, async () => {
        this.requireAccepting();
        if (coordination && (this.blocked.has(owner.sessionId) || this.edits.has(owner.sessionId))) throw new Error("The queue is held for recovery or editing.");
        this.assertNotEditing(owner, id);
        if (!this.deps.sendInput) throw new Error("Queued Session input is unavailable.");
        const candidate = (await this.deps.store.listActive(owner)).find((entry) => entry.id === id);
        if (!candidate || candidate.state !== "queued") throw new Error("The queued input is no longer available.");
        if (candidate.captured.retrySource) throw new Error("A failed Turn retry must start a new Turn.");
        if (Boolean(candidate.captured.coordination) !== coordination) throw new Error("Coordination input requires automatic related-Turn delivery.");
        let claimed: SessionTurnQueueReceipt;
        try {
          claimed = await this.deps.store.claimForInput(owner, id, expectedTurnId, this.deps.getUnreleasedSourceTurnIds?.());
        } catch (error) {
          try {
            const canonical = await this.deps.store.getReceipt(owner, candidate.requestId);
            if (canonical?.state === "starting" || canonical?.state === "interrupted") {
              this.adoptOwner(owner);
              this.lastClaim.set(owner.sessionId, canonical);
              this.blocked.add(owner.sessionId);
              if (canonical.state === "starting" && canonical.sessionId === owner.sessionId
                && canonical.incarnationId === owner.incarnationId && canonical.id === id
                && canonical.inputTurnId === expectedTurnId && canonical.userMessageSeq === null) {
                // プロバイダーの呼び出しはまだ始まっていない。確認済みのこの入力の実行権だけを元に戻す。
                // 応答を受け取れなかった場合は再試行せず、読み取りで結果を確認する。
                await this.restoreInputClaim(owner, id, expectedTurnId, candidate.requestId);
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
        const canonical = await this.deps.store.getReceipt(owner, receipt.requestId);
        if (!canonical || canonical.state !== "completed") throw new Error("The queued input commit could not be confirmed.");
        this.reconcileKnownReceipt(canonical);
        this.notify(canonical);
        return canonical;
      } catch (error) {
        return this.withLock(owner.sessionId, async () => {
          if (this.isCurrentOwner(owner)) this.blocked.add(owner.sessionId);
          const canonical = await this.deps.store.getReceipt(owner, receipt.requestId);
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
              await this.restoreInputClaim(owner, id, expectedTurnId, receipt.requestId);
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
            const saved = await this.deps.store.settle(owner, id, "interrupted", error instanceof Error ? error.message : "The input outcome could not be confirmed.");
            if (this.isCurrentOwner(owner) && (saved.state === "interrupted" || isConfirmedTerminal(saved))) {
              this.blocked.delete(owner.sessionId);
              this.wake(owner.sessionId);
            }
          } finally {
            this.notify(receipt);
          }
          throw error;
        });
      }
    })());
  }

  private async restoreInputClaim(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string, requestId: string): Promise<SessionTurnQueueReceipt> {
    try {
      return await this.deps.store.restoreQueuedInput(owner, id, expectedTurnId);
    } catch (error) {
      const current = await this.deps.store.getReceipt(owner, requestId);
      if (current?.state === "queued") return current;
      if (current?.state === "starting" && current.id === id && current.inputTurnId === expectedTurnId
        && current.userMessageSeq === null) {
        return this.deps.store.settle(owner, id, "interrupted", "The input claim recovery could not be confirmed.");
      }
      throw error;
    }
  }

  wake(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner || (this.claimHeld(owner) && !this.recoverableClaim(owner))) return;
    const claim = this.withLock(sessionId, async () => {
      if (!this.isCurrentOwner(owner)) return null;
      const recovery = this.recoverableClaim(owner);
      if (recovery) await this.recoverReleasedClaim(recovery);
      if (!this.isCurrentOwner(owner) || !await this.canClaim(owner) || !this.isCurrentOwner(owner)) return null;
      const receipt = await this.deps.store.claimNext(owner, this.deps.getUnreleasedSourceTurnIds?.());
      if (!receipt || !this.isCurrentOwner(owner)) return null;
      this.reserveDispatch(receipt);
      this.notify(receipt);
      return receipt;
    });
    void this.track(claim.then((receipt) => {
      if (receipt) this.dispatchClaim(receipt);
    }).catch(() => {
      // 実行権の取得や終了状態のコミットは、応答の失敗前に成功していた可能性がある。
      // 送出結果が不明なら、再送出も後続項目への自動進行も行わない。
      if (this.isCurrentOwner(owner)) this.blocked.add(sessionId);
    }));
  }

  beginShutdown(): void {
    this.closing = true;
  }

  async waitForPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  resume(): void {
    if (this.closed) return;
    this.closing = false;
    for (const sessionId of this.owners.keys()) this.wake(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.beginShutdown();
    await this.waitForPending();
  }

  private claimHeld(owner: SessionTurnQueueOwner): boolean {
    const { sessionId } = owner;
    return this.closing || this.dispatching.has(sessionId)
      || (this.isCurrentOwner(owner) && (this.blocked.has(sessionId) || this.edits.has(sessionId)));
  }

  private async canClaim(owner: SessionTurnQueueOwner): Promise<boolean> {
    return !this.claimHeld(owner) && !await this.deps.isRunInFlight(owner.sessionId) && !this.claimHeld(owner);
  }

  private recoverableClaim(owner: SessionTurnQueueOwner): SessionTurnQueueReceipt | null {
    if (this.closing || !this.blocked.has(owner.sessionId) || this.dispatching.has(owner.sessionId)) return null;
    const last = this.lastClaim.get(owner.sessionId);
    return last?.state === "interrupted" && !last.inputTurnId && last.incarnationId === owner.incarnationId ? last : null;
  }

  private async recoverReleasedClaim(claim: SessionTurnQueueReceipt): Promise<void> {
    if (await this.deps.isRunInFlight(claim.sessionId) || this.recoverableClaim(claim)?.id !== claim.id || !this.isCurrentOwner(claim)) return;
    const read = async () => {
      const current = await this.deps.store.getReceipt(claim, claim.requestId);
      return current && current.id === claim.id && current.sessionId === claim.sessionId
        && current.incarnationId === claim.incarnationId && this.isCurrentOwner(claim) ? current : null;
    };
    const before = await read();
    if (!before) return;
    if (isConfirmedTerminal(before)) {
      this.rememberCanonicalClaim(before);
      this.notify(before);
      return;
    }
    if (before.state !== "interrupted" || before.inputTurnId || this.recoverableClaim(claim)?.id !== claim.id) return;
    // 保存済みの中断状態にある該当の実行権に対して、新たに整合を取る。
    // 元の終了状態の書き込みやプロバイダーへの送出を繰り返す処理ではない。
    const changed = await this.deps.store.recoverInterrupted({ sessionId: claim.sessionId, incarnationId: claim.incarnationId, receiptId: claim.id });
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

  private rememberCanonicalClaim(receipt: SessionTurnQueueReceipt): void {
    const last = this.lastClaim.get(receipt.sessionId);
    if (!last || last.id !== receipt.id || last.incarnationId !== receipt.incarnationId) return;
    if (isConfirmedTerminal(receipt)) {
      this.blocked.delete(receipt.sessionId);
      this.lastClaim.set(receipt.sessionId, receipt);
      if (last.state === "interrupted" && !last.inputTurnId) {
        this.publishRecoveredTurn(receipt);
      }
    } else if (receipt.state === "interrupted") {
      if (!receipt.inputTurnId) this.lastClaim.set(receipt.sessionId, receipt);
      else if (receipt.userMessageSeq === null) this.blocked.delete(receipt.sessionId);
    }
  }

  private publishRecoveredTurn(receipt: SessionTurnQueueReceipt): void {
    try { this.deps.onTurnRecovered?.(receipt); } catch { /* 監視側は永続状態を制御しない。 */ }
  }

  private reserveDispatch(receipt: SessionTurnQueueReceipt): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.dispatching.set(receipt.sessionId, { receipt, canceled: false, released, release });
    this.lastClaim.set(receipt.sessionId, receipt);
  }

  private dispatchClaim(receipt: SessionTurnQueueReceipt): void {
    const { sessionId } = receipt;
    const claim = this.dispatching.get(sessionId)!;
    // 予約はロック中に記録し、送出はその後に行う。
    // 確定した実行権は、シャットダウン中でも処理の結果が確定するまで追跡する。
    void this.track(this.executeClaim(claim).catch(() => {
      if (this.isCurrentOwner(receipt)) this.blocked.add(sessionId);
    }).finally(() => {
      this.dispatching.delete(sessionId);
      claim.release();
      // 次の試行でも、実際のランタイム状態と後片付けのガードを確認する。
      this.wake(sessionId);
    }));
  }

  private async executeClaim(claim: NormalTurnClaim): Promise<void> {
    const { receipt } = claim;
    const { sessionId } = receipt;
    if (!this.isCurrentOwner(receipt)) return;
    let result: SessionTurnQueueDispatchResult;
    try {
      result = claim.canceled ? { state: "canceled", reason: "Session setup was canceled" } : await this.deps.dispatch(receipt, async (input) => {
        if (!this.isCurrentOwner(receipt)) throw new Error("The queue owner changed before turn start.");
        await this.deps.store.markStarted(receipt, receipt.id, input);
        if (!this.isCurrentOwner(receipt)) throw new Error("The queue owner changed during turn start.");
        this.notify(receipt);
      }, {
        bindCancel(cancel) {
          if (claim.canceled) return false;
          claim.cancel = cancel;
          return true;
        },
      });
    } catch (error) {
      if (!this.isCurrentOwner(receipt)) return;
      this.blocked.add(sessionId);
      // 並行するキュー経由の Steer が lastClaim を置き換えている可能性がある。
      // 通常の送出から戻った後は、その送出自体の受付レコードを照合し、Steer 入力とは区別する。
      this.lastClaim.set(sessionId, receipt);
      this.notify(receipt);
      const canonical = await this.deps.store.settle(receipt, receipt.id, "interrupted", error instanceof Error ? error.message : "The execution outcome could not be confirmed.");
      if (!this.isCurrentOwner(receipt)) return;
      this.notify(receipt);
      this.rememberCanonicalClaim(canonical);
      return;
    }
    if (!this.isCurrentOwner(receipt)) return;
    try {
      await this.deps.store.settle(receipt, receipt.id, result.state, result.reason);
    } catch {
      // コミットの応答が失われた場合、結果を確かめる手段は正本の読み取りだけ。
      // 結果を確定させるために、変更処理やプロバイダーへの送出を繰り返さない。
      if (!this.isCurrentOwner(receipt)) return;
      this.blocked.add(sessionId);
      this.notify(receipt);
      const current = await this.deps.store.getReceipt(receipt, receipt.requestId);
      if (!this.isCurrentOwner(receipt) || !current || !isConfirmedTerminal(current)) return;
      this.blocked.delete(sessionId);
    }
    if (this.isCurrentOwner(receipt)) this.notify(receipt);
  }

  private requireAccepting(): void {
    if (this.closing) throw new Error("Session turn queue is shutting down.");
  }

  private isCurrentOwner(owner: SessionTurnQueueOwner): boolean {
    return this.owners.get(owner.sessionId)?.incarnationId === owner.incarnationId;
  }

  private adoptOwner(owner: SessionTurnQueueOwner): void {
    if (!this.isCurrentOwner(owner)) {
      this.blocked.delete(owner.sessionId);
      this.lastClaim.delete(owner.sessionId);
      this.edits.delete(owner.sessionId);
    }
    this.owners.set(owner.sessionId, { ...owner });
  }

  private notify(owner: SessionTurnQueueOwner | SessionTurnQueueReceipt): void {
    try {
      const origin = "captured" in owner ? (owner.accepted ?? owner.captured).origin : undefined;
      this.deps.onChanged?.({ sessionId: owner.sessionId, incarnationId: owner.incarnationId }, origin);
    } catch {
      // 永続的な受付とキューの進行は、表示反映の監視側に依存しない。
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  private withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run);
    const released = next.then(() => undefined, () => undefined);
    this.locks.set(sessionId, released);
    void released.then(() => {
      if (this.locks.get(sessionId) === released) this.locks.delete(sessionId);
    });
    return next;
  }
}

function isConfirmedTerminal(receipt: SessionTurnQueueReceipt): boolean {
  return receipt.state === "completed" || receipt.state === "failed" || receipt.state === "canceled";
}
