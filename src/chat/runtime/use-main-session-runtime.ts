import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
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
  > | null;
  selectedId: string | null;
  composerRegistry: ComposerControllerRegistry;
}) {
  const [sessions, setSessionsBase] = useState<Session[]>([]);
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
      setSessionsBase(update);
    },
    [],
  );
  const setSessionProjection = useCallback(
    (update: SetStateAction<Session[]>) => {
      projectionRevisionRef.current.advance();
      setSessionsBase(update);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    if (!api)
      return () => {
        active = false;
      };
    if (!selectedId) {
      setAuthoritativeSessions([]);
      return () => {
        active = false;
      };
    }
    const hydrate = () => {
      const requestRevision = refetchRevisionRef.current.start();
      const mutationRevision = mutationRevisionRef.current.capture();
      const projectionRevision = projectionRevisionRef.current.capture();
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
        })
        .catch((error) => {
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
        (payload.scope === "ids" && !payload.sessionIds.includes(selectedId))
      )
        return;
      hydrate();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, selectedId, setAuthoritativeSessions]);

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
    pendingSubmitSessionId,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    persistSession,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn,
  };
}
