type BeforeQuitEventLike = {
  preventDefault(): void;
};

type AppLifecycleServiceDeps = {
  hasInFlightSessionRuns(): boolean;
  getAllowQuitWithInFlightRuns(): boolean;
  setAllowQuitWithInFlightRuns(value: boolean): void;
  createHomeWindow(): Promise<void>;
  quitApp(): void;
  shouldQuitWhenAllWindowsClosed(): boolean;
  confirmQuitWhileRunning(): boolean;
  prepareSessionWindowSnapshotForQuit?(): Promise<void>;
  closePersistentStores(): void;
  invalidateAllProviderSessionThreads?(): Promise<void>;
  revokeAllAgentRuntimeBindings?(): void;
};

export class AppLifecycleService {
  private quitCleanupCompleted = false;
  private quitCleanupPromise: Promise<void> | null = null;

  constructor(private readonly deps: AppLifecycleServiceDeps) {}

  async handleActivate(): Promise<void> {
    await this.deps.createHomeWindow();
  }

  async handleSecondInstance(): Promise<void> {
    await this.deps.createHomeWindow();
  }

  handleWindowAllClosed(): void {
    if (this.deps.hasInFlightSessionRuns()) {
      void this.deps.createHomeWindow();
      return;
    }

    if (this.deps.shouldQuitWhenAllWindowsClosed()) {
      this.deps.quitApp();
    }
  }

  handleBeforeQuit(event: BeforeQuitEventLike): Promise<void> {
    if (this.quitCleanupCompleted) {
      return Promise.resolve();
    }

    if (this.deps.hasInFlightSessionRuns() && !this.deps.getAllowQuitWithInFlightRuns()) {
      event.preventDefault();

      if (!this.deps.confirmQuitWhileRunning()) {
        return Promise.resolve();
      }

      this.deps.setAllowQuitWithInFlightRuns(true);
    }

    event.preventDefault();
    if (!this.quitCleanupPromise) {
      this.quitCleanupPromise = (async () => {
        try {
          if (this.deps.prepareSessionWindowSnapshotForQuit) {
            await this.deps.prepareSessionWindowSnapshotForQuit();
          }
        } catch {
          // Remaining cleanup must still run if the best-effort snapshot fails.
        }
        try {
          await this.deps.invalidateAllProviderSessionThreads?.();
        } catch {
          // Remaining cleanup must still run if provider cleanup fails.
        }
        try {
          this.deps.revokeAllAgentRuntimeBindings?.();
        } catch {
          // Persistent stores and application shutdown must still complete if revocation fails.
        }
        try {
          this.deps.closePersistentStores();
        } catch {
          // Electron quit must still settle if persistent store close fails.
        } finally {
          this.quitCleanupCompleted = true;
          this.deps.quitApp();
        }
      })();
    }
    return this.quitCleanupPromise;
  }
}
