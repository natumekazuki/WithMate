import type { AppLifecycleService } from "./app-lifecycle-service.js";

type CreateAppLifecycleDepsArgs = {
  hasInFlightSessionRuns(): boolean;
  getAllowQuitWithInFlightRuns(): boolean;
  setAllowQuitWithInFlightRuns(value: boolean): void;
  createHomeWindow(): Promise<void>;
  quitApp(): void;
  shouldQuitWhenAllWindowsClosed(): boolean;
  confirmQuitWhileRunning(): boolean;
  closePersistentStores(): void;
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
    closePersistentStores: args.closePersistentStores,
  };
}
