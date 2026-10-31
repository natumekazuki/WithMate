import type { BrowserWindow } from "electron";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import { sessionGraphViewStateSchema, sessionGraphWindowOpenSchema } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { sessionGraphUiReadRequestSchemas } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import type { SessionGraphWindowService } from "../session-graph/session-graph-window-service.js";
import type { IpcHandleRegistrar } from "./contracts.js";
import type { SessionGraphReadOperation } from "../session-graph/session-graph-application-service.js";

export function registerSessionGraphWindowHandlers(ipc: IpcHandleRegistrar, deps: {
  service: SessionGraphWindowService<BrowserWindow>;
  resolveWindow(sender: Electron.WebContents): BrowserWindow | null;
  sessionWindow(sessionId: string): BrowserWindow | null;
  openReference(sessionId: string, target: string, guard: () => Promise<void>): Promise<unknown>;
}) {
  ipc.handle(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_CHANNEL, async (event, raw) => {
    const request = sessionGraphWindowOpenSchema.parse(raw);
    const window = deps.resolveWindow(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error("Invalid Graph window sender.");
    if (request.fromToken) {
      const entry = await deps.service.authorize(window, request.fromToken);
      return deps.service.open(entry.owner.sessionId, request.state, () => deps.service.isCurrent(request.fromToken!, window), entry);
    }
    const sessionId = request.sessionId!;
    if (deps.sessionWindow(sessionId) !== window) throw new Error("Only the owning Session can open a Graph window.");
    return deps.service.open(sessionId, request.state, () => deps.sessionWindow(sessionId) === window && !window.isDestroyed());
  });
  const sender = (event: Electron.IpcMainInvokeEvent) => {
    const window = deps.resolveWindow(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error("Invalid Graph window sender.");
    return window;
  };
  const token = (value: unknown): string => { if (typeof value !== "string" || !value) throw new TypeError("Invalid Graph token."); return value; };
  ipc.handle(channels.WITHMATE_GET_SESSION_GRAPH_WINDOW_PAYLOAD_CHANNEL, (event, value) => deps.service.payload(sender(event), token(value)));
  ipc.handle(channels.WITHMATE_READ_SESSION_GRAPH_WINDOW_CHANNEL, (event, value, operation, request) => {
    if (typeof operation !== "string" || !Object.hasOwn(sessionGraphUiReadRequestSchemas, operation)) throw new TypeError("Invalid Graph read operation.");
    return deps.service.read(sender(event), token(value), operation as SessionGraphReadOperation, request);
  });
  ipc.handle(channels.WITHMATE_UPDATE_SESSION_GRAPH_WINDOW_STATE_CHANNEL, (event, value, state) => deps.service.update(sender(event), token(value), sessionGraphViewStateSchema.parse(state)));
  ipc.handle(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_REFERENCE_CHANNEL, async (event, value, target) => {
    const window = sender(event); const id = token(value);
    if (typeof target !== "string" || !target || target.length > 8192) throw new TypeError("Invalid Graph reference.");
    const entry = await deps.service.authorize(window, id);
    const guard = async () => { await deps.service.authorize(window, id); };
    const result = await deps.openReference(entry.owner.sessionId, target, guard);
    await guard(); return result;
  });
}
