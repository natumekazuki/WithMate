import type { CSSProperties, ReactNode } from "react";

import type { DiffPreviewPayload } from "../app-state.js";
import {
  SessionAuditLogModal,
  SessionDiffModal,
  type SessionAuditLogModalProps,
} from "../session-components.js";

export type ChatSessionModalsProps = {
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  auditLogsOpen: boolean;
  displayedSessionAuditLogs: SessionAuditLogModalProps["entries"];
  auditLogSourceLabel?: SessionAuditLogModalProps["sourceLabel"];
  auditLogDetails: SessionAuditLogModalProps["details"];
  auditLogOperationDetails: SessionAuditLogModalProps["operationDetails"];
  auditLogsHasMore: boolean;
  auditLogsLoading: boolean;
  auditLogsTotal: number;
  auditLogsErrorMessage: string | null;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  onLoadMoreAuditLogs: () => void;
  onLoadAuditLogDetail: SessionAuditLogModalProps["onLoadDetail"];
  onLoadAuditLogOperationDetail: SessionAuditLogModalProps["onLoadOperationDetail"];
  onCloseAuditLog: () => void;
  children?: ReactNode;
};

export function ChatSessionModals({
  selectedDiff,
  selectedDiffThemeStyle,
  auditLogsOpen,
  displayedSessionAuditLogs,
  auditLogSourceLabel,
  auditLogDetails,
  auditLogOperationDetails,
  auditLogsHasMore,
  auditLogsLoading,
  auditLogsTotal,
  auditLogsErrorMessage,
  onCloseDiff,
  onOpenDiffWindow,
  onLoadMoreAuditLogs,
  onLoadAuditLogDetail,
  onLoadAuditLogOperationDetail,
  onCloseAuditLog,
  children,
}: ChatSessionModalsProps) {
  return (
    <>
      <SessionDiffModal
        selectedDiff={selectedDiff}
        themeStyle={selectedDiffThemeStyle}
        onClose={onCloseDiff}
        onOpenDiffWindow={onOpenDiffWindow}
      />

      <SessionAuditLogModal
        open={auditLogsOpen}
        entries={displayedSessionAuditLogs}
        sourceLabel={auditLogSourceLabel}
        details={auditLogDetails}
        operationDetails={auditLogOperationDetails}
        hasMore={auditLogsHasMore}
        loadingMore={auditLogsLoading}
        total={auditLogsTotal}
        errorMessage={auditLogsErrorMessage}
        onLoadMore={onLoadMoreAuditLogs}
        onLoadDetail={onLoadAuditLogDetail}
        onLoadOperationDetail={onLoadAuditLogOperationDetail}
        onClose={onCloseAuditLog}
      />

      {children}
    </>
  );
}
