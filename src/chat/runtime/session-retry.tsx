import { LoadError } from "../../ui/load-error.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

export type SessionRetryBannerProps = {
  retryBanner: {
    kind: "interrupted" | "failed" | "canceled";
    badge: string;
    title: string;
    lastRequestText: string;
  } | null;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  latestTurnLoading?: boolean;
  latestTurnError?: string | null;
  onRetryLatestTurn?: () => void;
};

export function SessionRetryBanner({
  retryBanner,
  isRetryActionDisabled,
  isRetryEditDisabled,
  isRetryDraftReplacePending,
  onResendLastMessage,
  onEditLastMessage,
  onConfirmRetryDraftReplace,
  onCancelRetryDraftReplace,
  latestTurnLoading = false,
  latestTurnError = null,
  onRetryLatestTurn,
}: SessionRetryBannerProps) {
  if (!retryBanner && !latestTurnLoading && !latestTurnError) return null;
  return (
    <section className={`resume-banner retry-banner${retryBanner ? ` ${retryBanner.kind}` : ""}`} aria-label={retryBanner ? "Actions for an unfinished request" : "Request recovery"} aria-busy={latestTurnLoading}>
      {retryBanner || latestTurnLoading ? <div className="resume-banner-head"><div className="resume-banner-copy">
        {retryBanner ? <span className={`resume-banner-badge ${retryBanner.kind}`} title={retryBanner.title}>
          {retryBanner.badge}
          <span className="sr-only">: {retryBanner.title}</span>
        </span> : null}
        {latestTurnLoading ? <LoadingIndicator label="Loading latest execution" inline /> : null}
      </div></div> : null}
      {retryBanner ? <div className="resume-banner-actions">
        <button type="button" onClick={onResendLastMessage} disabled={isRetryActionDisabled}>Resend</button>
        <button className="drawer-toggle secondary" type="button" onClick={onEditLastMessage} disabled={isRetryEditDisabled}>Edit</button>
      </div> : null}
      {latestTurnError ? <LoadError message={`Could not load the latest execution: ${latestTurnError}`} onRetry={onRetryLatestTurn} retryDisabled={latestTurnLoading} /> : null}
      {retryBanner && isRetryDraftReplacePending ? <div className="resume-banner-conflict">
        <p>Your current draft is preserved.</p>
        <div className="resume-banner-conflict-actions">
          <button type="button" onClick={onConfirmRetryDraftReplace} disabled={isRetryEditDisabled}>Replace Previous Request</button>
          <button className="drawer-toggle secondary" type="button" onClick={onCancelRetryDraftReplace}>Keep Current Draft</button>
        </div>
      </div> : null}
    </section>
  );
}
