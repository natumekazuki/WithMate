import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

/** 親ウィンドウへ実行状態を届けるために、ストレージ世代と受付・実行中の状態を確認する操作。 */
type AuxiliaryLiveRunParentsOptions = {
  /** 親との対応を現在のものとして扱えるストレージ所有者を取得する。 */
  getStorageOwner(): object | null;
  /** Auxiliary の実行が受付・準備段階に残っているか確認する。 */
  isRunPending(sessionId: string): boolean;
  /** 終了通知をまだ必要とするライブ実行があるか確認する。 */
  hasLiveSessionRun(sessionId: string): boolean;
  /** 現在の実行状態または終端の null を、宛先解決の共通処理へ渡す。 */
  broadcastLiveSessionRun(
    sessionId: string,
    state: LiveSessionRunState | null,
  ): void;
};

/** Auxiliary の受付から終端通知まで、現在のストレージ世代における親との対応を維持する。 */
export class AuxiliaryLiveRunParents {
  private readonly parents = new Map<
    string,
    { parentSessionId: string; owner: object }
  >();

  /** 実行の有無と現在のストレージ所有者の取得方法を受け取る。 */
  public constructor(
    private readonly options: AuxiliaryLiveRunParentsOptions,
  ) {}

  /** このインスタンスが保持している親との対応の件数を返す。 */
  public get size(): number {
    return this.parents.size;
  }

  /** 現在のストレージ所有者が登録した場合に限り、対象 Auxiliary の親を返す。 */
  public get(sessionId: string): string | undefined {
    const entry = this.parents.get(sessionId);
    return entry?.owner === this.options.getStorageOwner()
      ? entry.parentSessionId
      : undefined;
  }

  /** 指定の親でまだ受付中の Auxiliary 実行を、現在の世代に限定して列挙する。 */
  public *pendingRunIdsForParent(
    parentSessionId: string,
  ): IterableIterator<string> {
    const owner = this.options.getStorageOwner();
    for (const [sessionId, entry] of this.parents) {
      if (
        entry.owner === owner &&
        entry.parentSessionId === parentSessionId &&
        this.options.isRunPending(sessionId)
      )
        yield sessionId;
    }
  }

  /** 現在の世代で、この親に受付途中の Auxiliary が一件でもあるか判定する。 */
  public hasPendingRunForParent(parentSessionId: string): boolean {
    return !this.pendingRunIdsForParent(parentSessionId).next().done;
  }

  /** 現世代で受付中の Auxiliary に限り、親への通知経路を記録する。 */
  public remember(
    session: Pick<AuxiliarySession, "id" | "parentSessionId">,
    owner: object,
  ): void {
    if (
      owner !== this.options.getStorageOwner() ||
      !this.options.isRunPending(session.id)
    )
      return;
    this.parents.set(session.id, {
      parentSessionId: session.parentSessionId,
      owner,
    });
  }

  /** 処理開始前に親との対応を記録し、実行が終わった時に不要なら解放する。 */
  public async trackRun<T>(
    session: Pick<AuxiliarySession, "id" | "parentSessionId">,
    owner: object,
    run: () => Promise<T>,
  ): Promise<T> {
    // 受付処理は、プロバイダーや Session を初めて読み取る前にキャンセルを通知することがある。
    if (owner === this.options.getStorageOwner()) {
      this.parents.set(session.id, {
        parentSessionId: session.parentSessionId,
        owner,
      });
    }
    try {
      return await run();
    } finally {
      this.releaseIfUnused(session.id, owner);
    }
  }

  /** 指定世代が登録した対応だけを削除する。古い実行は後続世代の登録に触れない。 */
  public delete(sessionId: string, owner: object): void {
    if (this.parents.get(sessionId)?.owner === owner)
      this.parents.delete(sessionId);
  }

  /** 受付待ちとライブ実行が両方なくなった場合だけ、この世代の対応を取り除く。 */
  public releaseIfUnused(sessionId: string, owner: object): void {
    if (
      !this.options.isRunPending(sessionId) &&
      !this.options.hasLiveSessionRun(sessionId)
    ) {
      this.delete(sessionId, owner);
    }
  }

  /** 所有者の切り替えなどで保持した親との対応をすべて忘れる。 */
  public clear(): void {
    this.parents.clear();
  }

  /** 現世代に限り、親との対応を維持したまま状態を配送し、その後不要な対応を解放する。 */
  public publish(
    sessionId: string,
    state: LiveSessionRunState | null,
    owner: object | null,
  ): void {
    if (owner !== this.options.getStorageOwner()) return;
    // 親との関連付けを解放する前に、終了を示す null の配送先を解決して通知する。
    this.options.broadcastLiveSessionRun(sessionId, state);
    if (owner) this.releaseIfUnused(sessionId, owner);
  }
}
