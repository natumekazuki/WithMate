import { useId, useState, type ComponentProps, type ReactNode } from "react";
import type { CoordinationIdentity } from "../../../src-shared/coordination/coordination-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";

export function CoordinationNotice({ id, consultation, target, messageContext, contentLabel }: {
  id: string; consultation: string; target: CoordinationIdentity;
  messageContext?: Omit<ComponentProps<typeof MessageRichText>, "text">;
  contentLabel?: "Sent Content" | "Received Content";
}) {
  const [failure, setFailure] = useState<{ identity: string; text: string } | null>(null);
  const questionId = useId();
  const identity = JSON.stringify([id, target.kind, target.sessionId, target.incarnationId]);
  return <section className="coordination-notice" aria-label={contentLabel}>
    <blockquote className="coordination-question">
    <div id={questionId}><MessageRichText {...messageContext} text={consultation} /></div>
    <button type="button" className="related-session-route coordination-notice-link" aria-describedby={questionId} title="Open Consultation"
      disabled={!getWithMateApi()?.openCoordination} onClick={() => {
        setFailure(null);
        void getWithMateApi()?.openCoordination({ id, kind: target.kind, sessionId: target.sessionId, incarnationId: target.incarnationId })
          .catch((error) => setFailure({ identity, text: error instanceof Error ? error.message : "Could not open Coordination." }));
      }}>
      <span className="related-session-title">Open Consultation</span><span aria-hidden="true">›</span>
    </button>
    </blockquote>
    {failure?.identity === identity ? <p role="alert">{failure.text}</p> : null}
  </section>;
}

export function ReceivedCoordinationContent({ children, text, consultation }: { children: ReactNode; text: string; consultation?: string }) {
  // Compare only to avoid displaying the same authored question twice, not to infer delivery state.
  return consultation !== undefined && text !== consultation
    ? <section className="received-coordination-content" aria-label="Received Content">{children}</section>
    : null;
}
