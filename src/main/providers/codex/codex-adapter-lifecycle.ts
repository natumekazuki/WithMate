import {
  CODEX_ADAPTER_LIMITS,
  type CodexAdapterDiagnostic,
  type CodexAdapterEvent,
  type CodexAdapterThreadSnapshot,
  type CodexAdapterTurnSnapshot,
} from "./codex-adapter-contract.js";
import {
  toAdapterThreadStatus,
  type CodexValidatedThread,
  type CodexValidatedThreadStatus,
} from "./codex-adapter-validation.js";

export type CodexLifecycleResult = Readonly<{
  events: readonly CodexAdapterEvent[];
  fatal: boolean;
}>;

export type CodexLifecycleSnapshot = Readonly<{
  failed: boolean;
  trackedThreads: number;
  activeTurns: number;
  terminalTurnTombstones: number;
}>;

export type CodexThreadLifecycleIdentity = Readonly<{
  workspaceKey: string;
  ephemeral: boolean;
}>;

type ThreadCorrelationIdentity = CodexThreadLifecycleIdentity &
  Readonly<{
    cliVersion: string;
    modelProvider: string;
  }>;

type ThreadState = {
  responseSnapshot: CodexAdapterThreadSnapshot | undefined;
  responseIdentity: ThreadCorrelationIdentity | undefined;
  observedIdentity: ThreadCorrelationIdentity | undefined;
  responseSeen: boolean;
  notificationSeen: boolean;
  lastStatus: CodexAdapterThreadSnapshot["status"] | undefined;
  activeTurn: ActiveTurn | undefined;
};

type ActiveTurn = {
  snapshot: CodexAdapterTurnSnapshot;
  sources: Set<"response" | "notification">;
};

type TerminalStatus = "completed" | "failed" | "interrupted";

export class CodexAdapterLifecycle {
  readonly #threads = new Map<string, ThreadState>();
  readonly #terminalTurns = new Map<string, Map<string, TerminalStatus>>();
  #activeTurnCount = 0;
  #terminalTurnCount = 0;
  #failed = false;

  acceptThreadResponse(
    snapshot: CodexAdapterThreadSnapshot,
    identity: CodexThreadLifecycleIdentity,
  ): CodexLifecycleResult {
    if (this.#failed) return failedResult();
    const correlationIdentity = Object.freeze({
      cliVersion: snapshot.cliVersion,
      modelProvider: snapshot.modelProvider,
      workspaceKey: identity.workspaceKey,
      ephemeral: identity.ephemeral,
    });
    let state = this.#threads.get(snapshot.threadId);
    if (state === undefined) {
      if (this.#threads.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads) return this.#failResourceLimit();
      state = createThreadState();
      this.#threads.set(snapshot.threadId, state);
    }
    if (state.responseSeen) {
      return snapshotsEqual(state.responseSnapshot, snapshot) &&
        threadIdentitiesEqual(state.responseIdentity, correlationIdentity)
        ? diagnosticResult("duplicate_event", "A duplicate Thread response was ignored.")
        : diagnosticResult("identity_mismatch", "A conflicting Thread response was ignored.");
    }
    if (state.observedIdentity !== undefined && !threadIdentitiesEqual(state.observedIdentity, correlationIdentity)) {
      return diagnosticResult("identity_mismatch", "A Thread response conflicted with its observed identity.");
    }
    if (state.responseSnapshot !== undefined) {
      return diagnosticResult("identity_mismatch", "A Thread response conflicted with its observed identity.");
    }
    state.responseSeen = true;
    state.responseSnapshot = snapshot;
    state.responseIdentity = correlationIdentity;
    state.lastStatus ??= snapshot.status;
    const currentSnapshot =
      state.lastStatus === snapshot.status ? snapshot : Object.freeze({ ...snapshot, status: state.lastStatus });
    return eventResult(Object.freeze({ kind: "thread_started", thread: currentSnapshot }));
  }

  acceptThreadStartedNotification(thread: CodexValidatedThread): CodexLifecycleResult {
    if (this.#failed) return failedResult();
    const correlationIdentity = Object.freeze({
      cliVersion: thread.cliVersion,
      modelProvider: thread.modelProvider,
      workspaceKey: thread.workspaceKey,
      ephemeral: thread.ephemeral,
    });
    let state = this.#threads.get(thread.id);
    if (state === undefined) {
      if (this.#threads.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads) return this.#failResourceLimit();
      state = createThreadState();
      this.#threads.set(thread.id, state);
    }
    if (state.notificationSeen) {
      return threadIdentitiesEqual(state.observedIdentity, correlationIdentity)
        ? diagnosticResult("duplicate_event", "A duplicate thread/started notification was ignored.")
        : diagnosticResult("identity_mismatch", "A conflicting thread/started notification was ignored.");
    }
    if (state.responseIdentity !== undefined && !threadIdentitiesEqual(state.responseIdentity, correlationIdentity)) {
      return diagnosticResult("identity_mismatch", "A thread/started notification conflicted with its response.");
    }
    state.notificationSeen = true;
    state.observedIdentity = correlationIdentity;
    state.lastStatus ??= toAdapterThreadStatus(thread.status);
    return emptyResult();
  }

  acceptThreadStatus(threadId: string, status: CodexValidatedThreadStatus): CodexLifecycleResult {
    if (this.#failed) return failedResult();
    const state = this.#threads.get(threadId);
    if (state === undefined) {
      return diagnosticResult("out_of_order_event", "A Thread status for an unknown Thread was ignored.");
    }
    const mapped = toAdapterThreadStatus(status);
    if (state.lastStatus === mapped) {
      return diagnosticResult("duplicate_event", "A duplicate Thread status was ignored.");
    }
    state.lastStatus = mapped;
    return eventResult(Object.freeze({ kind: "thread_status_observed", threadId, status: mapped }));
  }

  acceptTurnStarted(snapshot: CodexAdapterTurnSnapshot, source: "response" | "notification"): CodexLifecycleResult {
    if (this.#failed) return failedResult();
    if (snapshot.status !== "in_progress") {
      return diagnosticResult("out_of_order_event", "A non-running Turn start was ignored.");
    }
    const thread = this.#threads.get(snapshot.threadId);
    if (thread === undefined) {
      return diagnosticResult("out_of_order_event", "A Turn start for an unknown Thread was ignored.");
    }
    const terminal = this.#terminalTurns.get(snapshot.threadId)?.get(snapshot.turnId);
    if (terminal !== undefined) {
      return diagnosticResult("out_of_order_event", "A Turn start after terminal was ignored.");
    }
    if (thread.activeTurn !== undefined) {
      if (thread.activeTurn.snapshot.turnId !== snapshot.turnId) {
        return diagnosticResult("identity_mismatch", "A second active Turn for the same Thread was ignored.");
      }
      if (thread.activeTurn.sources.has(source)) {
        return diagnosticResult("duplicate_event", "A duplicate Turn start was ignored.");
      }
      thread.activeTurn.sources.add(source);
      return emptyResult();
    }
    if (this.#activeTurnCount >= CODEX_ADAPTER_LIMITS.maxTrackedTurns) return this.#failResourceLimit();
    thread.activeTurn = { snapshot, sources: new Set([source]) };
    this.#activeTurnCount += 1;
    return eventResult(Object.freeze({ kind: "turn_started", turn: snapshot }));
  }

  acceptTurnTerminal(threadId: string, turnId: string, status: TerminalStatus): CodexLifecycleResult {
    if (this.#failed) return failedResult();
    const priorTerminal = this.#terminalTurns.get(threadId)?.get(turnId);
    if (priorTerminal !== undefined) {
      return priorTerminal === status
        ? diagnosticResult("duplicate_event", "A duplicate terminal Turn was ignored.")
        : diagnosticResult("out_of_order_event", "A conflicting terminal Turn was ignored.");
    }
    const thread = this.#threads.get(threadId);
    if (thread === undefined) {
      const diagnostic = diagnosticEvent(
        "out_of_order_event",
        "A terminal event for an untracked Thread was retained as a tombstone.",
      );
      if (this.#terminalTurnCount >= CODEX_ADAPTER_LIMITS.maxTerminalTurnTombstones) {
        return this.#failResourceLimit([diagnostic]);
      }
      this.#storeTerminal(threadId, turnId, status);
      return eventResult(diagnostic);
    }
    if (thread.activeTurn === undefined || thread.activeTurn.snapshot.turnId !== turnId) {
      const diagnostic = diagnosticEvent(
        thread.activeTurn === undefined ? "out_of_order_event" : "identity_mismatch",
        thread.activeTurn === undefined
          ? "A terminal event before Turn start was retained as a tombstone."
          : "A terminal event for another Turn was retained as a tombstone.",
      );
      if (this.#terminalTurnCount >= CODEX_ADAPTER_LIMITS.maxTerminalTurnTombstones) {
        return this.#failResourceLimit([diagnostic]);
      }
      this.#storeTerminal(threadId, turnId, status);
      return eventResult(diagnostic);
    }

    const terminalEvent: CodexAdapterEvent = Object.freeze({
      kind: "turn_terminal",
      threadId,
      turnId,
      status,
      finalAssistantMessage: null,
      contentFailure: null,
    });
    thread.activeTurn = undefined;
    this.#activeTurnCount -= 1;
    if (this.#terminalTurnCount >= CODEX_ADAPTER_LIMITS.maxTerminalTurnTombstones) {
      return this.#failResourceLimit([
        Object.freeze({
          ...terminalEvent,
          resourceLimitExceeded: true,
        }),
      ]);
    }
    this.#storeTerminal(threadId, turnId, status);
    return eventResult(terminalEvent);
  }

  isActiveTurn(threadId: string, turnId: string): boolean {
    return this.#threads.get(threadId)?.activeTurn?.snapshot.turnId === turnId;
  }

  hasActiveTurn(threadId: string): boolean {
    return this.#threads.get(threadId)?.activeTurn !== undefined;
  }

  hasTerminalTurn(threadId: string, turnId: string): boolean {
    return this.#terminalTurns.get(threadId)?.has(turnId) ?? false;
  }

  terminalTurnStatus(threadId: string, turnId: string): TerminalStatus | undefined {
    return this.#terminalTurns.get(threadId)?.get(turnId);
  }

  canStartTurn(threadId: string): boolean {
    const thread = this.#threads.get(threadId);
    return thread !== undefined && thread.activeTurn === undefined && thread.lastStatus === "idle";
  }

  activeTurn(threadId: string): CodexAdapterTurnSnapshot | undefined {
    return this.#threads.get(threadId)?.activeTurn?.snapshot;
  }

  hasThread(threadId: string): boolean {
    return this.#threads.has(threadId);
  }

  hasThreadResponse(threadId: string): boolean {
    return this.#threads.get(threadId)?.responseSeen ?? false;
  }

  snapshot(): CodexLifecycleSnapshot {
    return Object.freeze({
      failed: this.#failed,
      trackedThreads: this.#threads.size,
      activeTurns: this.#activeTurnCount,
      terminalTurnTombstones: this.#terminalTurnCount,
    });
  }

  release(): void {
    this.#threads.clear();
    this.#terminalTurns.clear();
    this.#activeTurnCount = 0;
    this.#terminalTurnCount = 0;
    this.#failed = true;
  }

  #storeTerminal(threadId: string, turnId: string, status: TerminalStatus): void {
    let tombstones = this.#terminalTurns.get(threadId);
    if (tombstones === undefined) {
      tombstones = new Map();
      this.#terminalTurns.set(threadId, tombstones);
    }
    tombstones.set(turnId, status);
    this.#terminalTurnCount += 1;
  }

  #failResourceLimit(prefix: readonly CodexAdapterEvent[] = []): CodexLifecycleResult {
    this.#failed = true;
    return Object.freeze({
      events: Object.freeze([
        ...prefix,
        diagnosticEvent("resource_limit", "A Codex lifecycle resource limit was reached."),
        Object.freeze({ kind: "connection_failure", code: "adapter_resource_limit" }),
      ]),
      fatal: true,
    });
  }
}

function createThreadState(): ThreadState {
  return {
    responseSnapshot: undefined,
    responseIdentity: undefined,
    observedIdentity: undefined,
    responseSeen: false,
    notificationSeen: false,
    lastStatus: undefined,
    activeTurn: undefined,
  };
}

function snapshotsEqual(left: CodexAdapterThreadSnapshot | undefined, right: CodexAdapterThreadSnapshot): boolean {
  return (
    left !== undefined &&
    left.threadId === right.threadId &&
    left.status === right.status &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.cliVersion === right.cliVersion &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function threadIdentitiesEqual(left: ThreadCorrelationIdentity | undefined, right: ThreadCorrelationIdentity): boolean {
  return (
    left !== undefined &&
    left.cliVersion === right.cliVersion &&
    left.modelProvider === right.modelProvider &&
    left.workspaceKey === right.workspaceKey &&
    left.ephemeral === right.ephemeral
  );
}

function diagnosticEvent(
  code: CodexAdapterDiagnostic["code"],
  summary: string,
): Readonly<{ kind: "diagnostic"; diagnostic: CodexAdapterDiagnostic }> {
  return Object.freeze({
    kind: "diagnostic",
    diagnostic: Object.freeze({ code, summary, redaction: "not_required" }),
  });
}

function diagnosticResult(code: CodexAdapterDiagnostic["code"], summary: string): CodexLifecycleResult {
  return eventResult(diagnosticEvent(code, summary));
}

function eventResult(event: CodexAdapterEvent): CodexLifecycleResult {
  return Object.freeze({ events: Object.freeze([event]), fatal: false });
}

function emptyResult(): CodexLifecycleResult {
  return Object.freeze({ events: Object.freeze([]), fatal: false });
}

function failedResult(): CodexLifecycleResult {
  return Object.freeze({ events: Object.freeze([]), fatal: true });
}
