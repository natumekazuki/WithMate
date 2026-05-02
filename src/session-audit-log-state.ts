import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AuditLogDetailFragment,
  AuditLogDetailSection,
  AuditLogSummary,
  LiveSessionRunState,
} from "./app-state.js";
import { buildAuditLogRefreshSignature, buildDisplayedAuditLogs } from "./audit-log-refresh.js";
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
  errorMessages: Partial<Record<AuditLogDetailSection, string>>;
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
};

const AUDIT_LOG_PAGE_LIMIT = 50;

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
}: UseSessionAuditLogsInput) {
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogsState, setAuditLogsState] = useState<SessionOwnedAuditLogs>(() => createEmptyAuditLogsState(null));
  const [auditLogDetails, setAuditLogDetails] = useState<Record<number, AuditLogDetailLoadState>>({});
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

    if (!enabled || !withmateApi || !selectedSession) {
      setAuditLogsState(createEmptyAuditLogsState(null));
      setAuditLogDetails({});
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
      auditLogDetailOwnerRef.current = selectedSession.id;
    }
    void withmateApi.listSessionAuditLogSummaryPage(selectedSession.id, {
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
  }, [enabled, refreshSignature, selectedSessionId, withmateApi]);

  const handleLoadMoreAuditLogs = () => {
    if (!enabled || !withmateApi || !selectedSessionId) {
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

    void withmateApi.listSessionAuditLogSummaryPage(ownerSessionId, {
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
    if (!enabled || !withmateApi || !selectedSessionId || entry.id < 0 || !entry.detailAvailable) {
      return;
    }

    let shouldLoad = false;
    setAuditLogDetails((current) => {
      const existing = current[entry.id];
      if (existing?.loadingSections[section] || existing?.loadedSections[section]) {
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

    try {
      void withmateApi.getSessionAuditLogDetailSection(entry.sessionId, entry.id, section).then(
        (fragment) => {
          setAuditLogDetails((current) => ({
            ...current,
            [entry.id]: {
              detail: fragment ? { ...(current[entry.id]?.detail ?? {}), ...fragment } : current[entry.id]?.detail ?? null,
              loadedSections: {
                ...current[entry.id]?.loadedSections,
                [section]: fragment !== null,
              },
              loadingSections: {
                ...current[entry.id]?.loadingSections,
                [section]: false,
              },
              errorMessages: {
                ...current[entry.id]?.errorMessages,
                [section]: fragment ? undefined : "audit log detail が見つからなかったよ。",
              },
            },
          }));
        },
        (error: unknown) => {
          setAuditLogDetails((current) => ({
            ...current,
            [entry.id]: {
              detail: current[entry.id]?.detail ?? null,
              loadedSections: current[entry.id]?.loadedSections ?? {},
              loadingSections: {
                ...current[entry.id]?.loadingSections,
                [section]: false,
              },
              errorMessages: {
                ...current[entry.id]?.errorMessages,
                [section]: error instanceof Error ? error.message : "audit log detail の取得に失敗したよ。",
              },
            },
          }));
        },
      );
    } catch (error) {
      setAuditLogDetails((current) => ({
        ...current,
        [entry.id]: {
          detail: current[entry.id]?.detail ?? null,
          loadedSections: current[entry.id]?.loadedSections ?? {},
          loadingSections: {
            ...current[entry.id]?.loadingSections,
            [section]: false,
          },
          errorMessages: {
            ...current[entry.id]?.errorMessages,
            [section]: error instanceof Error ? error.message : "audit log detail の取得に失敗したよ。",
          },
        },
      }));
    }
  };

  return {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogsState,
    auditLogDetails,
    persistedEntries,
    displayedEntries,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
  };
}
