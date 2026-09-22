import type {
  WithMateWindowApi,
  WithMateWindowSubscriptionApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeAuxiliarySessionNavigationPayload,
  normalizeAuxiliarySessionSelectionPayload,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
  OPEN_SESSION_WINDOW_IDS_PAGE_MAX,
} from "../../src-shared/window/withmate-window-types.js";
import { normalizeSessionWindowRestoreIds } from "../../src-shared/window/session-window-restore.js";
import { normalizeSessionSummaryInvalidation } from "../../src-shared/session/session-summary-invalidation.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

type ModelCatalogChangedPayload = Awaited<
  ReturnType<WithMateWindowApi["getModelCatalog"]>
>;
type LiveSessionRunPayload = {
  sessionId: string;
  state: Awaited<ReturnType<WithMateWindowApi["getLiveSessionRun"]>>;
};
type ProviderQuotaTelemetryPayload = {
  providerId: string;
  telemetry: Awaited<
    ReturnType<WithMateWindowApi["getProviderQuotaTelemetry"]>
  >;
};
type SessionContextTelemetryPayload = {
  sessionId: string;
  telemetry: Awaited<
    ReturnType<WithMateWindowApi["getSessionContextTelemetry"]>
  >;
};
type SessionBackgroundActivityPayload = {
  sessionId: string;
  kind: Parameters<WithMateWindowApi["getSessionBackgroundActivity"]>[1];
  state: Awaited<ReturnType<WithMateWindowApi["getSessionBackgroundActivity"]>>;
};

export function createSubscriptionApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowSubscriptionApi {
  return {
    subscribeSessionDraftFlushRequest(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
        listener,
      );
    },
    subscribeSessionDraftFlushRelease(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
        listener,
      );
    },
    acknowledgeSessionDraftFlush(requestId, success) {
      ipcRenderer.send(channels.WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL, {
        requestId,
        success,
      });
    },
    getAppBootStatus() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_APP_BOOT_STATUS_CHANNEL);
    },
    subscribeAppBootStatus(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_APP_BOOT_STATUS_EVENT,
        listener,
      );
    },
    subscribeSessionFilePreviewNavigation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
        listener,
      );
    },
    subscribeAuxiliarySessionNavigation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
        (payload: unknown) => {
          const normalized =
            normalizeAuxiliarySessionNavigationPayload(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    subscribeSessionInvalidation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSIONS_INVALIDATED_EVENT,
        (payload: unknown) => {
          const normalized = normalizeSessionSummaryInvalidation(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    subscribeModelCatalog(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
        (catalog: ModelCatalogChangedPayload) => {
          if (catalog) listener(catalog);
        },
      );
    },
    subscribeAppSettings(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_APP_SETTINGS_CHANGED_EVENT,
        listener,
      );
    },
    subscribeLiveSessionRun(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_LIVE_SESSION_RUN_EVENT,
        (payload: LiveSessionRunPayload) =>
          listener(payload.sessionId, payload.state ?? null),
      );
    },
    subscribeAuxiliarySessionSelection(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_AUXILIARY_SESSION_SELECTION_EVENT,
        (payload: unknown) => {
          const normalized = normalizeAuxiliarySessionSelectionPayload(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    subscribeProviderQuotaTelemetry(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
        (payload: ProviderQuotaTelemetryPayload) =>
          listener(payload.providerId, payload.telemetry ?? null),
      );
    },
    subscribeSessionContextTelemetry(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
        (payload: SessionContextTelemetryPayload) =>
          listener(payload.sessionId, payload.telemetry ?? null),
      );
    },
    subscribeSessionBackgroundActivity(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
        (payload: SessionBackgroundActivityPayload) =>
          listener(payload.sessionId, payload.kind, payload.state ?? null),
      );
    },
    subscribeSessionGlossary(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
        listener,
      );
    },
    subscribeOpenSessionWindowIds(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
        (payload: unknown) => {
          const normalized =
            normalizeOpenSessionWindowIdsChangedPayload(payload);
          if (!normalized) return;
          if (normalized.scope === "ids") {
            listener(normalized.sessionIds);
            return;
          }
          void listAllOpenSessionWindowIds(ipcRenderer).then(listener);
        },
      );
    },
    subscribeSessionWindowRestoreSet(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_WINDOW_RESTORE_SET_CHANGED_EVENT,
        (payload: unknown) => {
          const sessionIds = normalizeSessionWindowRestoreIds(payload);
          if (sessionIds) listener(sessionIds);
        },
      );
    },
  };
}

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
