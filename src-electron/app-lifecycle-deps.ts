import type { AppLifecycleService } from "./app-lifecycle-service.js";

type CreateAppLifecycleDepsArgs = {
  hasInFlightSessionRuns(): boolean;
  getAllowQuitWithInFlightRuns(): boolean;
  setAllowQuitWithInFlightRuns(value: boolean): void;
  createHomeWindow(): Promise<void>;
  quitApp(): void;
  shouldQuitWhenAllWindowsClosed(): boolean;
  confirmQuitWhileRunning(): boolean;
  shutdownSessionRuntime?(): Promise<void>;
  prepareSessionWindowSnapshotForQuit?(): Promise<void>;
  stopMemoryRuntime?(): Promise<void>;
  closePersistentStores(): void;
  invalidateAllProviderSessionThreads?(): Promise<void>;
  revokeAllAgentRuntimeBindings?(): void;
};

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
    ...(args.shutdownSessionRuntime
      ? { shutdownSessionRuntime: args.shutdownSessionRuntime }
      : {}),
    ...(args.prepareSessionWindowSnapshotForQuit
      ? { prepareSessionWindowSnapshotForQuit: args.prepareSessionWindowSnapshotForQuit }
      : {}),
    ...(args.stopMemoryRuntime ? { stopMemoryRuntime: args.stopMemoryRuntime } : {}),
    closePersistentStores: args.closePersistentStores,
    ...(args.invalidateAllProviderSessionThreads
      ? { invalidateAllProviderSessionThreads: args.invalidateAllProviderSessionThreads }
      : {}),
    ...(args.revokeAllAgentRuntimeBindings
      ? { revokeAllAgentRuntimeBindings: args.revokeAllAgentRuntimeBindings }
      : {}),
  };
}
