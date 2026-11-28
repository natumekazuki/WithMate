import type { WithMateWindowObservabilityApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeOpenSessionWindowIdsPageResult,
  OPEN_SESSION_WINDOW_IDS_PAGE_MAX,
} from "../../src-shared/window/withmate-window-types.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import type { IpcRendererLike } from "./ipc.js";

/** Main が返すページを検証しながら開いている Session の ID を集める。カーソルが進まない異常は失敗として扱う。 */
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
    if (!page) throw new Error("Invalid open Session Window ID page response.");
    sessionIds.push(...page.sessionIds);
    if (!page.hasMore) return Array.from(new Set(sessionIds));
    if (page.nextCursor === null || page.nextCursor === cursor)
      throw new Error(
        "The open Session Window ID page cursor did not advance.",
      );
    cursor = page.nextCursor;
  }
}

/** renderer のログ入力を応答不要の IPC で Main へ送る。 */
export function reportRendererLog(
  ipcRenderer: IpcRendererLike,
  input: RendererLogInput,
): void {
  ipcRenderer.send(channels.WITHMATE_RENDERER_LOG_CHANNEL, input);
}

/** renderer に診断ログ送信と、実行状況に関する読み取り専用の窓口を公開する。 */
export function createObservabilityApi(
  ipcRenderer: IpcRendererLike,
): Pick<
  WithMateWindowObservabilityApi,
  | "reportRendererLog"
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "listOpenSessionWindowIds"
> {
  return {
    /** renderer が作った診断イベントを共通の送信処理へ渡す。 */
    reportRendererLog(input) {
      reportRendererLog(ipcRenderer, input);
    },
    /** 指定したプロバイダーの利用枠の観測結果を、要求オプションとともに Main へ問い合わせる。 */
    getProviderQuotaTelemetry(providerId, options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
        providerId,
        options,
      );
    },
    /** 指定 Session の会話コンテキストの観測値を取得する。 */
    getSessionContextTelemetry(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
        sessionId,
      );
    },
    /** ページングを preload 内に閉じ、開いている Session ID の重複のない全体を返す。 */
    listOpenSessionWindowIds() {
      return listAllOpenSessionWindowIds(ipcRenderer);
    },
  };
}
