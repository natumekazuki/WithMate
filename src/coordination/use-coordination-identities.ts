import { useCallback, useEffect, useState } from "react";
import type { CoordinationIdentity } from "../../src-shared/coordination/coordination-contract.js";
import type { CoordinationDisplayIdentity } from "../../src-shared/coordination/coordination-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";

export const coordinationIdentityKey = (identity: CoordinationIdentity) =>
  JSON.stringify([identity.kind, identity.sessionId, identity.incarnationId]);

export type CoordinationIdentityRead = {
  identity: CoordinationDisplayIdentity | null;
  error?: string;
};

/** Only identities used by the visible page/detail are read; no history is loaded. */
export function useCoordinationIdentities(identities: CoordinationIdentity[], active: boolean) {
  const [reads, setReads] = useState<Record<string, CoordinationIdentityRead>>({});
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const unique = [...new Map(identities.map(({ kind, sessionId, incarnationId }) => {
    const identity = { kind, sessionId, incarnationId };
    return [coordinationIdentityKey(identity), identity];
  })).values()];
  const key = JSON.stringify(unique);
  useEffect(() => {
    if (!active) return;
    const api = getWithMateApi();
    if (!api) return;
    let current = true;
    const visible: CoordinationIdentity[] = JSON.parse(key);
    const visibleKeys = new Set(visible.map(coordinationIdentityKey));
    setReads((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => visibleKeys.has(id))));
    for (const identity of visible) {
      const identityKey = coordinationIdentityKey(identity);
      void api.getCoordinationIdentity(identity).then((result) => {
        if (current) setReads((previous) => ({ ...previous, [identityKey]: { identity: result } }));
      }).catch((error: unknown) => {
        if (current) setReads((previous) => ({
          ...previous,
          [identityKey]: {
            identity: previous[identityKey]?.identity ?? null,
            error: error instanceof Error ? error.message : "Could not load the Session identity.",
          },
        }));
      });
    }
    return () => { current = false; };
  }, [key, active, revision]);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = getWithMateApi()?.subscribeSessionInvalidation(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
    };
  }, [active, refresh]);
  return { reads, refresh };
}
