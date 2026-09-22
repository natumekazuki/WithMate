import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  GLOSSARY_RELATIVE_PATH,
  type GlossaryEntry,
  type SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import type { SessionGlossaryPaneProps } from "./SessionGlossaryPane.js";
import { createGlossaryAnnotationMatcher } from "./glossary-annotation-projection.js";
import { isGlossarySearchRevisionCurrent } from "../chat/runtime/session-ui-projection.js";

type SessionGlossaryApi = Pick<WithMateWindowApi,
  "getSessionGlossaryProjection"
  | "searchSessionGlossary"
  | "subscribeSessionGlossary"
>;

export type SessionGlossarySelection = {
  id: string;
  revision: string;
  workspaceLabel: string;
  branch: string;
};

export type SessionGlossaryView = {
  projection: SessionGlossaryProjection | null;
  searchQuery: string;
  searchEntries: GlossaryEntry[];
  searchTotal: number;
  searchLoading: boolean;
  searchError: string;
  selectedTerm: string | null;
};

export function useSessionGlossary({
  api,
  selectedSession,
  onActivatePane,
}: {
  api: SessionGlossaryApi | null;
  selectedSession: SessionGlossarySelection | null;
  onActivatePane: () => void;
}) {
  const [projection, setProjection] = useState<SessionGlossaryProjection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchEntries, setSearchEntries] = useState<GlossaryEntry[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    let active = true;
    let highestSequence = 0;
    setProjection(null);
    setSearchQuery("");
    setSearchEntries([]);
    setSearchTotal(0);
    setSearchError("");
    setSelectedTerm(null);

    if (!api || !selectedSession) {
      return () => {
        active = false;
      };
    }

    const applyProjection = (nextProjection: SessionGlossaryProjection) => {
      if (!active || nextProjection.sessionId !== selectedSession.id || nextProjection.sequence < highestSequence) {
        return;
      }
      highestSequence = nextProjection.sequence;
      setProjection(nextProjection);
    };
    const unsubscribe = api.subscribeSessionGlossary(applyProjection);
    void api.getSessionGlossaryProjection(selectedSession.id)
      .then(applyProjection)
      .catch((error) => {
        if (!active) {
          return;
        }
        setProjection({
          sessionId: selectedSession.id,
          scopeRevision: "renderer-load-error",
          sequence: highestSequence + 1,
          checkout: {
            repositoryName: selectedSession.workspaceLabel || "Repository",
            branch: selectedSession.branch || "unavailable",
            pathLabel: selectedSession.workspaceLabel || "Repository",
          },
          state: {
            status: "watch-error",
            relativePath: GLOSSARY_RELATIVE_PATH,
            revision: null,
            message: error instanceof Error ? error.message : "用語集を読み込めませんでした。",
          },
        });
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, selectedSession?.id]);

  useEffect(() => {
    let active = true;
    const requestId = ++searchRequestIdRef.current;
    const query = searchQuery.trim();
    if (!api || !selectedSession || projection?.state.status !== "valid" || !query) {
      setSearchEntries([]);
      setSearchTotal(0);
      setSearchLoading(false);
      setSearchError("");
      return () => {
        active = false;
      };
    }

    setSearchLoading(true);
    setSearchError("");
    setSearchEntries([]);
    setSearchTotal(0);
    void api.searchSessionGlossary(selectedSession.id, { query, offset: 0, pageSize: 100 }).then((result) => {
      if (!active || searchRequestIdRef.current !== requestId) {
        return;
      }
      if (!result.ok) {
        setSearchEntries([]);
        setSearchTotal(0);
        setSearchError(result.message);
      } else if (isGlossarySearchRevisionCurrent(result.revision, projection.state.revision)) {
        setSearchEntries(result.entries);
        setSearchTotal(result.total);
      }
      setSearchLoading(false);
    }).catch((error) => {
      if (active && searchRequestIdRef.current === requestId) {
        setSearchEntries([]);
        setSearchTotal(0);
        setSearchError(error instanceof Error ? error.message : "用語集を検索できませんでした。");
        setSearchLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [api, projection?.state.revision, projection?.state.status, searchQuery, selectedSession?.id]);

  useEffect(() => {
    if (selectedTerm && projection?.state.status === "valid" && !projection.state.entries.some((entry) => entry.term === selectedTerm)) {
      setSelectedTerm(null);
    }
  }, [projection, selectedTerm]);

  const annotationMatcher = useMemo(
    () => projection?.state.status === "valid"
      ? createGlossaryAnnotationMatcher(projection.state.entries, projection.state.revision)
      : undefined,
    [projection],
  );

  const onActivateGlossaryEntry = useCallback((canonicalTerm: string) => {
    if (projection?.state.status !== "valid" || !projection.state.entries.some((entry) => entry.term === canonicalTerm)) {
      return;
    }
    setSelectedTerm(canonicalTerm);
    onActivatePane();
  }, [onActivatePane, projection]);

  const onLoadMoreSearchResults = useCallback(() => {
    const query = searchQuery.trim();
    if (!api || !selectedSession || !query || searchLoading || searchEntries.length >= searchTotal) {
      return;
    }
    setSearchLoading(true);
    setSearchError("");
    const requestId = ++searchRequestIdRef.current;
    void api.searchSessionGlossary(selectedSession.id, {
      query,
      offset: searchEntries.length,
      pageSize: 100,
    }).then((result) => {
      if (searchRequestIdRef.current !== requestId) {
        return;
      }
      if (!result.ok) {
        setSearchError(result.message);
      } else if (isGlossarySearchRevisionCurrent(result.revision, projection?.state.revision)) {
        setSearchEntries((current) => [...current, ...result.entries]);
        setSearchTotal(result.total);
      }
      setSearchLoading(false);
    }).catch((error) => {
      if (searchRequestIdRef.current !== requestId) {
        return;
      }
      setSearchError(error instanceof Error ? error.message : "用語集を検索できませんでした。");
      setSearchLoading(false);
    });
  }, [api, projection?.state.revision, searchEntries.length, searchLoading, searchQuery, searchTotal, selectedSession]);

  const paneProps = {
    projection,
    searchQuery,
    searchEntries,
    searchTotal,
    searchLoading,
    searchError,
    selectedTerm,
    onSearchQueryChange: setSearchQuery,
    onLoadMoreSearchResults,
    onSelectTerm: setSelectedTerm,
    onBackToList: () => setSelectedTerm(null),
  } satisfies SessionGlossaryPaneProps;

  return {
    paneProps,
    view: {
      projection,
      searchQuery,
      searchEntries,
      searchTotal,
      searchLoading,
      searchError,
      selectedTerm,
    } satisfies SessionGlossaryView,
    actions: {
      onSearchQueryChange: setSearchQuery,
      onLoadMoreSearchResults,
      onSelectTerm: setSelectedTerm,
      onBackToList: () => setSelectedTerm(null),
      onActivateGlossaryEntry,
    },
    annotationMatcher,
  };
}
