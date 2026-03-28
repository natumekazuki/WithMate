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
  closePersistentStores(): void;
};

export class AppLifecycleService {
  constructor(private readonly deps: AppLifecycleServiceDeps) {}

  async handleActivate(): Promise<void> {
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

  handleBeforeQuit(event: BeforeQuitEventLike): void {
    if (this.deps.hasInFlightSessionRuns() && !this.deps.getAllowQuitWithInFlightRuns()) {
      event.preventDefault();

      if (!this.deps.confirmQuitWhileRunning()) {
        return;
      }

      this.deps.setAllowQuitWithInFlightRuns(true);
      this.deps.quitApp();
      return;
    }

    this.deps.closePersistentStores();
  }
}
