import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AuditLogDetailFragment,
  AuditLogDetailSection,
  AuditLogOperationDetailFragment,
  AuditLogSummary,
  LiveSessionRunState,
} from "./app-state.js";
import { summarizeAuditLogDetailFragment } from "./audit-log-detail-metrics.js";
import { buildAuditLogRefreshSignature, buildDisplayedAuditLogs } from "./audit-log-refresh.js";
import type { RendererLogInput } from "./app-log-types.js";
import type { Session } from "./session-state.js";
import type { WithMateWindowApi } from "./withmate-window-api.js";

type SessionOwnedAuditLogs = {
  ownerSessionId: string | null;
  entries: AuditLogSummary[];
  nextCursor: number | null;
  hasMore: boolean;
  total: number;
  loading: boolean;
  errorMessage: string | null;
};

type AuditLogDetailLoadState = {
  detail: AuditLogDetailFragment | null;
  loadedSections: Partial<Record<AuditLogDetailSection, boolean>>;
  loadingSections: Partial<Record<AuditLogDetailSection, boolean>>;
  loadingStartedAtMs: Partial<Record<AuditLogDetailSection, number>>;
  errorMessages: Partial<Record<AuditLogDetailSection, string>>;
};

type AuditLogOperationDetailLoadState = {
  detail: AuditLogOperationDetailFragment | null;
  loading: boolean;
  errorMessage: string | null;
};

type AuditLogSessionLike = Pick<
  Session,
  | "id"
  | "updatedAt"
  | "provider"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "threadId"
  | "runState"
  | "messages"
>;

type UseSessionAuditLogsInput = {
  withmateApi: WithMateWindowApi | null;
  selectedSession: AuditLogSessionLike | null;
  liveRun: LiveSessionRunState | null;
  enabled?: boolean;
  auditLogApi?: Pick<
    WithMateWindowApi,
    "listSessionAuditLogSummaryPage" | "getSessionAuditLogDetailSection" | "getSessionAuditLogOperationDetail"
  > | null;
};

const AUDIT_LOG_PAGE_LIMIT = 50;
const AUDIT_LOG_DETAIL_STALE_LOADING_MS = 10000;

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function isAuditLogDetailLoadingStale(
  state: AuditLogDetailLoadState,
  section: AuditLogDetailSection,
  currentTimeMs = nowMs(),
): boolean {
  const startedAtMs = state.loadingStartedAtMs[section];
  return typeof startedAtMs !== "number" || currentTimeMs - startedAtMs > AUDIT_LOG_DETAIL_STALE_LOADING_MS;
}

function reportAuditLogDetailLog(
  withmateApi: WithMateWindowApi | null,
  input: Omit<RendererLogInput, "level"> & { level?: RendererLogInput["level"] },
): void {
  try {
    withmateApi?.reportRendererLog({
      level: input.level ?? "debug",
      kind: input.kind,
      message: input.message,
      data: input.data,
      error: input.error,
    });
  } catch {
    // logging must not affect audit log UI
  }
}

function scheduleAuditLogDetailRenderProbe(
  withmateApi: WithMateWindowApi | null,
  input: {
    requestId: string;
    sessionId: string;
    auditLogId: number;
    section: AuditLogDetailSection;
    startedAtMs: number;
  },
): void {
  const schedule = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => {
        setTimeout(() => callback(nowMs()), 0);
        return 0;
      };

  schedule(() => {
    reportAuditLogDetailLog(withmateApi, {
      kind: "audit-log.detail.render-probe",
      message: "Audit log detail render probe reached",
      data: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        auditLogId: input.auditLogId,
        section: input.section,
        elapsedMs: Math.round(nowMs() - input.startedAtMs),
      },
    });
  });
}

function createEmptyAuditLogsState(ownerSessionId: string | null): SessionOwnedAuditLogs {
  return {
    ownerSessionId,
    entries: [],
    nextCursor: null,
    hasMore: false,
    total: 0,
    loading: false,
    errorMessage: null,
  };
}

export function useSessionAuditLogs({
  withmateApi,
  selectedSession,
  liveRun,
  enabled = true,
  auditLogApi = withmateApi,
}: UseSessionAuditLogsInput) {
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogsState, setAuditLogsState] = useState<SessionOwnedAuditLogs>(() => createEmptyAuditLogsState(null));
  const [auditLogDetails, setAuditLogDetails] = useState<Record<number, AuditLogDetailLoadState>>({});
  const [auditLogOperationDetails, setAuditLogOperationDetails] = useState<Record<string, AuditLogOperationDetailLoadState>>({});
  const auditLogDetailOwnerRef = useRef<string | null>(null);
  const selectedSessionId = selectedSession?.id ?? null;

  const persistedEntries = useMemo(
    () => (
      enabled && selectedSessionId !== null && auditLogsState.ownerSessionId === selectedSessionId
        ? auditLogsState.entries
        : []
    ),
    [auditLogsState.entries, auditLogsState.ownerSessionId, enabled, selectedSessionId],
  );

  const displayedEntries = useMemo(
    () =>
      buildDisplayedAuditLogs({
        selectedSession,
        persistedEntries,
        liveRun,
      }),
    [liveRun, persistedEntries, selectedSession],
  );

  const refreshSignature = useMemo(
    () =>
      buildAuditLogRefreshSignature({
        selectedSession,
        displayedMessagesLength: selectedSession?.messages.length ?? 0,
        selectedMemoryGenerationActivity: null,
        selectedCharacterMemoryGenerationActivity: null,
        selectedMonologueActivity: null,
      }),
    [selectedSession],
  );

  useEffect(() => {
    let active = true;

    if (!enabled || !auditLogsOpen || !auditLogApi || !selectedSession) {
      setAuditLogsState(createEmptyAuditLogsState(null));
      setAuditLogDetails({});
      setAuditLogOperationDetails({});
      auditLogDetailOwnerRef.current = null;
      return () => {
        active = false;
      };
    }

    setAuditLogsState((current) =>
      current.ownerSessionId === selectedSession.id
        ? { ...current, loading: true, errorMessage: null }
        : { ...createEmptyAuditLogsState(selectedSession.id), loading: true },
    );
    if (auditLogDetailOwnerRef.current !== selectedSession.id) {
      setAuditLogDetails({});
      setAuditLogOperationDetails({});
      auditLogDetailOwnerRef.current = selectedSession.id;
    }
    void auditLogApi.listSessionAuditLogSummaryPage(selectedSession.id, {
      cursor: 0,
      limit: AUDIT_LOG_PAGE_LIMIT,
    }).then(
      (page) => {
        if (active) {
          setAuditLogsState({
            ownerSessionId: selectedSession.id,
            entries: page.entries,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            total: page.total,
            loading: false,
            errorMessage: null,
          });
        }
      },
      (error: unknown) => {
        if (active) {
          setAuditLogsState((current) => ({
            ...current,
            ownerSessionId: selectedSession.id,
            loading: false,
            errorMessage: error instanceof Error ? error.message : "audit log summary の取得に失敗したよ。",
          }));
        }
      },
    );

    return () => {
      active = false;
    };
  }, [auditLogApi, auditLogsOpen, enabled, refreshSignature, selectedSessionId]);

  useEffect(() => {
    if (!auditLogsOpen) {
      return;
    }

    const clearStaleLoading = () => {
      const currentTimeMs = nowMs();
      const visibleIds = new Set(displayedEntries.map((entry) => entry.id));
      setAuditLogDetails((current) => {
        let changed = false;
        const next: Record<number, AuditLogDetailLoadState> = {};

        for (const [id, state] of Object.entries(current)) {
          const auditLogId = Number(id);
          if (!visibleIds.has(auditLogId)) {
            changed = true;
            continue;
          }

          const loadingSections = { ...state.loadingSections };
          const loadingStartedAtMs = { ...state.loadingStartedAtMs };
          for (const section of Object.keys(loadingSections) as AuditLogDetailSection[]) {
            if (loadingSections[section] && isAuditLogDetailLoadingStale(state, section, currentTimeMs)) {
              loadingSections[section] = false;
              delete loadingStartedAtMs[section];
              changed = true;
            }
          }

          next[auditLogId] = changed
            ? { ...state, loadingSections, loadingStartedAtMs }
            : state;
        }

        return changed ? next : current;
      });
    };

    clearStaleLoading();
    const intervalId = window.setInterval(clearStaleLoading, 2000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [auditLogsOpen, displayedEntries]);

  const handleLoadMoreAuditLogs = () => {
    if (!enabled || !auditLogsOpen || !auditLogApi || !selectedSessionId) {
      return;
    }

    const currentState = auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState : null;
    if (!currentState?.hasMore || currentState.loading || currentState.nextCursor === null) {
      return;
    }

    const ownerSessionId = selectedSessionId;
    const cursor = currentState.nextCursor;
    setAuditLogsState((current) =>
      current.ownerSessionId === ownerSessionId
        ? { ...current, loading: true, errorMessage: null }
        : current,
    );

    void auditLogApi.listSessionAuditLogSummaryPage(ownerSessionId, {
      cursor,
      limit: AUDIT_LOG_PAGE_LIMIT,
    }).then(
      (page) => {
        setAuditLogsState((current) => {
          if (current.ownerSessionId !== ownerSessionId) {
            return current;
          }

          const existingIds = new Set(current.entries.map((entry) => entry.id));
          const nextEntries = [
            ...current.entries,
            ...page.entries.filter((entry) => !existingIds.has(entry.id)),
          ];

          return {
            ownerSessionId,
            entries: nextEntries,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            total: page.total,
            loading: false,
            errorMessage: null,
          };
        });
      },
      (error: unknown) => {
        setAuditLogsState((current) =>
          current.ownerSessionId === ownerSessionId
            ? {
                ...current,
                loading: false,
                errorMessage: error instanceof Error ? error.message : "audit log summary の追加取得に失敗したよ。",
              }
            : current,
        );
      },
    );
  };

  const handleLoadAuditLogDetail = (entry: AuditLogSummary, section: AuditLogDetailSection) => {
    if (!enabled || !auditLogApi || !selectedSessionId || entry.id < 0 || !entry.detailAvailable) {
      return;
    }

    const requestId = `${entry.sessionId}:${entry.id}:${section}:${Date.now()}`;
    const startedAtMs = nowMs();
    let shouldLoad = false;
    setAuditLogDetails((current) => {
      const existing = current[entry.id];
      if (
        existing?.loadedSections[section]
        || (existing?.loadingSections[section] && !isAuditLogDetailLoadingStale(existing, section, startedAtMs))
      ) {
        return current;
      }

      shouldLoad = true;
      return {
        ...current,
        [entry.id]: {
          detail: existing?.detail ?? null,
          loadedSections: existing?.loadedSections ?? {},
          loadingSections: {
            ...existing?.loadingSections,
            [section]: true,
          },
          loadingStartedAtMs: {
            ...existing?.loadingStartedAtMs,
            [section]: startedAtMs,
          },
          errorMessages: {
            ...existing?.errorMessages,
            [section]: undefined,
          },
        },
      };
    });

    if (!shouldLoad) {
      return;
    }

    reportAuditLogDetailLog(withmateApi, {
      kind: "audit-log.detail.load-started",
      message: "Audit log detail load started",
      data: {
        requestId,
        sessionId: entry.sessionId,
        selectedSessionId,
        auditLogId: entry.id,
        section,
        phase: entry.phase,
        detailAvailable: entry.detailAvailable,
        summaryOperationCount: entry.operations.length,
        assistantTextPreviewChars: entry.assistantTextPreview.length,
      },
    });

    try {
      void auditLogApi.getSessionAuditLogDetailSection(entry.sessionId, entry.id, section).then(
        (fragment) => {
          const existingState = auditLogDetails[entry.id];
          reportAuditLogDetailLog(withmateApi, {
            kind: "audit-log.detail.ipc-completed",
            message: "Audit log detail IPC completed",
            data: {
              requestId,
              sessionId: entry.sessionId,
              selectedSessionId,
              auditLogId: entry.id,
              section,
              durationMs: Math.round(nowMs() - startedAtMs),
              metrics: summarizeAuditLogDetailFragment(fragment),
            },
          });
          setAuditLogDetails((current) => {
            const loadingStartedAtMs = { ...current[entry.id]?.loadingStartedAtMs };
            delete loadingStartedAtMs[section];
            return {
              ...current,
              [entry.id]: {
                detail: fragment ? { ...(current[entry.id]?.detail ?? existingState?.detail ?? {}), ...fragment } : current[entry.id]?.detail ?? existingState?.detail ?? null,
                loadedSections: {
                  ...current[entry.id]?.loadedSections,
                  [section]: fragment !== null,
                },
                loadingSections: {
                  ...current[entry.id]?.loadingSections,
                  [section]: false,
                },
                loadingStartedAtMs,
                errorMessages: {
                  ...current[entry.id]?.errorMessages,
                  [section]: fragment ? undefined : "audit log detail が見つからなかったよ。",
                },
              },
            };
          });
          scheduleAuditLogDetailRenderProbe(withmateApi, {
            requestId,
            sessionId: entry.sessionId,
            auditLogId: entry.id,
            section,
            startedAtMs,
          });
        },
        (error: unknown) => {
          reportAuditLogDetailLog(withmateApi, {
            level: "error",
            kind: "audit-log.detail.ipc-failed",
            message: "Audit log detail IPC failed",
            data: {
              requestId,
              sessionId: entry.sessionId,
              selectedSessionId,
              auditLogId: entry.id,
              section,
              durationMs: Math.round(nowMs() - startedAtMs),
            },
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: "audit log detail IPC failed" },
          });
          setAuditLogDetails((current) => {
            const loadingStartedAtMs = { ...current[entry.id]?.loadingStartedAtMs };
            delete loadingStartedAtMs[section];
            return {
              ...current,
              [entry.id]: {
                detail: current[entry.id]?.detail ?? null,
                loadedSections: current[entry.id]?.loadedSections ?? {},
                loadingSections: {
                  ...current[entry.id]?.loadingSections,
                  [section]: false,
                },
                loadingStartedAtMs,
                errorMessages: {
                  ...current[entry.id]?.errorMessages,
                  [section]: error instanceof Error ? error.message : "audit log detail の取得に失敗したよ。",
                },
              },
            };
          });
        },
      );
    } catch (error) {
      reportAuditLogDetailLog(withmateApi, {
        level: "error",
        kind: "audit-log.detail.load-threw",
        message: "Audit log detail load threw before IPC completion",
        data: {
          requestId,
          sessionId: entry.sessionId,
          selectedSessionId,
          auditLogId: entry.id,
          section,
          durationMs: Math.round(nowMs() - startedAtMs),
        },
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: "audit log detail load threw" },
      });
      setAuditLogDetails((current) => {
        const loadingStartedAtMs = { ...current[entry.id]?.loadingStartedAtMs };
        delete loadingStartedAtMs[section];
        return {
          ...current,
          [entry.id]: {
            detail: current[entry.id]?.detail ?? null,
            loadedSections: current[entry.id]?.loadedSections ?? {},
            loadingSections: {
              ...current[entry.id]?.loadingSections,
              [section]: false,
            },
            loadingStartedAtMs,
            errorMessages: {
              ...current[entry.id]?.errorMessages,
              [section]: error instanceof Error ? error.message : "audit log detail の取得に失敗したよ。",
            },
          },
        };
      });
    }
  };

  const handleLoadAuditLogOperationDetail = (entry: AuditLogSummary, operationIndex: number) => {
    if (!enabled || !auditLogApi || !selectedSessionId || entry.id < 0 || !entry.detailAvailable) {
      return;
    }

    const operationKey = `${entry.sessionId}:${entry.id}:operations:${operationIndex}`;
    let shouldLoad = false;
    setAuditLogOperationDetails((current) => {
      const existing = current[operationKey];
      if (existing?.loading || existing?.detail) {
        return current;
      }

      shouldLoad = true;
      return {
        ...current,
        [operationKey]: {
          detail: null,
          loading: true,
          errorMessage: null,
        },
      };
    });

    if (!shouldLoad) {
      return;
    }

    const requestId = `${entry.sessionId}:${entry.id}:operation:${operationIndex}:${Date.now()}`;
    const startedAtMs = nowMs();
    reportAuditLogDetailLog(withmateApi, {
      kind: "audit-log.operation-detail.load-started",
      message: "Audit log operation detail load started",
      data: {
        requestId,
        sessionId: entry.sessionId,
        selectedSessionId,
        auditLogId: entry.id,
        operationIndex,
      },
    });

    try {
      void auditLogApi.getSessionAuditLogOperationDetail(entry.sessionId, entry.id, operationIndex).then(
        (fragment) => {
          reportAuditLogDetailLog(withmateApi, {
            kind: "audit-log.operation-detail.ipc-completed",
            message: "Audit log operation detail IPC completed",
            data: {
              requestId,
              sessionId: entry.sessionId,
              selectedSessionId,
              auditLogId: entry.id,
              operationIndex,
              durationMs: Math.round(nowMs() - startedAtMs),
              detailsChars: fragment?.details.length ?? 0,
            },
          });
          setAuditLogOperationDetails((current) => ({
            ...current,
            [operationKey]: {
              detail: fragment,
              loading: false,
              errorMessage: fragment ? null : "operation detail が見つからなかったよ。",
            },
          }));
        },
        (error: unknown) => {
          reportAuditLogDetailLog(withmateApi, {
            level: "error",
            kind: "audit-log.operation-detail.ipc-failed",
            message: "Audit log operation detail IPC failed",
            data: {
              requestId,
              sessionId: entry.sessionId,
              selectedSessionId,
              auditLogId: entry.id,
              operationIndex,
              durationMs: Math.round(nowMs() - startedAtMs),
            },
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: "audit log operation detail IPC failed" },
          });
          setAuditLogOperationDetails((current) => ({
            ...current,
            [operationKey]: {
              detail: null,
              loading: false,
              errorMessage: error instanceof Error ? error.message : "operation detail の取得に失敗したよ。",
            },
          }));
        },
      );
    } catch (error) {
      reportAuditLogDetailLog(withmateApi, {
        level: "error",
        kind: "audit-log.operation-detail.load-threw",
        message: "Audit log operation detail load threw before IPC completion",
        data: {
          requestId,
          sessionId: entry.sessionId,
          selectedSessionId,
          auditLogId: entry.id,
          operationIndex,
          durationMs: Math.round(nowMs() - startedAtMs),
        },
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: "audit log operation detail load threw" },
      });
      setAuditLogOperationDetails((current) => ({
        ...current,
        [operationKey]: {
          detail: null,
          loading: false,
          errorMessage: error instanceof Error ? error.message : "operation detail の取得に失敗したよ。",
        },
      }));
    }
  };

  return {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogsState,
    auditLogDetails,
    auditLogOperationDetails,
    persistedEntries,
    displayedEntries,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
    handleLoadAuditLogOperationDetail,
  };
}
