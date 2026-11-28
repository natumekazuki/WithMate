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
  flushSessionWindowDrafts?(): Promise<boolean>;
  stopAgentRuntime?(): Promise<void>;
  closePersistentStores(): void | Promise<void>;
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

    let allowQuitWasSetForThisAttempt = false;
    if (this.deps.hasInFlightSessionRuns() && !this.deps.getAllowQuitWithInFlightRuns()) {
      event.preventDefault();

      if (!this.deps.confirmQuitWhileRunning()) {
        return Promise.resolve();
      }

      this.deps.setAllowQuitWithInFlightRuns(true);
      allowQuitWasSetForThisAttempt = true;
    }

    event.preventDefault();
    if (!this.quitCleanupPromise) {
      this.quitCleanupPromise = (async () => {
        if (this.deps.flushSessionWindowDrafts) {
          let flushed = false;
          try {
            flushed = await this.deps.flushSessionWindowDrafts();
          } catch {
            flushed = false;
          }
          if (!flushed) {
            if (allowQuitWasSetForThisAttempt) {
              this.deps.setAllowQuitWithInFlightRuns(false);
            }
            this.quitCleanupPromise = null;
            return;
          }
        }
        try {
          if (this.deps.prepareSessionWindowSnapshotForQuit) {
            await this.deps.prepareSessionWindowSnapshotForQuit();
          }
        } catch {
          // ベストエフォートのスナップショット保存が失敗しても、残りの後処理を続ける。
        }
        try {
          await this.deps.invalidateAllProviderSessionThreads?.();
        } catch {
          // プロバイダーの後処理が失敗しても、残りの後処理を続ける。
        }
        try {
          this.deps.revokeAllAgentRuntimeBindings?.();
        } catch {
          // 失効処理が失敗しても、ランタイムの後処理とアプリの終了を完了させる。
        }
        try {
          await this.deps.stopAgentRuntime?.();
        } catch {
          // ランタイムの後処理が失敗しても、永続ストアを閉じてアプリを終了する。
        }
        try {
          await this.deps.closePersistentStores();
        } catch {
          // 永続ストアを閉じられなくても、Electron の終了処理を完了させる。
        } finally {
          this.quitCleanupCompleted = true;
          this.deps.quitApp();
        }
      })();
    }
    return this.quitCleanupPromise;
  }
}
