import type { WithMateWindowApi } from "./withmate-window-api.js";

export function getWithMateApi(): WithMateWindowApi | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.withmate ?? null;
}

export function isDesktopRuntime(): boolean {
  return getWithMateApi() !== null;
}

export function withWithMateApi<T>(run: (api: WithMateWindowApi) => T): T | null {
  const api = getWithMateApi();
  if (!api) {
    return null;
  }

  return run(api);
}
