import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CoordinationIdentity } from "../../../src-shared/coordination/coordination-contract.js";
import { projectMessageRenderedSearchText } from "../../../src-shared/session/message-search.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { useCoordinationStatus } from "../../coordination/use-coordination-query.js";
import { ErrorDetailsButton } from "../../ui/error-details.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

const consultationStates = {
  awaitingUser: { label: "Awaiting Your Reply", path: "M4 16a6 5 0 0 1 12 0M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" },
  awaitingReply: { label: "Awaiting Reply", path: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3v4l3 2" },
  replyRecorded: { label: "Reply Recorded", path: "M8 4 3 9l5 5M3 9h9a5 5 0 0 1 5 5v2" },
  resolved: { label: "Resolved", path: "m4 10 4 4 8-8" },
  withdrawn: { label: "Withdrawn", path: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM7 10h6" },
  corrected: { label: "Corrected", path: "m4 12-1 5 5-1 9-9-4-4Zm7-7 4 4" },
  deleted: { label: "Deleted", path: "M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6" },
  unavailable: { label: "State Unavailable", path: "m10 3 8 14H2Zm0 5v3m0 2.5v.5" },
};

export function CoordinationNotice({ id, consultation, target }: {
  id: string; consultation: string; target: CoordinationIdentity;
}) {
  const [failure, setFailure] = useState<{ identity: string; text: string } | null>(null);
  const statusId = useId();
  const shell = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!shell.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);
  const api = getWithMateApi();
  const query = useCoordinationStatus(id, visible && Boolean(api?.getCoordinationStatus));
  const record = query.result;
  const state = query.deleted ? "deleted" : query.error || !api?.getCoordinationStatus ? "unavailable"
    : !record ? null : record.state !== "open" ? record.state
      : record.hasAnswer ? "replyRecorded" : record.respondentKind === "user" ? "awaitingUser" : "awaitingReply";
  const status = state && consultationStates[state];
  const preview = projectMessageRenderedSearchText(consultation).replace(/\s+/gu, " ").trim();
  const identity = JSON.stringify([id, target.kind, target.sessionId, target.incarnationId]);
  return <section ref={shell} className="coordination-notice" aria-label="Consultation">
    <button type="button" className="related-session-route coordination-notice-link" aria-label={`Open Consultation: ${preview}`} aria-describedby={statusId}
      title={status ? `${status.label} · Open Consultation: ${preview}` : `Open Consultation: ${preview}`}
      disabled={!api?.openCoordination} onClick={() => {
        setFailure(null);
        void getWithMateApi()?.openCoordination({ id, kind: target.kind, sessionId: target.sessionId, incarnationId: target.incarnationId })
          .catch((error) => setFailure({ identity, text: error instanceof Error ? error.message : "Could not open Coordination." }));
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg>
      <span className="related-session-title">{preview}</span>
      {status && !(state === "unavailable" && query.error) ? <svg className="coordination-notice-state" width="16" height="16" viewBox="0 0 20 20"
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={status.path} />
      </svg> : null}
      <span aria-hidden="true">›</span>
    </button>
    <span id={statusId} className="visually-hidden">{status?.label ?? (query.loading ? "Loading Consultation State" : null)}</span>
    {query.loading ? <LoadingIndicator inline label="Loading Consultation State" /> : null}
    {query.error && !query.deleted ? <><ErrorDetailsButton message={query.error} label="Consultation State Error" /><button type="button" className="related-session-route" disabled={query.loading} onClick={query.refresh}>Retry</button></> : null}
    {failure?.identity === identity ? <ErrorDetailsButton message={failure.text} label="Could Not Open Consultation" /> : null}
  </section>;
}

export function ReceivedCoordinationContent({ children, text, consultation }: { children: ReactNode; text: string; consultation?: string }) {
  // Compare only to avoid displaying the same authored question twice, not to infer delivery state.
  return consultation === undefined || text !== consultation
    ? <section className="received-coordination-content" aria-label="Received Content">{children}</section>
    : null;
}
