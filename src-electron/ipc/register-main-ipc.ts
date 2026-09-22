import type { IpcMain } from "electron";

import { registerAuxiliaryHandlers } from "./auxiliary.js";
import { registerCatalogHandlers } from "./catalog.js";
import { registerCharacterHandlers } from "./character.js";
import type {
  IpcHandleRegistrar,
  MainIpcRegistrationDeps,
} from "./contracts.js";
import { registerMateHandlers } from "./mate.js";
import { registerPromptTemplateHandlers } from "./prompt-template.js";
import { registerSessionQueryHandlers } from "./session-query.js";
import { registerSessionRuntimeHandlers } from "./session-runtime.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerWindowHandlers } from "./window.js";

import {
  WITHMATE_RENDERER_LOG_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import {
  normalizeSessionTurnCorrelation,
  type RunSessionTurnRequest,
} from "../../src-shared/session/runtime-state.js";

/** Connects feature-owned IPC assemblies to Electron's single registration surface. */
export function registerMainIpcHandlers(
  ipcMain: IpcMain,
  deps: MainIpcRegistrationDeps,
): void {
  const wrappedIpcMain = createErrorLoggingIpcMain(ipcMain, deps.common);

  registerWindowHandlers(wrappedIpcMain, deps.window);
  registerAuxiliaryHandlers(wrappedIpcMain, deps.auxiliary);
  registerCatalogHandlers(wrappedIpcMain, deps.catalog);
  registerSettingsHandlers(wrappedIpcMain, deps.settings);
  registerPromptTemplateHandlers(wrappedIpcMain, deps.promptTemplates);
  registerSessionQueryHandlers(wrappedIpcMain, deps.sessionQuery);
  registerSessionRuntimeHandlers(wrappedIpcMain, deps.sessionRuntime);
  registerMateHandlers(wrappedIpcMain, deps.mate);
  registerCharacterHandlers(wrappedIpcMain, deps.character);

  ipcMain.on(
    WITHMATE_RENDERER_LOG_CHANNEL,
    (event, input: RendererLogInput) => {
      const windowId = deps.common.resolveEventWindow(event)?.id;
      deps.common.reportRendererLog?.(input, windowId);
    },
  );
  ipcMain.on(
    WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL,
    (event, payload: { requestId: string; success: boolean }) => {
      deps.common.acknowledgeSessionDraftFlush(event, payload);
    },
  );
}

function createErrorLoggingIpcMain(
  ipcMain: IpcMain,
  deps: Pick<MainIpcRegistrationDeps["common"], "logIpcError">,
): IpcHandleRegistrar {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        const startedAt = Date.now();
        try {
          return await handler(event, ...args);
        } catch (error) {
          const clientRequestId =
            channel === WITHMATE_RUN_SESSION_TURN_CHANNEL
              ? (normalizeSessionTurnCorrelation(
                  args[1] as RunSessionTurnRequest,
                ).clientRequestId ?? undefined)
              : undefined;
          deps.logIpcError?.({
            channel,
            durationMs: Date.now() - startedAt,
            error,
            clientRequestId,
          });
          throw error;
        }
      });
    },
  };
}
