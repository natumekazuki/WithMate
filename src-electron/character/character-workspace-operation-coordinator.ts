export type CharacterWorkspaceOperation<T> = () => T | Promise<T>;

export type RunCharacterWorkspaceOperationExclusive = <T>(
  characterId: string,
  operation: CharacterWorkspaceOperation<T>,
) => Promise<T>;

/** Serializes operations that may read or write one Character workspace. */
export class CharacterWorkspaceOperationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private operationCount = 0;
  private maintenanceRequested = false;
  private maintenanceDrain: { promise: Promise<void>; resolve: () => void } | null = null;

  async runExclusive<T>(characterId: string, operation: CharacterWorkspaceOperation<T>): Promise<T> {
    if (this.maintenanceRequested) {
      throw new Error("Character workspace maintenance が実行中です。もう一度お試しください。");
    }
    this.operationCount += 1;
    const previous = this.tails.get(characterId) ?? Promise.resolve();
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

  async runMaintenance<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.maintenanceRequested) {
      throw new Error("Character workspace maintenance がすでに実行中です。");
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
