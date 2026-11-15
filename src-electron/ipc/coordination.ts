import type { BrowserWindow } from "electron";
import {
  coordinationRequestSchema,
  coordinationIdentitySchema,
  type CoordinationIdentity,
  type CoordinationRequest,
} from "../../src-shared/coordination/coordination-contract.js";
import {
  openCoordinationRequestSchema,
  type OpenCoordinationRequest,
  type CoordinationDisplayIdentity,
} from "../../src-shared/coordination/coordination-window-contract.js";
import type { CoordinationApplicationService } from "../coordination/coordination-application-service.js";
import type { IpcHandleRegistrar } from "./contracts.js";
import { isCoordinationDeletedError } from "../coordination/coordination-errors.js";

export function registerCoordinationHandlers(
  ipc: IpcHandleRegistrar,
  deps: {
    service: CoordinationApplicationService;
    resolveWindow(sender: Electron.WebContents): BrowserWindow | null;
    isTrustedWindow(window: BrowserWindow): boolean;
    allWindows(): BrowserWindow[];
    authorizeRequest(
      window: BrowserWindow,
      request: CoordinationRequest,
    ): Promise<void>;
    open(request: OpenCoordinationRequest): Promise<BrowserWindow>;
    resolveIdentity(identity: CoordinationIdentity): Promise<CoordinationDisplayIdentity | null>;
  },
) {
  const navigation = new Map<number, OpenCoordinationRequest>();
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
