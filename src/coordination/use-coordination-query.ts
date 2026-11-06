import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CoordinationRequest,
  CoordinationResult,
} from "../../src-shared/coordination/coordination-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";

/** The query generation, not arrival order, owns the visible snapshot. */
export function useCoordinationQuery(
  request: CoordinationRequest | null,
  enabled = true,
) {
  const [result, setResult] = useState<CoordinationResult | null>(null);
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
    void api
      .executeCoordination(request)
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
    // The serialized validated request is the query identity.
  }, [key, enabled, retry, markDeleted]);
  useEffect(() => {
    if (!enabled || !request) return;
    return getWithMateApi()?.subscribeCoordinationChanged((summary) => {
      if (request.operation === "get" && summary.id !== request.id) return;
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
