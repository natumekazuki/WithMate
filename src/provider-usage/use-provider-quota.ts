import { useEffect, useState } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";

export type ProviderQuotaApi = Pick<WithMateWindowApi, "getProviderQuotaTelemetry" | "subscribeProviderQuotaTelemetry">;
export type ProviderQuotaState = {
  telemetry: ProviderQuotaTelemetry | null;
  readStatus: "loading" | "ready" | "error";
};

export function useProviderQuota(api: ProviderQuotaApi | null, providerId: string) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<ProviderQuotaState & { owner: string }>({
    owner: providerId, telemetry: null, readStatus: "loading",
  });
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setState((current) => ({ owner: providerId, telemetry: current.owner === providerId ? current.telemetry : null, readStatus: "loading" }));
    if (!api) {
      setState({ owner: providerId, telemetry: null, readStatus: "error" });
      return;
    }
    const apply = (telemetry: ProviderQuotaTelemetry | null) => {
      if (active && (!telemetry || telemetry.provider === providerId)) {
        setState({ owner: providerId, telemetry, readStatus: "ready" });
      }
    };
    const unsubscribe = api.subscribeProviderQuotaTelemetry((id, telemetry) => {
      if (id !== providerId || !active) return;
      receivedUpdate = true;
      apply(telemetry);
    });
    void api.getProviderQuotaTelemetry(providerId, { cacheOnly: true }).then((telemetry) => {
      if (!receivedUpdate) apply(telemetry);
    }).catch(() => {
      if (active && !receivedUpdate) setState((current) => ({ ...current, readStatus: "error" }));
    });
    return () => { active = false; unsubscribe(); };
  }, [api, providerId, retry]);
  return {
    ...(state.owner === providerId ? state : { telemetry: null, readStatus: "loading" as const }),
    retry: () => setRetry((value) => value + 1),
  };
}
