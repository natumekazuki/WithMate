import { useImperativeHandle, useLayoutEffect, useState, type Ref } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { AuditLogSummary } from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import { SessionAuditLogModal } from "./session-audit-log.js";
import { useActiveSessionLiveRun } from "./session-window-live-run-hooks.js";

export type SessionAuditFeatureHandle = { open: () => void };

export function SessionAuditFeature(props: {
  api: WithMateWindowApi | null;
  session: Session;
  ownerSessionId: string | null;
  sourceLabel: string;
  ref?: Ref<SessionAuditFeatureHandle>;
  onEntriesChange: (entries: AuditLogSummary[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const { selectedSessionLiveRun } = useActiveSessionLiveRun(props.api, props.session, props.ownerSessionId, open);
  const audit = useSessionAuditLogs({
    withmateApi: props.api,
    selectedSession: props.session,
    ownerSessionId: props.ownerSessionId,
    cacheScopeKey: "session",
    sourceLabel: props.sourceLabel,
    liveRun: selectedSessionLiveRun,
    open,
    onOpenChange: setOpen,
  });
  useImperativeHandle(props.ref, () => ({ open: () => audit.setAuditLogsOpen(true) }), [audit.setAuditLogsOpen]);
  useLayoutEffect(() => {
    props.onEntriesChange(audit.persistedEntries);
  }, [audit.persistedEntries, props.onEntriesChange]);
  return <SessionAuditLogModal {...audit.modalProps} />;
}
