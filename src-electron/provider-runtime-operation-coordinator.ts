export type ProviderRuntimeOperation<T> = () => T | Promise<T>;

export type RunProviderRuntimeOperationExclusive = <T>(
  operation: ProviderRuntimeOperation<T>,
) => Promise<T>;

export class ProviderRuntimeOperationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: ProviderRuntimeOperation<T>): Promise<T> {
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
