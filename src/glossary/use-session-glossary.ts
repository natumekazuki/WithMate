import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
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
  projectionLoading: boolean;
  projectionError: string;
  searchQuery: string;
  searchEntries: GlossaryEntry[];
  searchTotal: number;
  searchLoading: boolean;
  searchError: string;
  searchStale: boolean;
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
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [projectionError, setProjectionError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    api: SessionGlossaryApi;
    sessionId: string;
    scopeRevision: string;
    query: string;
    revision: string;
    entries: GlossaryEntry[];
    total: number;
  } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const retryProjectionRef = useRef<(() => void) | null>(null);
  const retrySearchRef = useRef<(() => void) | null>(null);
  const loadMoreRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    let active = true;
    let highestSequence = 0;
    let receivedProjection = 0;
    let pending = false;
    setProjection(null);
    setProjectionError("");
    setProjectionLoading(false);
    setSearchQuery("");
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
      receivedProjection += 1;
      setProjection(nextProjection);
      setProjectionError("");
    };
    const unsubscribe = api.subscribeSessionGlossary(applyProjection);
    const loadProjection = async () => {
      if (!active || pending) return;
      pending = true;
      const receivedAtStart = receivedProjection;
      setProjectionLoading(true);
      try {
        applyProjection(await api.getSessionGlossaryProjection(selectedSession.id));
      } catch (error) {
        if (active && receivedProjection === receivedAtStart) {
          setProjectionError(error instanceof Error ? error.message : "Could not load the glossary.");
        }
      } finally {
        pending = false;
        if (active) setProjectionLoading(false);
      }
    };
    retryProjectionRef.current = () => { void loadProjection(); };
    void loadProjection();

    return () => {
      active = false;
      retryProjectionRef.current = null;
      unsubscribe();
    };
  }, [api, selectedSession?.id]);

  useLayoutEffect(() => {
    let active = true;
    let pending = false;
    let loadedCount = 0;
    let total = 0;
    let retryOffset = 0;
    const query = searchQuery.trim();
    if (!api || !selectedSession || projection?.sessionId !== selectedSession.id || projection.state.status !== "valid" || !query) {
      setSearchResult(null);
      setSearchLoading(false);
      setSearchError("");
      return () => {
        active = false;
      };
    }

    setSearchResult((current) => current?.api === api
      && current.sessionId === selectedSession.id
      && current.scopeRevision === projection.scopeRevision
      && current.query === query ? current : null);
    setSearchError("");
    const revision = projection.state.revision;
    const loadSearch = async (offset: number) => {
      if (!active || pending) return;
      pending = true;
      retryOffset = offset;
      setSearchLoading(true);
      try {
        const result = await api.searchSessionGlossary(selectedSession.id, { query, offset, pageSize: 100 });
        if (!active) return;
        if (!result.ok) {
          setSearchError(result.message);
        } else if (!isGlossarySearchRevisionCurrent(result.revision, projection.state.revision)) {
          setSearchError("The glossary changed during the search. Retry to load current results.");
        } else {
          loadedCount = offset + result.entries.length;
          total = result.total;
          setSearchResult((current) => ({
            api,
            sessionId: selectedSession.id,
            scopeRevision: projection.scopeRevision,
            query,
            revision,
            entries: offset === 0 ? result.entries : [...(current?.entries ?? []), ...result.entries],
            total: result.total,
          }));
          setSearchError("");
        }
      } catch (error) {
        if (active) setSearchError(error instanceof Error ? error.message : "Could not search the glossary.");
      } finally {
        pending = false;
        if (active) setSearchLoading(false);
      }
    };
    retrySearchRef.current = () => { void loadSearch(retryOffset); };
    loadMoreRef.current = () => {
      if (loadedCount < total) void loadSearch(loadedCount);
    };
    void loadSearch(0);

    return () => {
      active = false;
      retrySearchRef.current = null;
      loadMoreRef.current = null;
    };
  }, [api, projection?.scopeRevision, projection?.state.revision, projection?.state.status, searchQuery.trim(), selectedSession?.id]);

  const applicableSearch = searchResult?.api === api
    && searchResult?.sessionId === selectedSession?.id
    && searchResult?.scopeRevision === projection?.scopeRevision
    && searchResult?.query === searchQuery.trim()
    && projection?.state.status === "valid"
    ? searchResult : null;
  const searchEntries = applicableSearch?.entries ?? [];
  const searchTotal = applicableSearch?.total ?? 0;
  const searchStale = applicableSearch !== null && applicableSearch.revision !== projection?.state.revision;

  useEffect(() => {
    if (selectedTerm && projection?.state.status === "valid"
      && !projection.state.entries.some((entry) => entry.term === selectedTerm)
      && !searchEntries.some((entry) => entry.term === selectedTerm)) {
      setSelectedTerm(null);
    }
  }, [projection, searchEntries, selectedTerm]);

  const annotationState = projection?.sessionId === selectedSession?.id && projection?.state.status === "valid"
    ? projection.state : undefined;
  const annotationScope = projection?.sessionId === selectedSession?.id ? projection?.scopeRevision : undefined;
  const annotationMatcher = useMemo(
    () => annotationState
      ? createGlossaryAnnotationMatcher(annotationState.entries, annotationState.revision)
      : undefined,
    [annotationState?.revision, annotationScope, selectedSession?.id],
  );

  const activationRef = useRef({ projection, selectedSession, onActivatePane });
  useLayoutEffect(() => {
    activationRef.current = { projection, selectedSession, onActivatePane };
  }, [projection, selectedSession, onActivatePane]);
  useLayoutEffect(() => () => {
    activationRef.current = { projection: null, selectedSession: null, onActivatePane: () => undefined };
  }, []);
  const onActivateGlossaryEntry = useCallback((canonicalTerm: string) => {
    const current = activationRef.current;
    if (
      current.selectedSession?.id !== selectedSession?.id
      || current.projection?.sessionId !== selectedSession?.id
      || current.projection?.scopeRevision !== annotationScope
      || current.projection?.state.status !== "valid"
      || !current.projection.state.entries.some((entry) => entry.term === canonicalTerm)
    ) {
      return;
    }
    setSelectedTerm(canonicalTerm);
    current.onActivatePane();
  }, [annotationScope, selectedSession?.id]);

  const onRetryProjection = useCallback(() => retryProjectionRef.current?.(), []);
  const onRetrySearch = useCallback(() => retrySearchRef.current?.(), []);
  const onLoadMoreSearchResults = useCallback(() => loadMoreRef.current?.(), []);

  const paneProps = {
    projection,
    projectionLoading,
    projectionError,
    searchQuery,
    searchEntries,
    searchTotal,
    searchLoading,
    searchError,
    searchStale,
    selectedTerm,
    onSearchQueryChange: setSearchQuery,
    onLoadMoreSearchResults,
    onRetryProjection,
    onRetrySearch,
    onSelectTerm: setSelectedTerm,
    onBackToList: () => setSelectedTerm(null),
  } satisfies SessionGlossaryPaneProps;

  return {
    paneProps,
    view: {
      projection,
      projectionLoading,
      projectionError,
      searchQuery,
      searchEntries,
      searchTotal,
      searchLoading,
      searchError,
      searchStale,
      selectedTerm,
    } satisfies SessionGlossaryView,
    actions: {
      onSearchQueryChange: setSearchQuery,
      onLoadMoreSearchResults,
      onRetryProjection,
      onRetrySearch,
      onSelectTerm: setSelectedTerm,
      onBackToList: () => setSelectedTerm(null),
      onActivateGlossaryEntry,
    },
    annotationMatcher,
  };
}
