import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import { getSessionIncarnationId } from "../../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions, type SessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import { applyExecutionOptionsCatalog } from "../../../src-shared/session/execution-options-catalog.js";
import type { ModelCatalogSnapshot } from "../../../src-shared/settings/model-catalog.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { ReadStatus } from "../../ui/loading-indicator.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
} from "../composer-controller.js";
import {
  mergeRefetchedSessionProjection,
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
} from "./session-submit-coordinator.js";
import { runMainSessionTurnOperation } from "./run-main-session-turn-operation.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";
import {
  persistMainSession,
  toggleMainSessionPin,
} from "./main-session-mutation-operations.js";

type LiveRunPort = {
  getRevision: () => number;
  setState: (
    update: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState,
  ) => void;
};

export function useMainSessionRuntime({
  api,
  selectedId,
  composerRegistry,
  onExecutionOptionsError,
}: {
  api: Pick<
    WithMateWindowApi,
    | "getSession"
    | "subscribeSessionInvalidation"
    | "reportRendererLog"
    | "previewComposerInput"
    | "runSessionTurn"
    | "getLiveSessionRun"
    | "updateSession"
    | "setSessionPinned"
    | "setSessionExecutionOptions"
  > | null;
  selectedId: string | null;
  composerRegistry: ComposerControllerRegistry;
  onExecutionOptionsError?: (sessionId: string, message: string) => void;
}) {
  const [sessions, setSessionsBase] = useState<Session[]>([]);
  const [readRevision, setReadRevision] = useState(0);
  const [readState, setReadState] = useState<{ ownerId: string | null; status: ReadStatus; error: string }>({
    ownerId: selectedId, status: "loading", error: "",
  });
  const currentSessionRef = useRef<Session | null>(null);
  const localSelectionRef = useRef<{ id: string; incarnationId: string; options: SessionExecutionOptions } | null>(null);
  const activeCatalogRef = useRef<ModelCatalogSnapshot | null>(null);
  const selectionRequestRevisionRef = useRef(0);
  const mergeLocalSelection = useCallback((next: Session): Session => {
    const selection = localSelectionRef.current;
    if (!selection || selection.id !== next.id) return applyExecutionOptionsCatalog(next, activeCatalogRef.current);
    if (selection.incarnationId !== getSessionIncarnationId(next)) {
      localSelectionRef.current = null;
      return applyExecutionOptionsCatalog(next, activeCatalogRef.current);
    }
    return applyExecutionOptionsCatalog({ ...next, ...selection.options }, activeCatalogRef.current);
  }, []);
  const applySessions = useCallback((update: SetStateAction<Session[]>) => {
    setSessionsBase((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      const merged = next.map(mergeLocalSelection);
      currentSessionRef.current = merged.find((session) => session.id === selectedId) ?? null;
      return merged;
    });
  }, [mergeLocalSelection, selectedId]);
  const applyModelCatalog = useCallback((catalog: ModelCatalogSnapshot) => {
    activeCatalogRef.current = catalog;
    applySessions((current) => current);
  }, [applySessions]);
  const mutationRevisionRef = useRef(new StateMutationRevision());
  const projectionRevisionRef = useRef(new StateMutationRevision());
  const refetchRevisionRef = useRef(new LatestRequestRevision());
  const submitCoordinatorRef = useRef(new SessionSubmitCoordinator());
  const [pendingSubmitSessionId, setPendingSubmitSessionId] = useState<
    string | null
  >(null);
  const [forceComposerBlockedFeedback, setForceComposerBlockedFeedback] =
    useState(false);
  const [isSessionPinPending, setIsSessionPinPending] = useState(false);

  const setAuthoritativeSessions = useCallback(
    (update: SetStateAction<Session[]>) => {
      mutationRevisionRef.current.advance();
      applySessions(update);
    },
    [applySessions],
  );
  const setSessionProjection = useCallback(
    (update: SetStateAction<Session[]>) => {
      projectionRevisionRef.current.advance();
      applySessions(update);
    },
    [applySessions],
  );

  const selectExecutionOptions = useCallback((session: Session) => {
    const options = captureSessionExecutionOptions(session);
    const incarnationId = getSessionIncarnationId(session);
    const revision = ++selectionRequestRevisionRef.current;
    localSelectionRef.current = { id: session.id, incarnationId, options };
    currentSessionRef.current = session;
    applySessions((current) => current.map((candidate) => candidate.id === session.id ? { ...candidate, ...options } : candidate));
    if (api) {
      void api.setSessionExecutionOptions({ sessionId: session.id, incarnationId, executionOptions: options })
        .then((result) => {
          if (result.status === "accepted" && !result.checkpointSaved) {
            void api.reportRendererLog({ level: "error", kind: "renderer.session-execution-options.failed", message: "Session execution options could not be saved", data: { sessionId: session.id } });
          }
        })
        .catch((error) => {
          if (selectionRequestRevisionRef.current !== revision || currentSessionRef.current?.id !== session.id
            || getSessionIncarnationId(currentSessionRef.current) !== incarnationId) return;
          const message = error instanceof Error ? error.message : String(error);
          onExecutionOptionsError?.(session.id, `Execution options were not changed: ${message}`);
          void api.getSession(session.id).then((accepted) => {
            if (selectionRequestRevisionRef.current !== revision || currentSessionRef.current?.id !== session.id
              || getSessionIncarnationId(currentSessionRef.current) !== incarnationId) return;
            if (accepted && getSessionIncarnationId(accepted) !== incarnationId) return;
            if (!accepted) {
              localSelectionRef.current = null;
              setAuthoritativeSessions((sessions) => selectionRequestRevisionRef.current === revision ? [] : sessions);
              return;
            }
            const acceptedOptions = captureSessionExecutionOptions(accepted);
            localSelectionRef.current = { id: session.id, incarnationId, options: acceptedOptions };
            applySessions((sessions) => sessions.map((candidate) => candidate.id === session.id
              && getSessionIncarnationId(candidate) === incarnationId
              ? { ...candidate, ...acceptedOptions } : candidate));
          }).catch(() => undefined);
        });
    }
    return session;
  }, [api, applySessions, onExecutionOptionsError, setAuthoritativeSessions]);

  useEffect(() => {
    let active = true;
    if (!api)
      return () => {
        active = false;
      };
    if (!selectedId) {
      setAuthoritativeSessions([]);
      setReadState({ ownerId: selectedId, status: "ready", error: "" });
      return () => {
        active = false;
      };
    }
    const hydrate = () => {
      const requestRevision = refetchRevisionRef.current.start();
      const mutationRevision = mutationRevisionRef.current.capture();
      const projectionRevision = projectionRevisionRef.current.capture();
      setReadState({ ownerId: selectedId, status: "loading", error: "" });
      void api
        .getSession(selectedId)
        .then((session) => {
          if (
            !active ||
            !refetchRevisionRef.current.isCurrent(requestRevision) ||
            !mutationRevisionRef.current.isCurrent(mutationRevision)
          )
            return;
          setAuthoritativeSessions((current) =>
            session
              ? [
                  mergeRefetchedSessionProjection(
                    current.find((candidate) => candidate.id === session.id) ??
                      null,
                    session,
                    !projectionRevisionRef.current.isCurrent(
                      projectionRevision,
                    ),
                  ),
                ]
              : [],
          );
          setReadState({ ownerId: selectedId, status: "ready", error: "" });
        })
        .catch((error) => {
          if (!active || !refetchRevisionRef.current.isCurrent(requestRevision)
            || !mutationRevisionRef.current.isCurrent(mutationRevision)) return;
          setReadState({
            ownerId: selectedId, status: "error",
            error: `Conversation could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
          void api?.reportRendererLog({
            level: "error",
            kind: "renderer.session-refetch.failed",
            message: "Session refetch failed",
            data: { sessionId: selectedId },
            error: {
              name: error instanceof Error ? error.name : "UnknownError",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
    };
    hydrate();
    const unsubscribe = api.subscribeSessionInvalidation((payload) => {
      if (
        !active ||
        payload.detailChanged === false ||
        (payload.scope === "ids" && !payload.sessionIds.includes(selectedId))
      )
        return;
      hydrate();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, selectedId, setAuthoritativeSessions, readRevision]);

  const persistSession = useCallback(
    async (session: Session, isReadOnly: boolean) => {
      const savedSession = await persistMainSession({
        api,
        session,
        isReadOnly,
      });
      setAuthoritativeSessions(() => [savedSession]);
      return savedSession;
    },
    [api, setAuthoritativeSessions],
  );

  const toggleSessionPin = useCallback(
    async (session: Session) => {
      if (isSessionPinPending) return null;
      setIsSessionPinPending(true);
      try {
        const saved = await toggleMainSessionPin({ api, session });
        setSessionProjection((current) =>
          current.map((candidate) =>
            candidate.id === saved.id
              ? { ...candidate, isPinned: saved.isPinned }
              : candidate,
          ),
        );
        return saved;
      } finally {
        setIsSessionPinPending(false);
      }
    },
    [api, isSessionPinPending, setSessionProjection],
  );

  const runMainSessionTurn = useCallback(
    async (input: {
      sessionId: string;
      selectedSession: Session;
      request: RunSessionTurnRequest;
      composerOwner: ComposerOwner;
      clearDraft: boolean;
      shouldCollapseActionDock: boolean;
      isCentralPreviewActive: boolean;
      hasLiveRun: boolean;
      selectedSessionRunState: Session["runState"] | null;
      blockedReason: string | null;
      isReadOnly: boolean;
      currentTimestamp: string;
      validateWorkspace: () => Promise<unknown>;
      liveRun: LiveRunPort;
      acknowledgePreviewChatMessageCount: (
        sessionId: string,
        count: number,
      ) => void;
      collapseActionDock: () => void;
      log: (event: string, details: Record<string, unknown>) => void;
    }) =>
      runMainSessionTurnOperation({
        api,
        sessionId: input.sessionId,
        selectedSession: input.selectedSession,
        request: input.request,
        composerRegistry,
        composerOwner: input.composerOwner,
        submitCoordinator: submitCoordinatorRef.current,
        clearDraft: input.clearDraft,
        collapseActionDock: input.shouldCollapseActionDock,
        isCentralPreviewActive: input.isCentralPreviewActive,
        hasLiveRun: input.hasLiveRun,
        selectedSessionRunState: input.selectedSessionRunState,
        blockedReason: input.blockedReason,
        isReadOnly: input.isReadOnly,
        currentTimestamp: input.currentTimestamp,
        validateWorkspace: input.validateWorkspace,
        state: {
          setAuthoritativeSessions,
          setLiveRunState: input.liveRun.setState,
          setComposerPreview: (preview) =>
            composerRegistry.setPreview(input.composerOwner, preview),
          acknowledgePreviewChatMessageCount:
            input.acknowledgePreviewChatMessageCount,
          setPendingSubmitSessionId,
          setForceComposerBlockedFeedback,
          collapseActionDock: input.collapseActionDock,
        },
        revisions: {
          mutation: mutationRevisionRef.current,
          projection: projectionRevisionRef.current,
          liveRun: {
            capture: input.liveRun.getRevision,
            isCurrent: (revision) => input.liveRun.getRevision() === revision,
          },
        },
        log: input.log,
      }),
    [api, composerRegistry, setAuthoritativeSessions],
  );

  return {
    sessions,
    readStatus: readState.ownerId === selectedId ? readState.status : "loading" as const,
    readError: readState.ownerId === selectedId ? readState.error : "",
    retryRead: () => setReadRevision((current) => current + 1),
    applyModelCatalog,
    getCurrentSession: () => currentSessionRef.current,
    selectExecutionOptions,
    updateSessionProjection: (sessionId: string, patch: (current: Session) => Session) => {
      const current = currentSessionRef.current;
      if (current?.id === sessionId) currentSessionRef.current = patch(current);
      setSessionProjection((sessions) => sessions.map((session) => session.id === sessionId ? patch(session) : session));
    },
    pendingSubmitSessionId,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    persistSession,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn,
  };
}
