import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  projectAuxiliarySessionSummary,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../auxiliary-session-state.js";
import type { LiveSessionRunState } from "../app-state.js";

export type AuxiliaryWorkspaceApi = {
  listAuxiliarySessions(parentSessionId: string): Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession | null>;
  subscribeLiveSessionRun?: (
    listener: (sessionId: string, state: LiveSessionRunState | null) => void,
  ) => () => void;
};

export type AuxiliaryWorkspaceTarget = "main" | "auxiliary";
export type AuxiliarySessionBinding = {
  sessionRef: { current: AuxiliarySession | null };
  mutationRevision: { current: number };
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  setSession(update: SetStateAction<AuxiliarySession | null>): void;
  getSession(): AuxiliarySession | null;
};

export type AuxiliaryWorkspace = {
  summaries: AuxiliarySessionSummary[];
  selectedId: string | null;
  selectedSession: AuxiliarySession | null;
  loading: boolean;
  error: Error | null;
  detailLoading: boolean;
  detailError: Error | null;
  target: AuxiliaryWorkspaceTarget;
  isExpanded: boolean;
  widthRatio: number;
  setWidthRatio(ratio: number): void;
  selectSession(id: string | null): void;
  setTarget(target: AuxiliaryWorkspaceTarget): void;
  collapse(): void;
  addSession(saved: AuxiliarySession): void;
  refreshSummaries(): Promise<void>;
  getBinding(id: string | null): AuxiliarySessionBinding;
};

const DEFAULT_WIDTH_RATIO = 0.5;
const MIN_WIDTH_RATIO = 0.2;
const MAX_WIDTH_RATIO = 0.8;
const PREFS_KEY_PREFIX = "withmate:auxiliary-workspace:";

type WorkspacePrefs = { selectedId: string | null; widthRatio: number };

function prefsKey(parentSessionId: string): string {
  return `${PREFS_KEY_PREFIX}${parentSessionId}`;
}

function readPrefs(parentSessionId: string): WorkspacePrefs {
  try {
    const value = JSON.parse(window.localStorage.getItem(prefsKey(parentSessionId)) ?? "null") as Partial<WorkspacePrefs> | null;
    const widthRatio = typeof value?.widthRatio === "number" && Number.isFinite(value.widthRatio)
      ? Math.min(MAX_WIDTH_RATIO, Math.max(MIN_WIDTH_RATIO, value.widthRatio))
      : DEFAULT_WIDTH_RATIO;
    return { selectedId: typeof value?.selectedId === "string" ? value.selectedId : null, widthRatio };
  } catch {
    return { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
  }
}

function writePrefs(parentSessionId: string, prefs: WorkspacePrefs): void {
  try {
    window.localStorage.setItem(prefsKey(parentSessionId), JSON.stringify(prefs));
  } catch {
    // Storage availability is optional; in-memory state remains authoritative.
  }
}

function sortByCreation(summaries: AuxiliarySessionSummary[]): AuxiliarySessionSummary[] {
  return [...summaries].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created || left.id.localeCompare(right.id);
  });
}

function clampWidthRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_WIDTH_RATIO;
  return Math.min(MAX_WIDTH_RATIO, Math.max(MIN_WIDTH_RATIO, ratio));
}

export function useAuxiliaryWorkspace(input: {
  parentSessionId: string | null;
  api: AuxiliaryWorkspaceApi | null;
}): AuxiliaryWorkspace {
  const { parentSessionId, api } = input;
  const parentSessionIdRef = useRef(parentSessionId);
  parentSessionIdRef.current = parentSessionId;
  const [summaries, setSummaries] = useState<AuxiliarySessionSummary[]>([]);
  const summariesRef = useRef<AuxiliarySessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<AuxiliarySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [target, setTargetState] = useState<AuxiliaryWorkspaceTarget>("main");
  const [isExpanded, setIsExpanded] = useState(false);
  const prefsRef = useRef<WorkspacePrefs>(parentSessionId ? readPrefs(parentSessionId) : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO });
  const widthRatioRef = useRef(prefsRef.current.widthRatio);
  const [widthRatio, setWidthRatioState] = useState(widthRatioRef.current);
  const selectedIdRef = useRef<string | null>(null);
  const detailsRef = useRef(new Map<string, AuxiliarySession>());
  const bindingsRef = useRef(new Map<string, AuxiliarySessionBinding>());
  const loadRevisionRef = useRef(0);
  const listRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const detailMutationEpochRef = useRef(new Map<string, number>());
  const terminalRevisionRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const persistPrefs = useCallback((next: Partial<WorkspacePrefs>) => {
    prefsRef.current = { ...prefsRef.current, ...next };
    if (parentSessionId) writePrefs(parentSessionId, prefsRef.current);
  }, [parentSessionId]);

  const refreshSummaries = useCallback(async () => {
    if (!api || !parentSessionId) {
      setSummaries([]);
      setLoading(false);
      return;
    }
    const requestRevision = ++listRevisionRef.current;
    const requestParentId = parentSessionId;
    const requestMutationRevision = mutationRevisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = sortByCreation(await api.listAuxiliarySessions(parentSessionId));
      if (
        !mountedRef.current
        ||
        requestRevision !== listRevisionRef.current
        || requestParentId !== parentSessionIdRef.current
        || requestMutationRevision !== mutationRevisionRef.current
      ) return;
      setSummaries(next);
      summariesRef.current = next;
      const preferred = prefsRef.current.selectedId;
      const nextId = selectedIdRef.current && next.some((summary) => summary.id === selectedIdRef.current)
        ? selectedIdRef.current
        : preferred && next.some((summary) => summary.id === preferred) ? preferred : next[0]?.id ?? null;
      if (nextId !== selectedIdRef.current) {
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
      }
    } catch (cause) {
      if (!mountedRef.current || requestRevision !== listRevisionRef.current || requestMutationRevision !== mutationRevisionRef.current) return;
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      setError(nextError);
    } finally {
      if (requestRevision === listRevisionRef.current && requestMutationRevision === mutationRevisionRef.current) {
        setLoading(false);
      }
    }
  }, [api, parentSessionId]);

  useEffect(() => {
    prefsRef.current = parentSessionId ? readPrefs(parentSessionId) : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
    widthRatioRef.current = prefsRef.current.widthRatio;
    setWidthRatioState(widthRatioRef.current);
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedSession(null);
    summariesRef.current = [];
    setSummaries([]);
    setTargetState("main");
    setIsExpanded(false);
    detailsRef.current.clear();
    bindingsRef.current.clear();
    detailMutationEpochRef.current.clear();
    terminalRevisionRef.current.clear();
    workspaceGenerationRef.current += 1;
    mutationRevisionRef.current += 1;
    listRevisionRef.current += 1;
    setDetailLoading(false);
    setDetailError(null);
    setError(null);
    void refreshSummaries();
  }, [parentSessionId, refreshSummaries]);

  useEffect(() => {
    const id = selectedId;
    const revision = ++loadRevisionRef.current;
    if (!id) {
      setSelectedSession(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const cached = detailsRef.current.get(id) ?? bindingsRef.current.get(id)?.sessionRef.current ?? null;
    if (cached) {
      setSelectedSession(cached);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    setSelectedSession(null);
    setDetailLoading(true);
    setDetailError(null);
    const detailEpoch = detailMutationEpochRef.current.get(id) ?? 0;
    if (!api) {
      setDetailLoading(false);
      return;
    }
    void api.getAuxiliarySession(id).then((session) => {
      if (!mountedRef.current || revision !== loadRevisionRef.current || selectedIdRef.current !== id) return;
      if (session && detailEpoch === (detailMutationEpochRef.current.get(id) ?? 0)) {
        detailsRef.current.set(id, session);
        const binding = bindingsRef.current.get(id);
        if (binding) binding.sessionRef.current = session;
      }
      if (detailEpoch === (detailMutationEpochRef.current.get(id) ?? 0)) {
        if (session) setSelectedSession(session);
        else setDetailError(new Error(`Auxiliary session ${id} was not found`));
      }
      setDetailLoading(false);
    }).catch((cause) => {
      if (!mountedRef.current || revision !== loadRevisionRef.current || selectedIdRef.current !== id) return;
      const detailCause = cause instanceof Error ? cause : new Error(String(cause));
      setDetailError(detailCause);
      setDetailLoading(false);
    });
  }, [api, selectedId]);

  useEffect(() => {
    if (!api?.subscribeLiveSessionRun) return;
    const subscriptionGeneration = workspaceGenerationRef.current;
    return api.subscribeLiveSessionRun((id, state) => {
      if (subscriptionGeneration !== workspaceGenerationRef.current) return;
      if (!summariesRef.current.some((summary) => summary.id === id)) return;
      if (!api) return;
      const terminalRevision = (terminalRevisionRef.current.get(id) ?? 0) + 1;
      terminalRevisionRef.current.set(id, terminalRevision);
      if (state !== null) {
        const nextRunState: AuxiliarySession["runState"] = state.errorMessage ? "error" : "running";
        const currentSummary = summariesRef.current.find((summary) => summary.id === id);
        if (currentSummary?.runState !== nextRunState) {
          const nextSummaries = summariesRef.current.map((summary) => summary.id === id
            ? { ...summary, runState: nextRunState }
            : summary);
          summariesRef.current = nextSummaries;
          setSummaries(nextSummaries);
        }
        const currentDetail = detailsRef.current.get(id);
        if (currentDetail && currentDetail.runState !== nextRunState) {
          const nextDetail = { ...currentDetail, runState: nextRunState };
          detailsRef.current.set(id, nextDetail);
          const binding = bindingsRef.current.get(id);
          if (binding) binding.sessionRef.current = nextDetail;
          if (selectedIdRef.current === id) setSelectedSession(nextDetail);
        }
        return;
      }
      if (!detailsRef.current.has(id)) {
        void refreshSummaries();
        return;
      }
      const terminalEpoch = detailMutationEpochRef.current.get(id) ?? 0;
      void api.getAuxiliarySession(id).then((session) => {
        if (!mountedRef.current || subscriptionGeneration !== workspaceGenerationRef.current || terminalRevision !== terminalRevisionRef.current.get(id) || !session) return;
        if (terminalEpoch !== (detailMutationEpochRef.current.get(id) ?? 0)) return;
        detailsRef.current.set(id, session);
        const binding = bindingsRef.current.get(id);
        if (binding) binding.sessionRef.current = session;
        const nextSummaries = sortByCreation([
          ...summariesRef.current.filter((summary) => summary.id !== id),
          projectAuxiliarySessionSummary(session),
        ]);
        summariesRef.current = nextSummaries;
        setSummaries(nextSummaries);
        if (selectedIdRef.current === id) setSelectedSession(session);
      }).catch((cause) => {
        if (mountedRef.current && subscriptionGeneration === workspaceGenerationRef.current
          && terminalRevision === terminalRevisionRef.current.get(id)) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    });
  }, [api, parentSessionId]);

  const selectSession = useCallback((id: string | null) => {
    if (id !== null && !summaries.some((summary) => summary.id === id)) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedSession(id ? detailsRef.current.get(id) ?? null : null);
    persistPrefs({ selectedId: id });
  }, [persistPrefs, summaries]);

  const setWidthRatio = useCallback((ratio: number) => {
    const next = clampWidthRatio(ratio);
    widthRatioRef.current = next;
    setWidthRatioState(next);
    persistPrefs({ widthRatio: next });
  }, [persistPrefs]);

  const setTarget = useCallback((next: AuxiliaryWorkspaceTarget) => {
    setTargetState(next);
    if (next === "auxiliary" && summaries.length > 0) {
      setIsExpanded(true);
      if (!selectedIdRef.current) selectSession(summaries[0].id);
    }
  }, [selectSession, summaries]);

  const collapse = useCallback(() => {
    setIsExpanded(false);
    setTargetState("main");
  }, []);

  const addSession = useCallback((saved: AuxiliarySession) => {
    if (!parentSessionIdRef.current || saved.parentSessionId !== parentSessionIdRef.current) return;
    mutationRevisionRef.current += 1;
    setLoading(false);
    detailMutationEpochRef.current.set(saved.id, (detailMutationEpochRef.current.get(saved.id) ?? 0) + 1);
    detailsRef.current.set(saved.id, saved);
    const binding = bindingsRef.current.get(saved.id);
    if (binding) binding.sessionRef.current = saved;
    const nextSummaries = sortByCreation([...summariesRef.current.filter((summary) => summary.id !== saved.id), projectAuxiliarySessionSummary(saved)]);
    summariesRef.current = nextSummaries;
    setSummaries(nextSummaries);
    selectedIdRef.current = saved.id;
    setSelectedId(saved.id);
    setSelectedSession(saved);
    setTargetState("auxiliary");
    setIsExpanded(true);
    persistPrefs({ selectedId: saved.id });
  }, [persistPrefs]);

  const getBinding = useCallback((id: string | null): AuxiliarySessionBinding => {
    if (id === null) {
      const emptyId = "__empty__";
      const existingEmpty = bindingsRef.current.get(emptyId);
      if (existingEmpty) return existingEmpty;
      const emptyBinding: AuxiliarySessionBinding = {
        sessionRef: { current: null },
        mutationRevision: { current: 0 },
        draftSaveQueue: { current: Promise.resolve() },
        sessionSaveQueue: { current: Promise.resolve() },
        setSession() {},
        getSession() { return null; },
      };
      bindingsRef.current.set(emptyId, emptyBinding);
      return emptyBinding;
    }
    const existing = bindingsRef.current.get(id);
    if (existing) return existing;
    const bindingGeneration = workspaceGenerationRef.current;
    const binding: AuxiliarySessionBinding = {
      sessionRef: { current: detailsRef.current.get(id) ?? null },
      mutationRevision: { current: 0 },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      setSession(update) {
        if (bindingGeneration !== workspaceGenerationRef.current) return;
        const current = binding.sessionRef.current;
        const next = typeof update === "function" ? update(current) : update;
        binding.sessionRef.current = next;
        detailMutationEpochRef.current.set(id, (detailMutationEpochRef.current.get(id) ?? 0) + 1);
        if (next) detailsRef.current.set(id, next);
        else detailsRef.current.delete(id);
        setSelectedSession((selected) => selected?.id === id ? next : selected);
        const nextSummaries = next
          ? sortByCreation([...summariesRef.current.filter((summary) => summary.id !== id), projectAuxiliarySessionSummary(next)])
          : summariesRef.current.filter((summary) => summary.id !== id);
        summariesRef.current = nextSummaries;
        setSummaries(nextSummaries);
      },
      getSession() {
        return binding.sessionRef.current;
      },
    };
    bindingsRef.current.set(id, binding);
    return binding;
  }, []);

  return useMemo(() => ({
    summaries,
    selectedId,
    selectedSession: selectedSession?.id === selectedId ? selectedSession : null,
    loading,
    error,
    detailLoading,
    detailError,
    target,
    isExpanded,
    widthRatio,
    setWidthRatio,
    selectSession,
    setTarget,
    collapse,
    addSession,
    refreshSummaries,
    getBinding,
  }), [addSession, collapse, detailError, detailLoading, error, getBinding, isExpanded, loading, refreshSummaries, selectSession, selectedId, selectedSession, setTarget, setWidthRatio, summaries, target, widthRatio]);
}
