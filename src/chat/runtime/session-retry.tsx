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
}: SessionRetryBannerProps) {
  if (!retryBanner) return null;
  return (
    <section className={`resume-banner retry-banner ${retryBanner.kind}`} aria-label="完了できなかった依頼の操作">
      <div className="resume-banner-head"><div className="resume-banner-copy">
        <span className={`resume-banner-badge ${retryBanner.kind}`} title={retryBanner.title}>
          {retryBanner.badge}<span className="sr-only">: {retryBanner.title}</span>
        </span>
      </div></div>
      <div className="resume-banner-actions">
        <button type="button" onClick={onResendLastMessage} disabled={isRetryActionDisabled}>再送</button>
        <button className="drawer-toggle secondary" type="button" onClick={onEditLastMessage} disabled={isRetryEditDisabled}>編集</button>
      </div>
      {isRetryDraftReplacePending ? <div className="resume-banner-conflict">
        <p>今の下書きは残しています。</p>
        <div className="resume-banner-conflict-actions">
          <button type="button" onClick={onConfirmRetryDraftReplace} disabled={isRetryEditDisabled}>前回の依頼で置き換える</button>
          <button className="drawer-toggle secondary" type="button" onClick={onCancelRetryDraftReplace}>今の下書きを続ける</button>
        </div>
      </div> : null}
    </section>
  );
}
