import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunDispatchService,
  type ApplicationRunDispatchWritePort,
} from "../src/main/application-run-dispatch-service.js";
import type {
  ApplicationRunAttemptEventPort,
  ApplicationRunStartTurnResult,
} from "../src/main/application-run-event-service.js";
import type {
  ApplicationRunDispatchControl,
  ApplicationRunDispatchFailure,
  ApplicationRunBindingOwnership,
  ApplicationRunPreparedDispatch,
} from "../src/main/application-run-runtime-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type { CodexStartTurnInput } from "../src/main/providers/codex/index.js";
import type {
  RepositoryCommandResult,
  RunDispatchBeginCommand,
  RunDispatchBeginResult,
  RunDispatchResolutionCommand,
  RunDispatchResolutionResult,
} from "../src/shared/repository-write-model.js";

test("Dispatch commits before Provider send, registers one owner, and waits for attempt release", async () => {
  const order: string[] = [];
  const inputs: CodexStartTurnInput[] = [];
  const attempt = attemptPort({
    settle(result) {
      order.push(`settle-${result.kind}`);
    },
    delayedDone: true,
  });
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin(command) {
        order.push("dispatch-begin");
        return beginSuccess(command, true);
      },
    }),
    attempts: attempt.port,
  });
  const fixture = dispatchControl({
    startTurn(input) {
      order.push("turn-start");
      inputs.push(input);
      return acceptedTurn("turn-1");
    },
  });

  const ready = service.ready(preparedDispatch(), fixture.control);
  await waitFor(() => attempt.results.length === 1);
  assert.equal(await settled(ready), false);
  attempt.release();
  await ready;

  assert.deepEqual(order, ["dispatch-begin", "turn-start", "settle-accepted"]);
  assert.deepEqual(attempt.registrations, [preparedDispatch()]);
  assert.deepEqual(inputs, [
    {
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "hello" }],
      workspacePath: workspacePath(),
      approvalPolicy: "never",
      sandboxPolicy: {
        mode: "workspace-write",
        networkAccess: false,
        writableRoots: [workspacePath(), additionalDirectory()],
      },
      model: "gpt-5.6",
      modelSelection: "explicit",
      reasoningEffort: "high",
    },
  ]);
});

test("an ephemeral Binding owner token is preserved across Dispatch begin and pre-send resolution", async () => {
  const begins: RunDispatchBeginCommand[] = [];
  const resolutions: RunDispatchResolutionCommand[] = [];
  let currentChecks = 0;
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin(command) {
        begins.push(command);
        return beginSuccess(command, true);
      },
      resolve(command) {
        resolutions.push(command);
        return resolutionSuccess(command);
      },
    }),
    attempts: attemptPort().port,
  });
  const fixture = dispatchControl({
    current() {
      currentChecks += 1;
      return currentChecks === 1;
    },
    startTurn: () => acceptedTurn("turn-1"),
  });

  await service.ready(
    preparedDispatch({
      ownership: {
        persistenceMode: "ephemeral",
        ephemeralOwnerToken: EPHEMERAL_OWNER_TOKEN,
      },
    }),
    fixture.control,
  );

  assert.equal(begins[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(resolutions[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.deepEqual(resolutions[0]?.outcome, { kind: "rejected" });
});

test("a retry sends its exact source Run model with inherited Provider selection provenance", async () => {
  const inputs: CodexStartTurnInput[] = [];
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({ begin: (command) => beginSuccess(command, true) }),
    attempts: attemptPort().port,
  });
  const fixture = dispatchControl({
    startTurn(input) {
      inputs.push(input);
      return acceptedTurn("turn-1");
    },
  });

  await service.ready(preparedDispatch({ modelSelection: "inherited" }), fixture.control);

  assert.equal(inputs[0]?.model, "gpt-5.6");
  assert.equal(inputs[0]?.modelSelection, "inherited");
  assert.equal(inputs[0]?.reasoningEffort, "high");
});

test("sendAllowed false and a replayed dispatching Gate never send a second Provider request", async () => {
  let dispatching = false;
  let starts = 0;
  let registrations = 0;
  const attempt = attemptPort({
    register() {
      registrations += 1;
    },
  });
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin(command) {
        if (!dispatching) {
          dispatching = true;
          return beginSuccess(command, true);
        }
        return beginSuccess(command, false);
      },
    }),
    attempts: attempt.port,
  });
  const fixture = dispatchControl({
    startTurn() {
      starts += 1;
      return { kind: "ambiguous", effect: "unknown", code: "connection_lost" };
    },
  });

  await service.ready(preparedDispatch(), fixture.control);
  await service.ready(preparedDispatch(), fixture.control);

  assert.equal(starts, 1);
  assert.equal(registrations, 1);
  assert.deepEqual(fixture.terminals, []);
});

test("Dispatch begin response loss converges to a frozen pre-send rejection without Provider mutation", async () => {
  const begins: RunDispatchBeginCommand[] = [];
  const resolutions: RunDispatchResolutionCommand[] = [];
  let starts = 0;
  let registrations = 0;
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin(command) {
        begins.push(command);
        if (begins.length <= 4) throw unknownPersistenceFailure();
        return beginSuccess(command, false);
      },
      resolve(command) {
        resolutions.push(command);
        return resolutionSuccess(command);
      },
    }),
    attempts: attemptPort({
      register() {
        registrations += 1;
      },
    }).port,
  });
  const fixture = dispatchControl({
    startTurn() {
      starts += 1;
      return acceptedTurn("turn-1");
    },
  });

  await service.ready(preparedDispatch(), fixture.control);
  assert.deepEqual(service.pendingRunIds(), ["run-1"]);
  assert.equal(await service.retryPending("run-1"), true);
  assert.deepEqual(service.pendingRunIds(), ["run-1"]);
  assert.equal(await service.flushPending(), true);

  assert.equal(begins.length, 5);
  assert.ok(begins.every((command) => JSON.stringify(command) === JSON.stringify(begins[0])));
  assert.equal(starts, 0);
  assert.equal(registrations, 0);
  assert.deepEqual(
    resolutions.map((command) => command.outcome.kind),
    ["rejected"],
  );
  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(service.pendingRunIds(), []);
});

test("a retryable effect-none Dispatch begin failure retains its owner until the frozen command succeeds", async () => {
  const begins: RunDispatchBeginCommand[] = [];
  let starts = 0;
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin(command) {
        begins.push(command);
        if (begins.length <= 2) throw retryablePersistenceFailure();
        return beginSuccess(command, true);
      },
    }),
    attempts: attemptPort().port,
  });
  const fixture = dispatchControl({
    startTurn() {
      starts += 1;
      return acceptedTurn("turn-1");
    },
  });

  await service.ready(preparedDispatch(), fixture.control);
  assert.deepEqual(service.pendingRunIds(), ["run-1"]);
  assert.equal(starts, 0);
  assert.deepEqual(fixture.terminals, []);

  assert.equal(await service.retryPending("run-1"), true);
  assert.deepEqual(service.pendingRunIds(), ["run-1"]);
  assert.equal(starts, 0);

  assert.equal(await service.flushPending(), true);
  assert.equal(begins.length, 3);
  assert.ok(begins.every((command) => JSON.stringify(command) === JSON.stringify(begins[0])));
  assert.equal(starts, 1);
  assert.deepEqual(service.pendingRunIds(), []);
});

test("Dispatch persistence owners are bounded before another begin can start", async () => {
  let begins = 0;
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin() {
        begins += 1;
        throw unknownPersistenceFailure();
      },
    }),
    attempts: attemptPort().port,
    maxOwnedRuns: 1,
  });
  const first = dispatchControl({ startTurn: () => acceptedTurn("turn-1") });
  const second = dispatchControl({ startTurn: () => acceptedTurn("turn-2") });

  await service.ready(preparedDispatch(), first.control);
  await service.ready(
    preparedDispatch({ sessionId: "session-2", runId: "run-2", attemptId: "attempt-2", bindingId: "binding-2" }),
    second.control,
  );

  assert.equal(begins, 2);
  assert.deepEqual(service.pendingRunIds(), ["run-1"]);
  assert.equal(second.terminals[0]?.preDispatchResolution, "dispatch_not_sent");
  assert.equal(second.terminals[0]?.failureOrigin, "application");
});

test("a stale generation cannot cross either side of the durable begin Gate", async (context) => {
  await context.test("before begin", async () => {
    let begins = 0;
    const service = new ApplicationRunDispatchService({
      writes: dispatchWrites({
        begin(command) {
          begins += 1;
          return beginSuccess(command, true);
        },
      }),
      attempts: attemptPort().port,
    });
    const fixture = dispatchControl({
      current: () => false,
      startTurn: () => acceptedTurn("turn-1"),
    });
    await service.ready(preparedDispatch(), fixture.control);
    assert.equal(begins, 0);
    assert.deepEqual(fixture.terminals, [
      {
        preDispatchResolution: "dispatch_not_sent",
        outcomeKind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: null,
        errorSummary: "Provider connection ended before execution.",
      },
    ]);
  });

  await context.test("after begin", async () => {
    let currentChecks = 0;
    let starts = 0;
    const resolutions: RunDispatchResolutionCommand[] = [];
    const service = new ApplicationRunDispatchService({
      writes: dispatchWrites({
        begin: (command) => beginSuccess(command, true),
        resolve(command) {
          resolutions.push(command);
          return resolutionSuccess(command);
        },
      }),
      attempts: attemptPort().port,
    });
    const fixture = dispatchControl({
      current() {
        currentChecks += 1;
        return currentChecks === 1;
      },
      startTurn() {
        starts += 1;
        return acceptedTurn("turn-1");
      },
    });
    await service.ready(preparedDispatch(), fixture.control);
    assert.equal(starts, 0);
    assert.deepEqual(resolutions[0]?.outcome, { kind: "rejected" });
    assert.equal(fixture.terminals[0]?.preDispatchResolution, "not_applicable");
  });
});

test("attempt capacity rejection resolves the durable Gate before terminalizing and never sends", async () => {
  const order: string[] = [];
  let starts = 0;
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin: (command) => beginSuccess(command, true),
      resolve(command) {
        order.push(`resolve-${command.outcome.kind}`);
        return resolutionSuccess(command);
      },
    }),
    attempts: {
      register() {
        return null;
      },
    },
  });
  const fixture = dispatchControl({
    startTurn() {
      starts += 1;
      return acceptedTurn("turn-1");
    },
    terminalize(failure) {
      order.push("terminal");
      fixture.terminals.push(failure);
    },
  });

  await service.ready(preparedDispatch(), fixture.control);

  assert.equal(starts, 0);
  assert.deepEqual(order, ["resolve-rejected", "terminal"]);
  assert.equal(fixture.terminals[0]?.outcomeKind, "failed");
  assert.equal(fixture.terminals[0]?.failureOrigin, "application");
});

test("an unconfirmed pre-send rejection automatically retries its frozen owner", async () => {
  const resolutions: RunDispatchResolutionCommand[] = [];
  const fixture = dispatchControl({
    startTurn() {
      assert.fail("startTurn must not be sent when attempt ownership is unavailable");
    },
  });
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({
      begin: (command) => beginSuccess(command, true),
      resolve(command) {
        resolutions.push(command);
        if (resolutions.length <= 2) throw unknownPersistenceFailure();
        return resolutionSuccess(command);
      },
    }),
    attempts: { register: () => null },
  });

  await service.ready(preparedDispatch(), fixture.control);
  assert.equal(fixture.terminals.length, 0);
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(resolutions.length, 3);
  assert.deepEqual(resolutions[0], resolutions[1]);
  assert.deepEqual(resolutions[1], resolutions[2]);
  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(service.pendingRunIds(), []);
});

test("a thrown Provider mutation is handed to the attempt owner as ambiguous", async () => {
  const attempt = attemptPort();
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({ begin: (command) => beginSuccess(command, true) }),
    attempts: attempt.port,
  });
  const fixture = dispatchControl({
    startTurn() {
      throw new Error("connection failed");
    },
  });

  await service.ready(preparedDispatch(), fixture.control);

  assert.deepEqual(attempt.results, [{ kind: "ambiguous", effect: "unknown", code: "connection_lost" }]);
});

test("interleaved Sessions register their own Run, Binding, Thread, and generation owner tuple", async () => {
  const attempt = attemptPort();
  const service = new ApplicationRunDispatchService({
    writes: dispatchWrites({ begin: (command) => beginSuccess(command, true) }),
    attempts: attempt.port,
  });
  const first = dispatchControl({ startTurn: () => acceptedTurn("turn-1") });
  const second = dispatchControl({ startTurn: () => acceptedTurn("turn-2", "thread-2") });

  await Promise.all([
    service.ready(preparedDispatch(), first.control),
    service.ready(
      preparedDispatch({
        sessionId: "session-2",
        runId: "run-2",
        attemptId: "attempt-2",
        bindingId: "binding-2",
        threadId: "thread-2",
      }),
      second.control,
    ),
  ]);

  assert.deepEqual(
    attempt.registrations.map((value) => ({
      sessionId: value.admission.sessionId,
      runId: value.admission.runId,
      attemptId: value.admission.attemptId,
      bindingId: value.admission.bindingId,
      threadId: value.threadId,
      generationId: value.generationId,
    })),
    [
      {
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "attempt-1",
        bindingId: "binding-1",
        threadId: "thread-1",
        generationId: "codex-1",
      },
      {
        sessionId: "session-2",
        runId: "run-2",
        attemptId: "attempt-2",
        bindingId: "binding-2",
        threadId: "thread-2",
        generationId: "codex-1",
      },
    ],
  );
});

function attemptPort(
  options: Readonly<{
    delayedDone?: boolean;
    register?(dispatch: ApplicationRunPreparedDispatch): void;
    settle?(result: ApplicationRunStartTurnResult): void | Promise<void>;
  }> = {},
): Readonly<{
  port: ApplicationRunAttemptEventPort;
  registrations: ApplicationRunPreparedDispatch[];
  results: ApplicationRunStartTurnResult[];
  release(): void;
}> {
  const registrations: ApplicationRunPreparedDispatch[] = [];
  const results: ApplicationRunStartTurnResult[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    registrations,
    results,
    release,
    port: {
      register(dispatch) {
        registrations.push(dispatch);
        options.register?.(dispatch);
        return {
          async settleStartTurn(result) {
            results.push(result);
            await options.settle?.(result);
          },
          done: options.delayedDone === true ? delayed : Promise.resolve(),
        };
      },
    },
  };
}

function dispatchWrites(
  overrides: Readonly<{
    begin?(
      command: RunDispatchBeginCommand,
    ): RepositoryCommandResult<RunDispatchBeginResult> | Promise<RepositoryCommandResult<RunDispatchBeginResult>>;
    resolve?(
      command: RunDispatchResolutionCommand,
    ):
      | RepositoryCommandResult<RunDispatchResolutionResult>
      | Promise<RepositoryCommandResult<RunDispatchResolutionResult>>;
  }>,
): ApplicationRunDispatchWritePort {
  return {
    async beginRunDispatch(command) {
      if (overrides.begin === undefined) throw new Error("unexpected dispatch begin");
      return overrides.begin(command);
    },
    async resolveRunDispatch(command) {
      if (overrides.resolve === undefined) throw new Error("unexpected dispatch resolution");
      return overrides.resolve(command);
    },
  };
}

function dispatchControl(
  options: Readonly<{
    current?(): boolean;
    startTurn(input: CodexStartTurnInput): ApplicationRunStartTurnResult | Promise<ApplicationRunStartTurnResult>;
    terminalize?(failure: ApplicationRunDispatchFailure): void | Promise<void>;
  }>,
): Readonly<{
  control: ApplicationRunDispatchControl;
  terminals: ApplicationRunDispatchFailure[];
}> {
  const terminals: ApplicationRunDispatchFailure[] = [];
  return {
    terminals,
    control: {
      adapter: {
        async startThread() {
          throw new Error("unexpected Thread start");
        },
        async resumeThread() {
          throw new Error("unexpected Thread resume");
        },
        async startTurn(input) {
          return options.startTurn(input);
        },
        async nextEvent() {
          throw new Error("unexpected event read");
        },
        async close() {},
      },
      signal: new AbortController().signal,
      isCurrent: options.current ?? (() => true),
      async terminalize(failure) {
        if (options.terminalize === undefined) terminals.push(failure);
        else await options.terminalize(failure);
        return true;
      },
    },
  };
}

function preparedDispatch(
  overrides: Readonly<{
    sessionId?: string;
    runId?: string;
    attemptId?: string;
    bindingId?: string;
    threadId?: string;
    modelSelection?: "explicit" | "inherited";
    ownership?: ApplicationRunBindingOwnership;
  }> = {},
): ApplicationRunPreparedDispatch {
  const sessionId = overrides.sessionId ?? "session-1";
  const runId = overrides.runId ?? "run-1";
  const ownership = overrides.ownership ?? {
    persistenceMode: "persistent" as const,
    ephemeralOwnerToken: null,
  };
  const dispatch: Omit<ApplicationRunPreparedDispatch, "persistenceMode" | "ephemeralOwnerToken"> = {
    admission: {
      sessionId,
      messageId: `message-${runId}`,
      runId,
      attemptId: overrides.attemptId ?? "attempt-1",
      bindingId: overrides.bindingId ?? "binding-1",
      runPhase: "queued",
      bindingState: "active",
      dispatchState: "pending",
      admittedAt: 1,
    },
    workspaceKey: "workspace-1",
    providerId: "codex",
    threadId: overrides.threadId ?? "thread-1",
    generationId: "codex-1",
    executionSnapshot: {
      providerId: "codex",
      definitionVersion: "codex-provider-v1",
      modelSelection: overrides.modelSelection ?? "explicit",
      settings: {
        model: "gpt-5.6",
        reasoningEffort: "high",
        approvalPolicy: "never",
        sandbox: { mode: "workspace-write", networkAccess: false },
      },
      workspace: {
        key: "workspace-1",
        path: workspacePath(),
        allowedAdditionalDirectories: [additionalDirectory()],
      },
      character: null,
    },
    contentBlocks: [{ type: "text", text: "hello" }],
  };
  return ownership.persistenceMode === "persistent"
    ? { ...dispatch, persistenceMode: "persistent", ephemeralOwnerToken: null }
    : {
        ...dispatch,
        persistenceMode: "ephemeral",
        ephemeralOwnerToken: ownership.ephemeralOwnerToken,
      };
}

const EPHEMERAL_OWNER_TOKEN = "018f1f4e-7f0a-7000-8000-000000000901";

function beginSuccess(
  command: RunDispatchBeginCommand,
  sendAllowed: boolean,
): Extract<RepositoryCommandResult<RunDispatchBeginResult>, { ok: true }> {
  return {
    ok: true,
    replayed: !sendAllowed,
    value: {
      sessionId: command.sessionId,
      runId: command.runId,
      attemptId: command.attemptId,
      bindingId: command.bindingId,
      runPhase: "starting",
      dispatchState: "dispatching",
      dispatchingAt: 10,
      sendAllowed,
    },
  };
}

function resolutionSuccess(
  command: RunDispatchResolutionCommand,
): Extract<RepositoryCommandResult<RunDispatchResolutionResult>, { ok: true }> {
  return {
    ok: true,
    replayed: false,
    value: {
      sessionId: command.sessionId,
      runId: command.runId,
      attemptId: command.attemptId,
      bindingId: command.bindingId,
      dispatchState: command.outcome.kind,
      externalExecutionId: command.outcome.kind === "accepted" ? command.outcome.externalExecutionId : null,
      resolvedAt: 20,
    },
  };
}

function acceptedTurn(turnId: string, threadId = "thread-1"): ApplicationRunStartTurnResult {
  return {
    kind: "accepted",
    effect: "present",
    value: { threadId, turnId, status: "in_progress" },
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

function workspacePath(): string {
  return process.platform === "win32" ? "C:\\workspace" : "/workspace";
}

function additionalDirectory(): string {
  return process.platform === "win32" ? "C:\\shared" : "/shared";
}

function unknownPersistenceFailure(): PersistenceClientError {
  return new PersistenceClientError({
    code: "request_timeout",
    message: "response lost",
    retryable: true,
    effect: "unknown",
  });
}

function retryablePersistenceFailure(): PersistenceClientError {
  return new PersistenceClientError({
    code: "queue_full",
    message: "Persistence request queue is full.",
    retryable: true,
    effect: "none",
  });
}
