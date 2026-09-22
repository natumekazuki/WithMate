import type { WithMateWindowObservabilityApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeOpenSessionWindowIdsPageResult,
  OPEN_SESSION_WINDOW_IDS_PAGE_MAX,
} from "../../src-shared/window/withmate-window-types.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import type { IpcRendererLike } from "./ipc.js";

async function listAllOpenSessionWindowIds(
  ipcRenderer: IpcRendererLike,
): Promise<string[]> {
  const sessionIds: string[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = normalizeOpenSessionWindowIdsPageResult(
      await ipcRenderer.invoke(
        channels.WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
        { cursor, limit: OPEN_SESSION_WINDOW_IDS_PAGE_MAX },
      ),
    );
    if (!page)
      throw new Error("open Session Window ID page response が不正です。");
    sessionIds.push(...page.sessionIds);
    if (!page.hasMore) return Array.from(new Set(sessionIds));
    if (page.nextCursor === null || page.nextCursor === cursor)
      throw new Error("open Session Window ID page cursor が進まないよ。");
    cursor = page.nextCursor;
  }
}

export function reportRendererLog(
  ipcRenderer: IpcRendererLike,
  input: RendererLogInput,
): void {
  ipcRenderer.send(channels.WITHMATE_RENDERER_LOG_CHANNEL, input);
}

export function createObservabilityApi(
  ipcRenderer: IpcRendererLike,
): Pick<
  WithMateWindowObservabilityApi,
  | "reportRendererLog"
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "getSessionBackgroundActivity"
  | "listOpenSessionWindowIds"
> {
  return {
    reportRendererLog(input) {
      reportRendererLog(ipcRenderer, input);
    },
    getProviderQuotaTelemetry(providerId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
        providerId,
      );
    },
    getSessionContextTelemetry(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
        sessionId,
      );
    },
    getSessionBackgroundActivity(sessionId, kind) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
        sessionId,
        kind,
      );
    },
    listOpenSessionWindowIds() {
      return listAllOpenSessionWindowIds(ipcRenderer);
    },
  };
}
