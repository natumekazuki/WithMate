import { useEffect, useId, useState, type CSSProperties } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { CloseButton } from "../ui/close-button.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import { formatQuotaTimestamp, projectQuotaRemaining, providerQuotaName } from "./provider-quota-projection.js";
import { useProviderQuota, type ProviderQuotaApi } from "./use-provider-quota.js";

export function ProviderQuota({ api, providerId, showProviderName = false }: {
  api: ProviderQuotaApi | null;
  providerId: string;
  showProviderName?: boolean;
}) {
  const { telemetry, readStatus, retry } = useProviderQuota(api, providerId);
  const id = useId();
  const [position, setPosition] = useState<CSSProperties>({});
  const name = providerQuotaName(providerId);
  const windows = projectQuotaRemaining(telemetry);
  const summary = windows.filter((window) => window.summary);
  const loading = readStatus === "loading" || telemetry?.status === "loading";
  const failed = readStatus === "error" || telemetry?.status === "error";
  const status = failed ? "Update Failed" : telemetry?.status === "unsupported" ? "Not Supported"
    : windows.length ? "" : "Not Yet Available";
  return (
    <div className={`provider-quota${showProviderName ? " provider-quota-named" : ""}`}>
      <button type="button" className="provider-quota-details-button" popoverTarget={id}
        aria-label={`${name} quota details`} title={`${name} Quota Details`}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const width = Math.min(360, window.innerWidth - 24);
          setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
            ...(rect.top > window.innerHeight / 2 ? { bottom: window.innerHeight - rect.top + 8, top: "auto" }
              : { top: rect.bottom + 8, bottom: "auto" }) });
        }}><span aria-hidden="true">i</span></button>
      {showProviderName ? <span className="provider-quota-name">{name}</span> : null}
      <span className="provider-quota-values" aria-label={`${name} remaining quota`}>
        {summary.length ? summary.map((window, index) => (
          <span key={window.key}>{index ? <span aria-hidden="true"> · </span> : null}{window.label} {window.remaining}</span>
        )) : <span title={status || "See Details"}>{loading ? null : windows.length ? "See Details" : "—"}</span>}
      </span>
      {loading ? <LoadingIndicator label={`${name} quota loading`} inline /> : null}
      {failed ? <span className="provider-quota-error" role="img" aria-label={`${name} quota update failed`} title="Update Failed">!</span> : null}
      <section id={id} popover="auto" className="provider-quota-popover" style={position} aria-label={`${name} quota details`}>
          <div className="provider-quota-detail-head"><h3>{name}</h3>
            <CloseButton ariaLabel="Close Quota Details" onClose={() => document.getElementById(id)?.hidePopover()} />
          </div>
          {failed ? <p role="status">{windows.length ? "Update failed. Showing the last successful values." : "Quota could not be loaded."}</p> : null}
          {readStatus === "error" ? <button type="button" className="drawer-toggle compact secondary" onClick={retry}>Retry</button> : null}
          {telemetry?.status === "error" ? <p className="provider-quota-note">Automatic refresh will retry.</p> : null}
          {loading ? <LoadingIndicator label={`${name} quota loading`} inline /> : null}
          {!loading && !failed && status ? <p>{status}</p> : null}
          <dl className="provider-quota-detail-list">
            {windows.map((window) => <div key={window.key}>
              <dt>{window.label}</dt><dd>{window.remaining} Remaining</dd>
              <dt>Resets</dt><dd>{formatQuotaTimestamp(window.resetDate)}</dd>
            </div>)}
          </dl>
          <p className="provider-quota-note">Updated {formatQuotaTimestamp(telemetry?.updatedAt)}</p>
          {providerId === "claude" ? <p className="provider-quota-note">CLI account quota; session authentication may differ.</p> : null}
      </section>
    </div>
  );
}

type OverviewApi = ProviderQuotaApi & Pick<WithMateWindowApi, "getAppSettings" | "subscribeAppSettings">;

export function ProviderQuotaOverview({ api }: { api: OverviewApi | null }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setStatus("loading");
    if (!api) { setStatus("error"); return; }
    return startAppSettingsSubscription({
      api, loadInitial: true,
      applyAppSettings(settings) {
        setProviders(Object.entries(settings.codingProviderSettings).filter(([, value]) => value.enabled).map(([id]) => id));
        setStatus("ready");
      },
      onInitialLoadError() { setStatus("error"); },
    });
  }, [api, retry]);
  return (
    <section className="provider-quota-overview" aria-label="Provider Quotas">
      {status === "loading" ? <LoadingIndicator label="Provider settings loading" inline /> : null}
      {status === "error" ? <LoadError message="Could not load provider settings." onRetry={() => setRetry((value) => value + 1)} /> : null}
      {providers.map((id) => <ProviderQuota key={id} api={api} providerId={id} showProviderName />)}
    </section>
  );
}
