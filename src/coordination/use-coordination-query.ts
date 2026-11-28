import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CoordinationRequest,
  CoordinationResult,
} from "../../src-shared/coordination/coordination-contract.js";
import type {
  CoordinationDeletedResult,
  CoordinationStatus,
} from "../../src-shared/coordination/coordination-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";

/** 一覧・詳細の操作と区別する、一件の表示用状態のクエリ。 */
type StatusQuery = { operation: "status"; id: string };
/** 一覧や詳細のリクエストを Window の相談操作 API に渡す。 */
const readDetails = (
  api: NonNullable<ReturnType<typeof getWithMateApi>>,
  request: CoordinationRequest,
) => api.executeCoordination(request);
/** レコード全体ではなく、ID に対応する表示用状態だけを取得する。 */
const readStatus = (
  api: NonNullable<ReturnType<typeof getWithMateApi>>,
  { id }: StatusQuery,
) => api.getCoordinationStatus({ id });

/** 相談の一覧・詳細の読み取りを管理し、関連する変更通知で再取得する。 */
export function useCoordinationQuery(
  request: CoordinationRequest | null,
  enabled = true,
) {
  return useCoordinationRead<CoordinationRequest, CoordinationResult>(
    request,
    enabled,
    readDetails,
  );
}

/** 相談一件の表示用状態を取得し、詳細レコードは読み込まない。 */
export function useCoordinationStatus(id: string, enabled: boolean) {
  return useCoordinationRead<StatusQuery, CoordinationStatus>(
    { operation: "status", id },
    enabled,
    readStatus,
  );
}

/** 到着順ではなく、クエリの世代で表示するスナップショットを決める。 */
function useCoordinationRead<
  Request extends CoordinationRequest | StatusQuery,
  Result extends CoordinationResult | CoordinationStatus,
>(
  request: Request | null,
  enabled: boolean,
  read: (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
    request: Request,
  ) => Promise<Result | CoordinationDeletedResult>,
) {
  const [result, setResult] = useState<Result | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const deletedQueries = useRef(new Map<string, string>());
  const key = JSON.stringify(request);
  const activeKey = useRef(key);
  activeKey.current = key;
  const markDeleted = useCallback(
    (message: string) => {
      deletedQueries.current.set(key, message);
      if (activeKey.current !== key) return;
      generation.current += 1;
      setResult(null);
      setError(message);
      setLoading(false);
    },
    [key],
  );
  const refresh = useCallback(() => {
    generation.current += 1;
    setRetry((value) => value + 1);
  }, []);
  useEffect(() => {
    setResult(null);
    setError("");
  }, [key]);
  useEffect(() => {
    if (!enabled || !request) return;
    const deletedMessage = deletedQueries.current.get(key);
    if (deletedMessage) {
      setResult(null);
      setError(deletedMessage);
      setLoading(false);
      return;
    }
    const api = getWithMateApi();
    if (!api) {
      setError("A desktop runtime is required.");
      return;
    }
    const current = ++generation.current;
    setLoading(true);
    void read(api, request)
      .then((next) => {
        if (generation.current === current) {
          if ("error" in next) {
            markDeleted(next.error.message);
            return;
          }
          setResult(next);
          setResultKey(key);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (generation.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load Coordination.",
          );
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
    // 検証済みリクエストを直列化した値がクエリの識別子になる。
  }, [key, enabled, retry, markDeleted, read]);
  useEffect(() => {
    if (!enabled || !request) return;
    return getWithMateApi()?.subscribeCoordinationChanged((summary) => {
      if (
        (request.operation === "get" || request.operation === "status") &&
        summary.id !== request.id
      )
        return;
      if (
        request.operation === "list" &&
        request.crewRootSessionId &&
        summary.crewRootSessionId !== request.crewRootSessionId
      )
        return;
      refresh();
    });
  }, [key, enabled, refresh]);
  return {
    result: resultKey === key ? result : null,
    error,
    deleted: deletedQueries.current.has(key),
    loading,
    refresh,
    markDeleted,
  };
}
