import type { IpcMainInvokeEvent } from "electron";
import {
  WITHMATE_LIST_HOME_CREW_PAGE_CHANNEL,
  WITHMATE_SHOW_HOME_CREW_CONTEXT_MENU_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { HomeCrewContextMenuRequest } from "../../src-shared/window/home-crew-types.js";
import { parseSessionMonitorContextMenuRequest } from "../../src-shared/window/withmate-window-types.js";
import { parseHomeCrewPageRequest } from "../session/home-crew-query.js";
import type { IpcHandleRegistrar, MainIpcWindowDeps } from "./contracts.js";

/** 余分なキーや空白だけの incarnation ID を拒否し、Session ID と座標は Monitor と同じ入力規則で検証する。 */
function parseContextMenuRequest(input: unknown): HomeCrewContextMenuRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Invalid Home Crew context menu request.");
  const { sessionId, incarnationId, point, ...extra } = input as Record<
    string,
    unknown
  >;
  if (
    Object.keys(extra).length ||
    typeof incarnationId !== "string" ||
    !incarnationId.trim()
  ) {
    throw new TypeError("Invalid Home Crew context menu request.");
  }
  const parsed = parseSessionMonitorContextMenuRequest({
    kind: "agent",
    sessionId,
    point,
  });
  return { sessionId: parsed.sessionId, incarnationId, point: parsed.point };
}

/** Home Crew のページ照会とコンテキストメニューを Home のメインフレームに公開する。 */
export function registerHomeCrewHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: Pick<
    MainIpcWindowDeps,
    | "resolveEventWindow"
    | "resolveHomeWindow"
    | "listHomeCrewPage"
    | "showHomeCrewContextMenu"
  >,
): void {
  /** 送信元が現在の Home のメインフレームでなければ IPC を拒否する。 */
  const requireHome = (event: IpcMainInvokeEvent) => {
    const window = deps.resolveEventWindow(event);
    if (
      !window ||
      window.isDestroyed() ||
      window !== deps.resolveHomeWindow() ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error(
        "Home Crew IPC is only available from the Home main frame.",
      );
    }
    return window;
  };
  ipcMain.handle(
    WITHMATE_LIST_HOME_CREW_PAGE_CHANNEL,
    (event, input: unknown) => {
      requireHome(event);
      return deps.listHomeCrewPage(parseHomeCrewPageRequest(input));
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_HOME_CREW_CONTEXT_MENU_CHANNEL,
    (event, input: unknown) => {
      const home = requireHome(event);
      return deps.showHomeCrewContextMenu(home, parseContextMenuRequest(input));
    },
  );
}
