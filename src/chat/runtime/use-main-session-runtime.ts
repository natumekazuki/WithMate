import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import { getSessionIncarnationId } from "../../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions, type SessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import type { ConfirmedReviewerChange } from "../../../src-shared/session/session-mutation-contract.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
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
import { SessionTurnAcceptance } from "./session-turn-acceptance.js";
import type { AuxiliaryDraftPersistenceOwner } from "../auxiliary-draft-persistence-owner.js";
import { startConversationDetailSubscription } from "./session-summary-subscription.js";
import { toggleMainSessionPin } from "./main-session-mutation-operations.js";

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
    | "enqueueSessionTurn"
    | "retryFailedSessionTurn"
    | "getSessionTurnQueueReceipt"
    | "getLiveSessionRun"
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
  const selectionRequestRevisionRef = useRef(0);
  const mergeLocalSelection = useCallback((next: Session): Session => {
    const selection = localSelectionRef.current;
    if (!selection || selection.id !== next.id) return next;
    if (selection.incarnationId !== getSessionIncarnationId(next)) {
      localSelectionRef.current = null;
      return next;
    }
    return { ...next, ...selection.options };
  }, []);
  const applySessions = useCallback((update: SetStateAction<Session[]>) => {
    setSessionsBase((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      const merged = next.map(mergeLocalSelection);
      currentSessionRef.current = merged.find((session) => session.id === selectedId) ?? null;
      return merged;
    });
  }, [mergeLocalSelection, selectedId]);
  const mutationRevisionRef = useRef(new StateMutationRevision());
  const projectionRevisionRef = useRef(new StateMutationRevision());
  const refetchRevisionRef = useRef(new LatestRequestRevision());
  const submitCoordinatorRef = useRef(new SessionSubmitCoordinator());
  const acceptanceRef = useRef(new SessionTurnAcceptance());
  // The leases are independent: switching conversations must not hide another owner's pending submit.
  const [, notifySubmitState] = useState(0);
  const submitStateChanged = useCallback(() => notifySubmitState((current) => current + 1), []);
  const observeTurnReceipts = useCallback((receipts: readonly SessionTurnQueueReceipt[]) => {
    let recovered = false;
    for (const receipt of receipts) {
      if (acceptanceRef.current.observeReceipt(receipt, composerRegistry)) recovered = true;
    }
    if (recovered) submitStateChanged();
  }, [composerRegistry, submitStateChanged]);
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

  const selectExecutionOptions = useCallback((session: Session, confirmedReviewerChange?: ConfirmedReviewerChange) => {
    const options = captureSessionExecutionOptions(session);
    const incarnationId = getSessionIncarnationId(session);
    const revision = ++selectionRequestRevisionRef.current;
    localSelectionRef.current = { id: session.id, incarnationId, options };
    currentSessionRef.current = session;
    applySessions((current) => current.map((candidate) => candidate.id === session.id ? { ...candidate, ...options } : candidate));
    if (api) {
      void api.setSessionExecutionOptions({ sessionId: session.id, incarnationId, executionOptions: options,
        ...(confirmedReviewerChange ? { confirmedReviewerChange } : {}) })
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
    const unsubscribe = startConversationDetailSubscription({
      api,
      ownerSessionId: selectedId,
      onChange: hydrate,
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, selectedId, setAuthoritativeSessions, readRevision]);

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
      queueTurn?: boolean;
      auxiliaryDraftOwner?: AuxiliaryDraftPersistenceOwner;
      isCurrentSubmission?: () => boolean;
      onSubmitted?: () => void;
      shouldCollapseActionDock: boolean;
      selectedSessionRunState: Session["runState"] | null;
      blockedReason: string | null;
      isReadOnly: boolean;
      validateWorkspace: () => Promise<unknown>;
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
        acceptance: acceptanceRef.current,
        queueTurn: input.queueTurn,
        auxiliaryDraftOwner: input.auxiliaryDraftOwner,
        isCurrentSubmission: input.isCurrentSubmission,
        onSubmitted: input.onSubmitted,
        clearDraft: input.clearDraft,
        collapseActionDock: input.shouldCollapseActionDock,
        selectedSessionRunState: input.selectedSessionRunState,
        blockedReason: input.blockedReason,
        isReadOnly: input.isReadOnly,
        validateWorkspace: input.validateWorkspace,
        state: {
          setComposerPreview: (preview) =>
            composerRegistry.setPreview(input.composerOwner, preview),
          onSubmitStateChanged: submitStateChanged,
          setForceComposerBlockedFeedback,
          collapseActionDock: input.collapseActionDock,
          commitSubmission: (publish) => flushSync(publish),
        },
        log: input.log,
      }),
    [api, composerRegistry, submitStateChanged],
  );

  const resolveUncertainTurn = async (retry: boolean, ownerId: string | null, incarnationId?: string) => {
    if (!api || !ownerId) return;
    if (retry && composerRegistry.isFrozen) return;
    const lease = submitCoordinatorRef.current.tryAcquire(ownerId);
    if (!lease) return;
    submitStateChanged();
    try {
      const receipt = retry
        ? await acceptanceRef.current.retry(api, ownerId, composerRegistry, incarnationId)
        : await acceptanceRef.current.check(api, ownerId, composerRegistry, incarnationId);
      setReadRevision((current) => current + 1);
      if (!receipt && acceptanceRef.current.hasUncertain(ownerId, incarnationId)) throw new Error("No receipt is available yet. Retry Original Turn uses the same request identity and captured input.");
    } finally {
      lease.release();
      submitStateChanged();
    }
  };

  const submitFailedRetry = async (request: import("../../../src-shared/session/session-turn-queue.js").RetryFailedSessionTurnRequest) => {
    if (!api || composerRegistry.isFrozen) throw new Error("Failed Turn retry is unavailable.");
    const ownerId = request.target.sessionId;
    const lease = submitCoordinatorRef.current.tryAcquire(ownerId);
    if (!lease) throw new Error("Another submission is in progress.");
    submitStateChanged();
    try {
      return await acceptanceRef.current.submitFailedRetry(api, ownerId, request);
    } finally {
      lease.release();
      submitStateChanged();
      setReadRevision((current) => current + 1);
    }
  };

  return {
    sessions,
    readStatus: readState.ownerId === selectedId ? readState.status : "loading" as const,
    readError: readState.ownerId === selectedId ? readState.error : "",
    retryRead: () => setReadRevision((current) => current + 1),
    getCurrentSession: () => currentSessionRef.current,
    selectExecutionOptions,
    updateSessionProjection: (sessionId: string, patch: (current: Session) => Session) => {
      const current = currentSessionRef.current;
      if (current?.id === sessionId) currentSessionRef.current = patch(current);
      setSessionProjection((sessions) => sessions.map((session) => session.id === sessionId ? patch(session) : session));
    },
    hasPendingSubmitFor: (sessionId: string | null) => sessionId ? submitCoordinatorRef.current.isClaimed(sessionId) : false,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn,
    submitFailedRetry,
    turnSubmissions: acceptanceRef.current.submissions,
    observeTurnReceipts,
    hasUncertainTurnFor: (sessionId: string | null, incarnationId?: string) => sessionId ? acceptanceRef.current.hasUncertain(sessionId, incarnationId) : false,
    resendRecoveryError: (sessionId: string, incarnationId: string) => acceptanceRef.current.resendRecoveryError(sessionId, incarnationId),
    checkTurnReceipt: (sessionId: string | null = selectedId, incarnationId?: string) => resolveUncertainTurn(false, sessionId, incarnationId),
    retryOriginalTurn: (sessionId: string | null = selectedId, incarnationId?: string) => resolveUncertainTurn(true, sessionId, incarnationId),
  };
}
