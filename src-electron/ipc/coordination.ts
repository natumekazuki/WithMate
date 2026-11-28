import type { BrowserWindow } from "electron";
import {
  coordinationRequestSchema,
  coordinationIdentitySchema,
  type CoordinationIdentity,
  type CoordinationRequest,
} from "../../src-shared/coordination/coordination-contract.js";
import {
  coordinationStatusRequestSchema,
  openCoordinationRequestSchema,
  type CoordinationStatus,
  type OpenCoordinationRequest,
  type CoordinationDisplayIdentity,
} from "../../src-shared/coordination/coordination-window-contract.js";
import type { CoordinationApplicationService } from "../coordination/coordination-application-service.js";
import type { IpcHandleRegistrar } from "./contracts.js";
import { isCoordinationDeletedError } from "../coordination/coordination-errors.js";

/** 信頼されたウィンドウに Coordination の照会・実行・遷移を登録する。削除済みの状態照会・実行はエラー DTO を返し、ほかの失敗は伝播する。 */
export function registerCoordinationHandlers(
  ipc: IpcHandleRegistrar,
  deps: {
    service: CoordinationApplicationService;
    /** IPC の送信元に対応するウィンドウを解決する。対応がなければ `null` を返す。 */
    resolveWindow(sender: Electron.WebContents): BrowserWindow | null;
    /** 送信元や変更通知先として許されるウィンドウかを判定する。 */
    isTrustedWindow(window: BrowserWindow): boolean;
    /** 変更通知を配信するウィンドウの候補を列挙する。 */
    allWindows(): BrowserWindow[];
    /** 操作と対象に対してウィンドウに権限がなければ拒否する。 */
    authorizeRequest(
      window: BrowserWindow,
      request: CoordinationRequest,
    ): Promise<void>;
    /** 整形済みの遷移要求に対応する Session ウィンドウを開く。 */
    open(request: OpenCoordinationRequest): Promise<BrowserWindow>;
    /** 識別情報を表示用に解決し、解決できなければ `null` を返す。 */
    resolveIdentity(
      identity: CoordinationIdentity,
    ): Promise<CoordinationDisplayIdentity | null>;
    /** 対象の保存済み状態を読み取る。 */
    readStatus(id: string): Promise<CoordinationStatus>;
  },
) {
  const navigation = new Map<number, OpenCoordinationRequest>();
  /** 存続する信頼済みウィンドウのメインフレームからの呼び出しだけを認める。 */
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    const window = deps.resolveWindow(event.sender);
    if (
      !window ||
      window.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !deps.isTrustedWindow(window)
    )
      throw new Error("Invalid Coordination window sender.");
    return window;
  };
  ipc.handle("withmate:coordination:identity", async (event, raw) => {
    authorize(event);
    const identity = coordinationIdentitySchema.parse(raw);
    const result = await deps.resolveIdentity(identity);
    authorize(event);
    return result;
  });
  ipc.handle("withmate:coordination:status", async (event, raw) => {
    const window = authorize(event);
    const { id } = coordinationStatusRequestSchema.parse(raw);
    try {
      await deps.authorizeRequest(window, { operation: "get", id });
      authorize(event);
      const result = await deps.readStatus(id);
      authorize(event);
      return result;
    } catch (error) {
      if (!isCoordinationDeletedError(error)) throw error;
      authorize(event);
      return { error: { code: error.code, message: error.message } };
    }
  });
  ipc.handle("withmate:coordination:execute", async (event, raw) => {
    const window = authorize(event);
    const request = coordinationRequestSchema.parse(raw);
    try {
      await deps.authorizeRequest(window, request);
      return await deps.service.executeUser(
        request,
        () =>
          !window.isDestroyed() &&
          deps.isTrustedWindow(window) &&
          event.senderFrame === event.sender.mainFrame,
      );
    } catch (error) {
      if (!isCoordinationDeletedError(error)) throw error;
      return { error: { code: error.code, message: error.message } };
    }
  });
  ipc.handle("withmate:coordination:open", async (event, raw) => {
    authorize(event);
    const request = openCoordinationRequestSchema.parse(raw);
    const window = await deps.open(request);
    if (window.isDestroyed())
      throw new Error("The target Session window is no longer available.");
    const id = window.webContents.id;
    if (!navigation.has(id))
      window.webContents.once("destroyed", () => navigation.delete(id));
    navigation.set(id, request);
    window.webContents.send("withmate:coordination:navigate", request);
  });
  ipc.handle("withmate:coordination:pending-navigation", (event) => {
    const id = authorize(event).webContents.id;
    const request = navigation.get(id) ?? null;
    navigation.delete(id);
    return request;
  });
  ipc.handle("withmate:coordination:ack-navigation", (event, raw) => {
    const id = authorize(event).webContents.id;
    const request = openCoordinationRequestSchema.parse(raw);
    if (JSON.stringify(navigation.get(id)) === JSON.stringify(request))
      navigation.delete(id);
  });
  deps.service.subscribe(({ id, crewRootSessionId, initiator }) => {
    const summary = { id, crewRootSessionId, initiator };
    for (const window of deps.allWindows())
      if (!window.isDestroyed() && deps.isTrustedWindow(window))
        window.webContents.send("withmate:coordination:changed", summary);
  });
}
