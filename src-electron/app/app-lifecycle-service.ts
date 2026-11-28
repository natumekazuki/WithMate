/** Electron の終了イベントのうち、既定の終了を保留するために必要な部分。 */
type BeforeQuitEventLike = {
  /** 下書き保存や後処理の完了まで、自動でアプリが終了しないようにする。 */
  preventDefault(): void;
};

/** アプリイベントから呼び出すウィンドウ操作と、終了前の保存・後処理。 */
type AppLifecycleServiceDeps = {
  /** Session 実行がまだ完了していないかを判定する。 */
  hasInFlightSessionRuns(): boolean;
  /** Session が実行中の時点で終了してよいか確認する。 */
  getAllowQuitWithInFlightRuns(): boolean;
  /** 実行中の終了許可を記録または取り消す。 */
  setAllowQuitWithInFlightRuns(value: boolean): void;
  /** アプリの Home ウィンドウを利用できるようにする。 */
  createHomeWindow(): Promise<void>;
  /** 後処理が終わったとき、またはウィンドウ全閉鎖時の方針に従って終了を要求する。 */
  quitApp(): void;
  /** 実行がないとき、ウィンドウ全閉鎖でアプリを終了するか返す。 */
  shouldQuitWhenAllWindowsClosed(): boolean;
  /** 実行中の終了に対するユーザーの確認結果を返す。 */
  confirmQuitWhileRunning(): boolean;
  /** 終了後の復元用スナップショットを保存する。失敗しても残る後処理は続く。 */
  prepareSessionWindowSnapshotForQuit?(): Promise<void>;
  /** Session ウィンドウの下書きを保存し、保存できなければ終了を保留させる。 */
  flushSessionWindowDrafts?(): Promise<boolean>;
  /** 発行済みのツール権限を失効させた後、Agent の共有ランタイムを停止する。 */
  stopAgentRuntime?(): Promise<void>;
  /** ランタイム停止を試みた後、終了前に永続ストアのクローズを待つ。 */
  closePersistentStores(): void | Promise<void>;
  /** アプリ終了前にプロバイダーの全 Session スレッドを無効化する。 */
  invalidateAllProviderSessionThreads?(): Promise<void>;
  /** 共有ランタイムの停止前に、発行済みの Agent ランタイムの紐付けを失効させる。 */
  revokeAllAgentRuntimeBindings?(): void;
};

/** アプリイベントから Home を開き、実行中の確認からストア解放までの終了手順を管理する。 */
export class AppLifecycleService {
  private quitCleanupCompleted = false;
  private quitCleanupPromise: Promise<void> | null = null;

  /** アプリイベントに対する操作を受け取り、終了処理の状態をこのインスタンスで持つ。 */
  constructor(private readonly deps: AppLifecycleServiceDeps) {}

  /** アプリの activate 通知を受けて Home を開く。 */
  async handleActivate(): Promise<void> {
    await this.deps.createHomeWindow();
  }

  /** 二重起動の通知を受け、既存アプリ側で Home を開く。 */
  async handleSecondInstance(): Promise<void> {
    await this.deps.createHomeWindow();
  }

  /** 実行中なら Home を開き直し、実行がなければ全閉鎖時の方針に従う。 */
  handleWindowAllClosed(): void {
    if (this.deps.hasInFlightSessionRuns()) {
      void this.deps.createHomeWindow();
      return;
    }

    if (this.deps.shouldQuitWhenAllWindowsClosed()) {
      this.deps.quitApp();
    }
  }

  /** 必要な確認と下書き保存が通るまで終了を止め、後処理が完了したら終了を再要求する。 */
  handleBeforeQuit(event: BeforeQuitEventLike): Promise<void> {
    if (this.quitCleanupCompleted) {
      return Promise.resolve();
    }

    let allowQuitWasSetForThisAttempt = false;
    if (
      this.deps.hasInFlightSessionRuns() &&
      !this.deps.getAllowQuitWithInFlightRuns()
    ) {
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
