import { useEffect, useState } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";

/** 利用枠のキャッシュ取得と更新購読に使う Window API の部分集合。 */
export type ProviderQuotaApi = Pick<
  WithMateWindowApi,
  "getProviderQuotaTelemetry" | "subscribeProviderQuotaTelemetry"
>;
/** 取得状態を、保持している最後のテレメトリと分けて表す。 */
export type ProviderQuotaState = {
  telemetry: ProviderQuotaTelemetry | null;
  readStatus: "loading" | "ready" | "error";
};

/** 指定 Provider を購読し、購読通知が先に届いた場合は遅れて戻るキャッシュ値で上書きしない。 */
export function useProviderQuota(
  api: ProviderQuotaApi | null,
  providerId: string,
) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<ProviderQuotaState & { owner: string }>({
    owner: providerId,
    telemetry: null,
    readStatus: "loading",
  });
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setState((current) => ({
      owner: providerId,
      telemetry: current.owner === providerId ? current.telemetry : null,
      readStatus: "loading",
    }));
    if (!api) {
      setState({ owner: providerId, telemetry: null, readStatus: "error" });
      return;
    }
    /** 現在の購読が有効で、対象に一致する値またはデータなしを受け取ったときだけ反映する。 */
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
    void api
      .getProviderQuotaTelemetry(providerId, { cacheOnly: true })
      .then((telemetry) => {
        if (!receivedUpdate) apply(telemetry);
      })
      .catch(() => {
        if (active && !receivedUpdate)
          setState((current) => ({ ...current, readStatus: "error" }));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, providerId, retry]);
  return {
    ...(state.owner === providerId
      ? state
      : { telemetry: null, readStatus: "loading" as const }),
    /** 初回取得と購読を張り直す。 */
    retry: () => setRetry((value) => value + 1),
  };
}
