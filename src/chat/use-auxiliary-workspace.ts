import { createElement, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  projectAuxiliarySessionSummary,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ConcurrentChatWindowProps } from "./chat-window.js";
import type { ConversationColumnSession, ConversationMessageColumnApi } from "./conversation-message-column.js";
import type { SessionMessageColumnProps } from "./conversation/session-message-column.js";
import type { MessageArtifact } from "../../src-shared/session/session-state.js";
import { CharacterAvatar } from "../ui/ui-utils.js";

export type AuxiliaryWorkspaceApi = {
  listAuxiliarySessions(parentSessionId: string): Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession | null>;
  getAuxiliarySessionStatus(auxiliarySessionId: string): Promise<Pick<AuxiliarySession, "id" | "parentSessionId" | "createdAt" | "runState"> | null>;
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
  widthRatio: number;
  setWidthRatio(ratio: number): void;
  selectSession(id: string | null): void;
  requestSessionSelection(id: string): void;
  setTarget(target: AuxiliaryWorkspaceTarget): void;
  addSession(saved: AuxiliarySession): void;
  refreshSummaries(): Promise<void>;
  touchRecency(id: string, updatedAt: string): void;
  getBinding(id: string | null): AuxiliarySessionBinding;
  buildConcurrentChats(input: AuxiliaryConcurrentChatSurfaceInput): ConcurrentChatWindowProps;
};

export type AuxiliaryConcurrentChatSurfaceInput = {
  mainSession: ConversationColumnSession | null;
  auxiliarySession: ConversationColumnSession | null;
  api?: ConversationMessageColumnApi;
  mainLiveRun?: LiveSessionRunState | null;
  auxiliaryLiveRun?: LiveSessionRunState | null;
  messageColumn: SessionMessageColumnProps;
  mainOnToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
  mainOnLoadArtifactDetail?: (index: number) => Promise<MessageArtifact | null>;
  mainOnOpenPath?: (target: string) => void;
  auxiliaryOnToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
  auxiliaryOnLoadArtifactDetail?: (index: number) => Promise<MessageArtifact | null>;
  auxiliaryOnOpenPath?: (target: string) => void;
  onAddAuxiliary?: () => void;
  isAddAuxiliaryDisabled?: boolean;
  scrollToLatestOnSend?: boolean;
};

const DEFAULT_WIDTH_RATIO = 0;
const PREFS_KEY_PREFIX = "withmate:auxiliary-workspace:";

type WorkspacePrefs = { selectedId: string | null; widthRatio: number };

function prefsKey(parentSessionId: string): string {
  return `${PREFS_KEY_PREFIX}${parentSessionId}`;
}

function readPrefs(parentSessionId: string): WorkspacePrefs {
  try {
    const value = JSON.parse(window.localStorage.getItem(prefsKey(parentSessionId)) ?? "null") as Partial<WorkspacePrefs> | null;
    const widthRatio = typeof value?.widthRatio === "number" && Number.isFinite(value.widthRatio)
      ? clampAuxiliaryWidthRatio(value.widthRatio)
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

function sortByLastUsed(summaries: AuxiliarySessionSummary[], recency?: ReadonlyMap<string, string>): AuxiliarySessionSummary[] {
  return [...summaries].sort((left, right) => {
    const leftTime = recency?.get(left.id);
    const rightTime = recency?.get(right.id);
    const updated = (rightTime && rightTime > right.updatedAt ? rightTime : right.updatedAt)
      .localeCompare(leftTime && leftTime > left.updatedAt ? leftTime : left.updatedAt);
    return updated || right.id.localeCompare(left.id);
  });
}

function sameSummary(left: AuxiliarySessionSummary, right: AuxiliarySessionSummary): boolean {
  const keys = Object.keys(right) as Array<keyof AuxiliarySessionSummary>;
  return Object.keys(left).length === keys.length && keys.every((key) => {
    if (key === "allowedAdditionalDirectories") {
      return left[key].length === right[key].length && left[key].every((value, index) => value === right[key][index]);
    }
    return left[key] === right[key];
  });
}

function replaceSummary(
  current: AuxiliarySessionSummary[],
  id: string,
  next: AuxiliarySessionSummary | null,
  recency?: ReadonlyMap<string, string>,
): AuxiliarySessionSummary[] {
  const index = current.findIndex((summary) => summary.id === id);
  if (index < 0) return next ? sortByLastUsed([...current, next], recency) : current;
  if (next && sameSummary(current[index], next)) return current;
  const updated = current.slice();
  if (!next) updated.splice(index, 1);
  else updated[index] = next;
  return next && current[index].updatedAt !== next.updatedAt ? sortByLastUsed(updated, recency) : updated;
}

export function clampAuxiliaryWidthRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_WIDTH_RATIO;
  return Math.min(1, Math.max(0, ratio));
}

export function useAuxiliaryWorkspace(input: {
  parentSessionId: string | null;
  api: AuxiliaryWorkspaceApi | null;
  initialSelectedId?: string | null;
}): AuxiliaryWorkspace {
  const { parentSessionId, api, initialSelectedId } = input;
  const normalizedInitialSelectedId = initialSelectedId?.trim() || null;
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
  const prefsRef = useRef<WorkspacePrefs>(parentSessionId ? readPrefs(parentSessionId) : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO });
  const widthRatioRef = useRef(prefsRef.current.widthRatio);
  const [widthRatio, setWidthRatioState] = useState(widthRatioRef.current);
  const selectedIdRef = useRef<string | null>(null);
  const requestedSelectionRef = useRef<string | null>(null);
  const pendingSelectionIdRef = useRef<string | null>(normalizedInitialSelectedId);
  const detailsRef = useRef(new Map<string, AuxiliarySession>());
  const bindingsRef = useRef(new Map<string, AuxiliarySessionBinding>());
  const loadRevisionRef = useRef(0);
  const listRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const detailMutationEpochRef = useRef(new Map<string, number>());
  const terminalRevisionRef = useRef(new Map<string, number>());
  const recencyRef = useRef(new Map<string, string>());
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
      const next = sortByLastUsed(await api.listAuxiliarySessions(parentSessionId), recencyRef.current);
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
      const requested = requestedSelectionRef.current;
      const requestedId = pendingSelectionIdRef.current;
      const hasRequestedId = requestedId !== null && next.some((summary) => summary.id === requestedId);
      const hasLegacyRequestedId = requested !== null && next.some((summary) => summary.id === requested);
      const nextId = requested !== null
        ? requested
        : hasRequestedId
          ? requestedId
          : selectedIdRef.current && next.some((summary) => summary.id === selectedIdRef.current)
            ? selectedIdRef.current
            : preferred && next.some((summary) => summary.id === preferred) ? preferred : next[0]?.id ?? null;
      if (hasRequestedId) {
        pendingSelectionIdRef.current = null;
        persistPrefs({ selectedId: nextId });
      }
      if (hasLegacyRequestedId) {
        requestedSelectionRef.current = null;
      }
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
  }, [api, parentSessionId, persistPrefs]);

  useEffect(() => {
    prefsRef.current = parentSessionId ? readPrefs(parentSessionId) : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
    widthRatioRef.current = prefsRef.current.widthRatio;
    setWidthRatioState(widthRatioRef.current);
    selectedIdRef.current = null;
    requestedSelectionRef.current = null;
    pendingSelectionIdRef.current = normalizedInitialSelectedId;
    setSelectedId(null);
    setSelectedSession(null);
    summariesRef.current = [];
    setSummaries([]);
    setTargetState("main");
    detailsRef.current.clear();
    bindingsRef.current.clear();
    detailMutationEpochRef.current.clear();
    terminalRevisionRef.current.clear();
    recencyRef.current.clear();
    workspaceGenerationRef.current += 1;
    mutationRevisionRef.current += 1;
    listRevisionRef.current += 1;
    setDetailLoading(false);
    setDetailError(null);
    setError(null);
    void refreshSummaries();
  }, [initialSelectedId, parentSessionId, refreshSummaries]);

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
        if (session) {
          setSelectedSession(session);
          setDetailError(null);
        } else {
          setDetailError(new Error(`Auxiliary session ${id} was not found`));
        }
      }
      setDetailLoading(false);
    }).catch((cause) => {
      if (!mountedRef.current || revision !== loadRevisionRef.current || selectedIdRef.current !== id) return;
      if (detailEpoch !== (detailMutationEpochRef.current.get(id) ?? 0)) return;
      const detailCause = cause instanceof Error ? cause : new Error(String(cause));
      setDetailError(detailCause);
      setDetailLoading(false);
    });
  }, [api, selectedId]);

  useEffect(() => {
    if (!api?.subscribeLiveSessionRun) return;
    const subscriptionGeneration = workspaceGenerationRef.current;
    const statusRequests = new Map<string, { pending: boolean }>();
    const terminalLoads = new Map<string, number>();
    const applySession = (id: string, session: AuxiliarySession, terminalRevision: number, terminalEpoch: number) => {
      if (!mountedRef.current || subscriptionGeneration !== workspaceGenerationRef.current
        || terminalRevision !== terminalRevisionRef.current.get(id)
        || terminalEpoch !== (detailMutationEpochRef.current.get(id) ?? 0)) return;
      const nextSummaries = replaceSummary(summariesRef.current, id, projectAuxiliarySessionSummary(session), recencyRef.current);
      if (nextSummaries !== summariesRef.current) {
        summariesRef.current = nextSummaries;
        setSummaries(nextSummaries);
      }
      detailsRef.current.set(id, session);
      const binding = bindingsRef.current.get(id);
      if (binding) binding.sessionRef.current = session;
      if (selectedIdRef.current === id) {
        setSelectedSession(session);
        setDetailLoading(false);
        setDetailError(null);
      }
    };
    const refreshStatus = (id: string) => {
      const existing = statusRequests.get(id);
      if (existing) {
        existing.pending = true;
        return;
      }
      const request = { pending: false };
      statusRequests.set(id, request);
      const revision = terminalRevisionRef.current.get(id);
      const epoch = detailMutationEpochRef.current.get(id) ?? 0;
      void api.getAuxiliarySessionStatus(id).then((status) => {
        if (!mountedRef.current || subscriptionGeneration !== workspaceGenerationRef.current
          || revision !== terminalRevisionRef.current.get(id)
          || epoch !== (detailMutationEpochRef.current.get(id) ?? 0) || !status) return;
        const summary = summariesRef.current.find((item) => item.id === id);
        if (!summary || summary.parentSessionId !== status.parentSessionId || summary.createdAt !== status.createdAt) return;
        if (status.runState === "running" && terminalLoads.has(id)) {
          // A confirmed new run supersedes an earlier terminal read. Retained live
          // state with an idle status must not discard that read's final messages.
          detailMutationEpochRef.current.set(id, epoch + 1);
        }
        const nextSummaries = replaceSummary(summariesRef.current, id, { ...summary, runState: status.runState }, recencyRef.current);
        if (nextSummaries !== summariesRef.current) {
          summariesRef.current = nextSummaries;
          setSummaries(nextSummaries);
        }
        const detail = detailsRef.current.get(id);
        if (detail && detail.runState !== status.runState) {
          const next = { ...detail, runState: status.runState };
          detailsRef.current.set(id, next);
          const binding = bindingsRef.current.get(id);
          if (binding) binding.sessionRef.current = next;
          if (selectedIdRef.current === id) setSelectedSession(next);
        }
      }).catch((cause) => {
        if (mountedRef.current && subscriptionGeneration === workspaceGenerationRef.current
          && revision === terminalRevisionRef.current.get(id)) {
          console.error("Failed to refresh Auxiliary session run state", cause);
        }
      }).finally(() => {
        statusRequests.delete(id);
        if (request.pending && mountedRef.current && subscriptionGeneration === workspaceGenerationRef.current) refreshStatus(id);
      });
    };
    return api.subscribeLiveSessionRun((id, state) => {
      if (subscriptionGeneration !== workspaceGenerationRef.current) return;
      if (!summariesRef.current.some((summary) => summary.id === id)) return;
      if (!api) return;
      if (state !== null) {
        refreshStatus(id);
        return;
      }
      const terminalRevision = (terminalRevisionRef.current.get(id) ?? 0) + 1;
      terminalRevisionRef.current.set(id, terminalRevision);
      terminalLoads.set(id, terminalRevision);
      const pendingStatus = statusRequests.get(id);
      if (pendingStatus) pendingStatus.pending = false;
      const terminalStartEpoch = detailMutationEpochRef.current.get(id) ?? 0;
      void api.getAuxiliarySession(id).then((session) => {
        if (!mountedRef.current || subscriptionGeneration !== workspaceGenerationRef.current
          || terminalRevision !== terminalRevisionRef.current.get(id)) return;
        if (state === null) {
          if (terminalStartEpoch !== (detailMutationEpochRef.current.get(id) ?? 0)) return;
          mutationRevisionRef.current += 1;
          setLoading(false);
          const resolvedEpoch = terminalStartEpoch + 1;
          detailMutationEpochRef.current.set(id, resolvedEpoch);
          if (session) {
            applySession(id, session, terminalRevision, resolvedEpoch);
            return;
          }
          detailsRef.current.delete(id);
          const binding = bindingsRef.current.get(id);
          if (binding) binding.sessionRef.current = null;
          if (selectedIdRef.current === id) {
            setSelectedSession(null);
            setDetailLoading(false);
            setDetailError(new Error(`Auxiliary session ${id} was not found`));
          }
          void refreshSummaries();
          return;
        }
      }).catch((cause) => {
        if (mountedRef.current && subscriptionGeneration === workspaceGenerationRef.current
          && terminalRevision === terminalRevisionRef.current.get(id)) {
          const detailCause = cause instanceof Error ? cause : new Error(String(cause));
          if (selectedIdRef.current === id) {
            setDetailLoading(false);
            setDetailError(detailCause);
          }
        }
      }).finally(() => {
        if (terminalLoads.get(id) === terminalRevision) terminalLoads.delete(id);
      });
    });
  }, [api, parentSessionId, refreshSummaries]);

  const touchRecency = useCallback((id: string, updatedAt: string) => {
    const current = summariesRef.current;
    const recordedTime = recencyRef.current.get(id);
    if (recordedTime && updatedAt <= recordedTime) return;
    if (current[0]?.id === id) {
      if (updatedAt > current[0].updatedAt) recencyRef.current.set(id, updatedAt);
      return;
    }
    const index = current.findIndex((summary) => summary.id === id);
    if (index < 0) return;
    const previousTime = recencyRef.current.get(id) ?? current[index].updatedAt;
    if (updatedAt <= previousTime) return;
    recencyRef.current.set(id, updatedAt);
    const next = current.slice();
    next.splice(index, 1);
    const nextIndex = next.findIndex((summary) => {
      const recorded = recencyRef.current.get(summary.id);
      const time = recorded && recorded > summary.updatedAt ? recorded : summary.updatedAt;
      return updatedAt > time || (updatedAt === time && id.localeCompare(summary.id) > 0);
    });
    const insertionIndex = nextIndex < 0 ? next.length : nextIndex;
    if (insertionIndex === index) return;
    next.splice(insertionIndex, 0, { ...current[index], updatedAt });
    mutationRevisionRef.current += 1;
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const selectSession = useCallback((id: string | null) => {
    if (id !== null && !summaries.some((summary) => summary.id === id)) {
      pendingSelectionIdRef.current = id;
      void refreshSummaries();
      return;
    }
    pendingSelectionIdRef.current = null;
    requestedSelectionRef.current = null;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedSession(id ? detailsRef.current.get(id) ?? null : null);
    persistPrefs({ selectedId: id });
  }, [persistPrefs, refreshSummaries, summaries]);

  const requestSessionSelection = useCallback((id: string) => {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return;
    }
    requestedSelectionRef.current = normalizedId;
    selectedIdRef.current = normalizedId;
    setSelectedId(normalizedId);
    setSelectedSession(detailsRef.current.get(normalizedId) ?? null);
    setTargetState("auxiliary");
    persistPrefs({ selectedId: normalizedId });
  }, [persistPrefs]);

  const setWidthRatio = useCallback((ratio: number) => {
    const next = clampAuxiliaryWidthRatio(ratio);
    widthRatioRef.current = next;
    setWidthRatioState(next);
    persistPrefs({ widthRatio: next });
  }, [persistPrefs]);

  const setTarget = useCallback((next: AuxiliaryWorkspaceTarget) => {
    setTargetState(next);
  }, []);

  const addSession = useCallback((saved: AuxiliarySession) => {
    if (!parentSessionIdRef.current || saved.parentSessionId !== parentSessionIdRef.current) return;
    mutationRevisionRef.current += 1;
    setLoading(false);
    detailMutationEpochRef.current.set(saved.id, (detailMutationEpochRef.current.get(saved.id) ?? 0) + 1);
    detailsRef.current.set(saved.id, saved);
    const binding = bindingsRef.current.get(saved.id);
    if (binding) binding.sessionRef.current = saved;
    const nextSummaries = sortByLastUsed([...summariesRef.current.filter((summary) => summary.id !== saved.id), projectAuxiliarySessionSummary(saved)], recencyRef.current);
    summariesRef.current = nextSummaries;
    setSummaries(nextSummaries);
    selectedIdRef.current = saved.id;
    setSelectedId(saved.id);
    setSelectedSession(saved);
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
        if (next === current) return;
        binding.sessionRef.current = next;
        detailMutationEpochRef.current.set(id, (detailMutationEpochRef.current.get(id) ?? 0) + 1);
        if (next) detailsRef.current.set(id, next);
        else detailsRef.current.delete(id);
        setSelectedSession((selected) => selected?.id === id ? next : selected);
        const nextSummaries = replaceSummary(summariesRef.current, id, next ? projectAuxiliarySessionSummary(next) : null, recencyRef.current);
        if (nextSummaries !== summariesRef.current) {
          summariesRef.current = nextSummaries;
          setSummaries(nextSummaries);
        }
      },
      getSession() {
        return binding.sessionRef.current;
      },
    };
    bindingsRef.current.set(id, binding);
    return binding;
  }, []);

  const buildConcurrentChats = useCallback((input: AuxiliaryConcurrentChatSurfaceInput): ConcurrentChatWindowProps => {
    const mainSessionId = input.mainSession?.id ?? input.messageColumn.sessionId;
    const mainMessages = input.mainSession?.messages ?? input.messageColumn.messages;
    const auxiliaryMessages = input.auxiliarySession?.messages ?? [];
    const main = {
      ...input.messageColumn,
      sessionId: mainSessionId,
      messages: mainMessages,
      onToggleMessageBookmark: input.mainOnToggleMessageBookmark,
      onLoadArtifactDetail: input.mainOnLoadArtifactDetail,
      onOpenPath: input.mainOnOpenPath,
    };
    const auxiliary = input.auxiliarySession
      ? {
          ...input.messageColumn,
          sessionId: input.auxiliarySession.id,
          messages: auxiliaryMessages,
          onToggleMessageBookmark: input.auxiliaryOnToggleMessageBookmark,
          onLoadArtifactDetail: input.auxiliaryOnLoadArtifactDetail,
          onOpenPath: input.auxiliaryOnOpenPath,
        }
      : null;

    return {
      main,
      auxiliary,
      mainSession: input.mainSession,
      auxiliarySession: input.auxiliarySession,
      api: input.api,
      mainLiveRun: input.mainLiveRun,
      auxiliaryLiveRun: input.auxiliaryLiveRun,
      selectedAuxiliaryId: selectedId,
      auxiliaryItems: summaries.map((summary) => ({
        id: summary.id,
        label: summary.preview?.trim() || "New conversation",
        searchText: summary.preview?.trim() || "New conversation",
        icon: createElement(CharacterAvatar, {
          character: { name: "", iconPath: summary.characterIconPath ?? "" },
          size: "tiny",
        }),
        isProcessing: summary.runState === "running",
      })),
      onAddAuxiliary: input.onAddAuxiliary,
      isAddAuxiliaryDisabled: input.isAddAuxiliaryDisabled,
      target,
      widthRatio,
      scrollToLatestOnSend: input.scrollToLatestOnSend,
      onSelectAuxiliary: selectSession,
      onTargetChange: setTarget,
      onWidthRatioChange: setWidthRatio,
      loading: loading || detailLoading,
      error: detailError?.message ?? error?.message ?? null,
    };
  }, [detailError, detailLoading, error, loading, selectSession, selectedId, setTarget, setWidthRatio, summaries, target, widthRatio]);

  return useMemo(() => ({
    summaries,
    selectedId,
    selectedSession: selectedSession?.id === selectedId ? selectedSession : null,
    loading,
    error,
    detailLoading,
    detailError,
    target,
    widthRatio,
    setWidthRatio,
    selectSession,
    requestSessionSelection,
    setTarget,
    addSession,
    refreshSummaries,
    touchRecency,
    getBinding,
    buildConcurrentChats,
  }), [addSession, buildConcurrentChats, detailError, detailLoading, error, getBinding, loading, refreshSummaries, requestSessionSelection, selectSession, selectedId, selectedSession, setTarget, setWidthRatio, summaries, target, touchRecency, widthRatio]);
}
