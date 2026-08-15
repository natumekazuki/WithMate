export type CharacterAffectTurnOwnershipOperation<T> = () => T | Promise<T>;

export type RunCharacterAffectTurnOwnershipExclusive = <T>(
  operation: CharacterAffectTurnOwnershipOperation<T>,
) => Promise<T>;

export class CharacterAffectTurnOwnershipCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: CharacterAffectTurnOwnershipOperation<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
