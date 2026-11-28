import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** Electron の preload が公開した Window API を返す。ウィンドウやブリッジがなければ null。 */
export function getWithMateApi(): WithMateWindowApi | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.withmate ?? null;
}

/** 実行環境を、renderer から実際に利用できる WithMate API の有無で判定する。 */
export function isDesktopRuntime(): boolean {
  return getWithMateApi() !== null;
}

/** ブリッジがある場合だけコールバックを実行し、利用できない場合は null を返す。 */
export function withWithMateApi<T>(
  run: (api: WithMateWindowApi) => T,
): T | null {
  const api = getWithMateApi();
  if (!api) {
    return null;
  }

  return run(api);
}
