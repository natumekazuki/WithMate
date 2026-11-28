/** Character のワークスペースを使い、同期でも非同期でも結果を返せる処理。 */
export type CharacterWorkspaceOperation<T> = () => T | Promise<T>;

/** 指定した Character キーの先行操作を待ってから、ワークスペース操作を実行する関数。 */
export type RunCharacterWorkspaceOperationExclusive = <T>(
  characterId: string,
  operation: CharacterWorkspaceOperation<T>,
) => Promise<T>;

/** 同じ Character のワークスペースを読み書きし得る処理を直列化する。 */
export class CharacterWorkspaceOperationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private operationCount = 0;
  private maintenanceRequested = false;
  private maintenanceDrain: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;

  /** 同じキーの操作を直列化し、異なるキーは並行できるようにする。メンテナンスが始まった後は新たな受付を拒否する。 */
  async runExclusive<T>(
    characterId: string,
    operation: CharacterWorkspaceOperation<T>,
  ): Promise<T> {
    if (this.maintenanceRequested) {
      throw new Error(
        "Character workspace maintenance is already running. Try again later.",
      );
    }
    this.operationCount += 1;
    const previous = this.tails.get(characterId) ?? Promise.resolve();
    /** この操作が終わったことを、同じキーの次の待機処理へ伝える。 */
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(characterId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(characterId) === current) {
        this.tails.delete(characterId);
      }
      this.operationCount -= 1;
      if (this.maintenanceRequested && this.operationCount === 0) {
        this.maintenanceDrain?.resolve();
      }
    }
  }

  /** 新しい操作を止め、受付済み操作がすべて終わってからメンテナンスを実行し、成否を問わず受付を再開する。 */
  async runMaintenance<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.maintenanceRequested) {
      throw new Error("Character workspace maintenance is already running.");
    }
    this.maintenanceRequested = true;
    if (this.operationCount > 0) {
      let resolveDrain!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      this.maintenanceDrain = { promise, resolve: resolveDrain };
      await promise;
    }
    try {
      return await operation();
    } finally {
      this.maintenanceDrain = null;
      this.maintenanceRequested = false;
    }
  }
}
