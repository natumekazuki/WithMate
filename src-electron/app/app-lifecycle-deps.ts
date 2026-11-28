import type { AppLifecycleService } from "./app-lifecycle-service.js";

/** Main のアプリイベント、ウィンドウ操作、永続ストアの後処理をサービスに渡すための接続口。 */
type CreateAppLifecycleDepsArgs = {
  /** ウィンドウを閉じても維持すべき Session 実行があるか調べる。 */
  hasInFlightSessionRuns(): boolean;
  /** 実行中でも終了することがすでに許可されたか調べる。 */
  getAllowQuitWithInFlightRuns(): boolean;
  /** 終了確認で得た許可を保存し、下書き保存が失敗した試行では取り消す。 */
  setAllowQuitWithInFlightRuns(value: boolean): void;
  /** Home を開き、起動やウィンドウ消失から戻れるようにする。 */
  createHomeWindow(): Promise<void>;
  /** Electron にアプリ終了を要求する。 */
  quitApp(): void;
  /** 実行がなく最後のウィンドウが閉じた場合の終了方針を返す。 */
  shouldQuitWhenAllWindowsClosed(): boolean;
  /** Session が実行中でも終了してよいかユーザーに確認する。 */
  confirmQuitWhileRunning(): boolean;
  /** 次回起動で使う、終了直前の Session ウィンドウの状態を保存する。 */
  prepareSessionWindowSnapshotForQuit?(): Promise<void>;
  /** 終了前に各ウィンドウの下書きを保存し、失敗時は false を返す。 */
  flushSessionWindowDrafts?(): Promise<boolean>;
  /** Agent の共有ランタイムを停止し、ストアを閉じる前に完了を待てるようにする。 */
  stopAgentRuntime?(): Promise<void>;
  /** ランタイムの停止後、永続ストアを閉じる。 */
  closePersistentStores(): void | Promise<void>;
  /** 終了時に、プロバイダーが保持する全 Session のスレッドを無効化する。 */
  invalidateAllProviderSessionThreads?(): Promise<void>;
  /** 終了時に、発行済みの Agent ランタイムの紐付けをすべて失効させる。 */
  revokeAllAgentRuntimeBindings?(): void;
};

/** 未指定の後処理を追加せず、Main の操作をライフサイクルサービスに接続する。 */
export function createAppLifecycleDeps(
  args: CreateAppLifecycleDepsArgs,
): ConstructorParameters<typeof AppLifecycleService>[0] {
  return {
    hasInFlightSessionRuns: args.hasInFlightSessionRuns,
    getAllowQuitWithInFlightRuns: args.getAllowQuitWithInFlightRuns,
    setAllowQuitWithInFlightRuns: args.setAllowQuitWithInFlightRuns,
    createHomeWindow: args.createHomeWindow,
    quitApp: args.quitApp,
    shouldQuitWhenAllWindowsClosed: args.shouldQuitWhenAllWindowsClosed,
    confirmQuitWhileRunning: args.confirmQuitWhileRunning,
    ...(args.prepareSessionWindowSnapshotForQuit
      ? {
          prepareSessionWindowSnapshotForQuit:
            args.prepareSessionWindowSnapshotForQuit,
        }
      : {}),
    ...(args.flushSessionWindowDrafts
      ? { flushSessionWindowDrafts: args.flushSessionWindowDrafts }
      : {}),
    ...(args.stopAgentRuntime
      ? { stopAgentRuntime: args.stopAgentRuntime }
      : {}),
    closePersistentStores: args.closePersistentStores,
    ...(args.invalidateAllProviderSessionThreads
      ? {
          invalidateAllProviderSessionThreads:
            args.invalidateAllProviderSessionThreads,
        }
      : {}),
    ...(args.revokeAllAgentRuntimeBindings
      ? { revokeAllAgentRuntimeBindings: args.revokeAllAgentRuntimeBindings }
      : {}),
  };
}
