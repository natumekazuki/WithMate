import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../src/shared/allowed-additional-directories.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../src/shared/application-run-payload-limits.js";
import type { TextContentBlock } from "../src/shared/message-content.js";
import type { RecoveryCandidate } from "../src/shared/repository-read-model.js";
import type { RepositoryCommandResult, RunExecutionSnapshot } from "../src/shared/repository-write-model.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";
import type {
  CodexAppServerTransport,
  CodexAdapterEvent,
  CodexAdapterCapabilityPreflightInput,
  CodexAdapterCapabilityPreflightResult,
  CodexAdapterInterruptAcknowledgement,
  CodexAdapterMutationResult,
  CodexAdapterReadResult,
  CodexAdapterReadThreadSnapshot,
  CodexAdapterThreadSnapshot,
  CodexAdapterTurnSnapshot,
  CodexInterruptTurnInput,
  CodexReadThreadInput,
  CodexResumeThreadInput,
  CodexStartThreadInput,
  CodexStartTurnInput,
} from "../src/main/providers/codex/index.js";
import {
  ApplicationRunRuntimeShutdownPendingError,
  ApplicationRunRuntimeService,
  type ApplicationRunDispatchReadyPort,
  type ApplicationRunProviderAdapterPort,
  type ApplicationRunProviderEventPort,
  type ApplicationRunProviderRuntimeFactory,
  type ApplicationRunRuntimeReadPort,
  type ApplicationRunRuntimeWritePort,
} from "../src/main/application-run-runtime-service.js";
import type { ApplicationRunAdmissionRecord } from "../src/main/application-run-admission-service.js";
import { ApplicationRunProviderRuntimeStartupError } from "../src/main/application-run-provider-failure.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import {
  CodexApplicationRunRuntimeFactory,
  WITHMATE_CODEX_EXECUTABLE_ENV,
  resolveConfiguredCodexExecutable,
  observeCodexCliVersion,
} from "../src/main/runtime-codex-provider.js";

const TEST_WORKSPACE = resolveWorkspaceIdentity(workspacePath())!;

test("startup recovery does not start a Provider runtime when no candidate exists", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({
    factory,
    reads: runtimeReadsWithCandidates([]),
  });

  await fixture.owner.recoverStartup();

  assert.equal(factory.starts, 0);
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.turnInputs.length, 0);
  await fixture.owner.shutdown();
});

test("startup recovery re-drives only an exact persistent pending Dispatch once", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedThread("thread-1") });
  let dispatched = false;
  const reads = {
    ...runtimeReads(() => recoveryProjection()),
    async recoveryCandidatesPage() {
      return { items: [recoveryCandidate()] };
    },
    async recoveryGet(input: Parameters<ApplicationRunRuntimeReadPort["recoveryGet"]>[0]) {
      return {
        ...recoveryProjection({ bindingState: "active", externalConversationId: "thread-1" }),
        runId: input.runId,
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        runPhase: dispatched ? ("active" as const) : ("queued" as const),
        attemptState: dispatched ? "active" : "preparing",
        dispatchState: dispatched ? ("accepted" as const) : ("pending" as const),
        externalExecutionId: dispatched ? "turn-1" : null,
      };
    },
  } satisfies ApplicationRunRuntimeReadPort;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads,
    dispatchReady: {
      async ready(dispatch, control) {
        await control.adapter.startTurn({
          threadId: dispatch.threadId,
          contentBlocks: dispatch.contentBlocks,
        });
        dispatched = true;
      },
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 1);
  assert.equal(adapter.turnInputs.length, 1);
  await fixture.owner.shutdown();
});

test("startup recovery terminalizes uncertain local ownership without Provider mutations", async () => {
  const candidates = [
    recoveryCandidate({
      attemptProviderBindingId: null,
      bindingState: "creating",
      externalConversationId: null,
    }),
    recoveryCandidate({
      attemptProviderBindingId: null,
      bindingState: "creating",
      persistenceMode: "ephemeral",
      externalConversationId: null,
    }),
    recoveryCandidate({
      runPhase: "starting",
      dispatchState: "ambiguous",
      externalSideEffectState: "unknown",
    }),
    recoveryCandidate({
      runPhase: "active",
      attemptState: "active",
      dispatchState: "accepted",
      externalSideEffectState: "present",
      externalExecutionId: "turn-1",
      persistenceMode: "ephemeral",
    }),
  ];

  for (const candidate of candidates) {
    const adapter = new FakeAdapter();
    const fixture = runtimeFixture({
      factory: runtimeFactory(adapter),
      reads: runtimeReadsWithCandidates([candidate]),
    });

    await fixture.owner.recoverStartup();

    assert.equal(fixture.terminals.length, 1);
    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
    if (candidate.bindingState === "creating") {
      assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_ambiguous");
    }
    assert.equal(adapter.startInputs.length, 0);
    assert.equal(adapter.resumeInputs.length, 0);
    assert.equal(adapter.turnInputs.length, 0);
    await fixture.owner.shutdown();
  }
});

test("startup recovery reattaches an exact active persistent Turn before resuming its Thread", async () => {
  const order: string[] = [];
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  const originalResume = adapter.resumeThread.bind(adapter);
  adapter.resumeThread = async (input) => {
    order.push("resume");
    return originalResume(input);
  };
  let registered = 0;
  const events: ApplicationRunProviderEventPort = {
    accept() {},
    registerRecovered(_dispatch, _control, externalExecutionId, runVersion) {
      order.push("register");
      registered += 1;
      assert.equal(externalExecutionId, "turn-1");
      assert.equal(runVersion, 4);
      return { attached: Promise.resolve(true), async fail() {}, done: new Promise<void>(() => {}) };
    },
    releaseGeneration() {},
  };
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate()]),
    events,
  });

  await fixture.owner.recoverStartup();

  assert.deepEqual(order, ["register", "resume"]);
  assert.equal(registered, 1);
  assert.deepEqual(adapter.readInputs, [{ threadId: "thread-1", includeTurns: true }]);
  assert.equal(adapter.resumeInputs.length, 1);
  assert.equal(adapter.turnInputs.length, 0);
  assert.equal(fixture.terminals.length, 0);
  await fixture.owner.shutdown();
});

test("startup recovery terminalizes when an active Turn becomes idle before resume", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedThread("thread-1") });
  let failures = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate()]),
    events: {
      accept() {},
      registerRecovered() {
        return {
          attached: new Promise<boolean>(() => {}),
          async fail() {
            failures += 1;
          },
          done: new Promise<void>(() => {}),
        };
      },
      releaseGeneration() {},
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(failures, 1);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(adapter.turnInputs.length, 0);
  await fixture.owner.shutdown();
});

test("startup recovery retires a generation whose Thread resume result is ambiguous", async () => {
  const adapter = new FakeAdapter({
    resumeResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  let failures = 0;
  let released = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate()]),
    events: {
      accept() {},
      registerRecovered() {
        return {
          attached: new Promise<boolean>(() => {}),
          async fail() {
            failures += 1;
          },
          done: new Promise<void>(() => {}),
        };
      },
      releaseGeneration() {
        released += 1;
      },
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(failures, 1);
  assert.equal(adapter.closeCalls, 1);
  assert.equal(released, 1);
  await fixture.owner.shutdown();
});

test("startup recovery bounds an active resume that never emits the exact Turn", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  let failures = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate()]),
    limits: { recoveryAttachTimeoutMs: 10 },
    events: {
      accept() {},
      registerRecovered() {
        return {
          attached: new Promise<boolean>(() => {}),
          async fail() {
            failures += 1;
          },
          done: new Promise<void>(() => {}),
        };
      },
      releaseGeneration() {},
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(failures, 1);
  assert.equal(adapter.closeCalls, 0);
  await fixture.owner.shutdown();
});

test("startup recovery terminalizes contradictory active evidence without retiring a healthy Provider generation", async () => {
  const adapter = new FakeAdapter({
    readResult: {
      kind: "accepted",
      effect: "none",
      value: {
        threadId: "thread-1",
        status: "active",
        cliVersion: "0.145.0",
        turns: [{ turnId: "other-turn", status: "in_progress", itemCount: 0 }],
      },
    },
  });
  let registered = 0;
  let released = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate()]),
    events: {
      accept() {},
      registerRecovered() {
        registered += 1;
        return null;
      },
      releaseGeneration() {
        released += 1;
      },
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(registered, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(released, 0);
  await fixture.owner.shutdown();
});

test("one contradictory recovery candidate does not retire an already attached sibling Run", async () => {
  const attached = acceptedRecoveryCandidate();
  const contradictory = acceptedRecoveryCandidate({
    runId: "run-2",
    sessionId: "session-2",
    initiatingMessageId: "message-2",
    runCreatedAt: 2,
    runUpdatedAt: 2,
    attemptId: "attempt-2",
    attemptProviderBindingId: "binding-2",
    bindingId: "binding-2",
    bindingSessionId: "session-2",
    bindingCreatorAttemptId: "attempt-2",
    bindingCreatorRunId: "run-2",
    bindingCreatorSessionId: "session-2",
    externalConversationId: "thread-2",
    externalExecutionId: "turn-2",
  });
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  adapter.readThread = async (input) => {
    adapter.readInputs.push(input);
    return input.threadId === "thread-1"
      ? {
          kind: "accepted",
          effect: "none",
          value: {
            threadId: "thread-1",
            status: "active",
            cliVersion: "0.145.0",
            turns: [{ turnId: "turn-1", status: "in_progress", itemCount: 0 }],
          },
        }
      : {
          kind: "accepted",
          effect: "none",
          value: {
            threadId: "thread-2",
            status: "active",
            cliVersion: "0.145.0",
            turns: [{ turnId: "other-turn", status: "in_progress", itemCount: 0 }],
          },
        };
  };
  let registered = 0;
  let released = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([attached, contradictory]),
    events: {
      accept() {},
      registerRecovered() {
        registered += 1;
        return { attached: Promise.resolve(true), async fail() {}, done: new Promise<void>(() => {}) };
      },
      releaseGeneration() {
        released += 1;
      },
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(registered, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.runId, "run-2");
  assert.equal(adapter.closeCalls, 0);
  assert.equal(released, 0);
  await fixture.owner.shutdown();
});

test("startup recovery resumes cancellation only after exact active Turn attachment", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate({ runPhase: "canceling", cancelRequestedAt: 3 })]),
    events: {
      accept() {},
      registerRecovered() {
        return { attached: Promise.resolve(true), async fail() {}, done: new Promise<void>(() => {}) };
      },
      releaseGeneration() {},
    },
  });

  await fixture.owner.recoverStartup();

  assert.deepEqual(adapter.interruptInputs, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(adapter.turnInputs.length, 0);
  await fixture.owner.shutdown();
});

test("startup recovery does not interrupt when the exact Turn terminal settles before resume", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  let failures = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate({ runPhase: "canceling", cancelRequestedAt: 3 })]),
    events: {
      accept() {},
      registerRecovered() {
        return {
          attached: Promise.resolve(true),
          async fail() {
            failures += 1;
          },
          done: Promise.resolve(),
        };
      },
      releaseGeneration() {},
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(adapter.interruptInputs.length, 0);
  assert.equal(failures, 0);
  assert.equal(adapter.closeCalls, 0);
  await fixture.owner.shutdown();
});

test("startup recovery terminalizes only the candidate when cancel redrive proves no effect", async () => {
  const adapter = new FakeAdapter({
    resumeResult: acceptedActiveThread("thread-1"),
    interruptResult: { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  });
  let failures = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate({ runPhase: "canceling", cancelRequestedAt: 3 })]),
    events: {
      accept() {},
      registerRecovered() {
        return {
          attached: Promise.resolve(true),
          async fail() {
            failures += 1;
          },
          done: new Promise<void>(() => {}),
        };
      },
      releaseGeneration() {},
    },
  });

  await fixture.owner.recoverStartup();

  assert.equal(failures, 1);
  assert.equal(adapter.closeCalls, 0);
  await fixture.owner.shutdown();
});

test("startup recovery rejects a candidate whose exact tuple changed before Provider I/O", async () => {
  const adapter = new FakeAdapter({ resumeResult: acceptedActiveThread("thread-1") });
  const candidate = acceptedRecoveryCandidate();
  const reads = runtimeReadsWithCandidates([candidate]);
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: {
      ...reads,
      async recoveryGet(input) {
        return {
          ...(await reads.recoveryGet(input)),
          externalExecutionId: "other-turn",
        };
      },
    },
  });

  await assert.rejects(() => fixture.owner.recoverStartup(), /changed before Provider reconciliation/);
  assert.equal(adapter.readInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  await fixture.owner.shutdown();
});

test("shutdown aborts and joins the in-flight startup recovery page", async () => {
  let entered = false;
  let pageAborted = false;
  const reads = {
    ...runtimeReads(() => recoveryProjection()),
    recoveryCandidatesPage(
      _input: Parameters<NonNullable<ApplicationRunRuntimeReadPort["recoveryCandidatesPage"]>>[0],
      options?: Parameters<NonNullable<ApplicationRunRuntimeReadPort["recoveryCandidatesPage"]>>[1],
    ) {
      entered = true;
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            pageAborted = true;
            reject(new Error("candidate page aborted"));
          },
          { once: true },
        );
      });
    },
  } satisfies ApplicationRunRuntimeReadPort;
  const fixture = runtimeFixture({ reads });
  const recovery = fixture.owner.recoverStartup().catch((error: unknown) => error);
  await waitFor(() => entered);

  await fixture.owner.shutdown();

  assert.equal(pageAborted, true);
  assert.match(String(await recovery), /candidate page aborted/);
});

test("startup recovery rejects invalid identity evidence before any Provider mutation", async () => {
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReadsWithCandidates([acceptedRecoveryCandidate({ bindingCreatorSessionId: "foreign-session" })]),
  });

  await assert.rejects(() => fixture.owner.recoverStartup(), /candidate is invalid/);
  assert.equal(adapter.readInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.turnInputs.length, 0);
  await fixture.owner.shutdown();
});

test("capability preflight starts and reuses a warm runtime without Thread or Turn mutations", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({ factory });

  assert.deepEqual(await fixture.owner.preflight(executionSnapshot()), { kind: "supported" });
  assert.deepEqual(await fixture.owner.preflight(executionSnapshot()), { kind: "supported" });

  assert.equal(factory.starts, 1);
  assert.deepEqual(adapter.preflightInputs, [
    {
      model: "gpt-5.6",
      modelSelection: "explicit",
      reasoningEffort: "high",
      requiredModality: "text",
    },
    {
      model: "gpt-5.6",
      modelSelection: "explicit",
      reasoningEffort: "high",
      requiredModality: "text",
    },
  ]);
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.turnInputs.length, 0);

  await fixture.owner.shutdown();
  assert.equal(adapter.closeCalls, 1);
});

test("capability preflight maps catalog unavailability without Provider mutations", async () => {
  const adapter = new FakeAdapter({
    preflightResult: {
      kind: "unavailable",
      effect: "none",
      failure: { kind: "not_sent", effect: "none", code: "timeout" },
    },
  });
  const fixture = runtimeFixture({ factory: runtimeFactory(adapter) });

  assert.deepEqual(await fixture.owner.preflight(executionSnapshot()), { kind: "unavailable" });
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.turnInputs.length, 0);

  await fixture.owner.shutdown();
});

test("runtime owner is lazy, deduplicates simultaneous handoff, and readies the event consumer before Thread creation", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({ factory });

  assert.equal(factory.starts, 0);
  fixture.owner.handoff(admission());
  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  assert.equal(factory.starts, 1);
  assert.equal(adapter.startInputs.length, 1);
  assert.equal(adapter.eventWaits > 0, true);
  assert.equal(adapter.eventWaitsBeforeFirstMutation > 0, true);
  assert.equal(fixture.bindingResolutions.length, 1);
  assert.equal(fixture.terminals.length, 0);
  assert.deepEqual(fixture.ready[0], {
    admission: admission(),
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    providerId: "codex",
    threadId: "thread-1",
    generationId: "codex-1",
    persistenceMode: "persistent",
    ephemeralOwnerToken: null,
    executionSnapshot: executionSnapshot(),
    contentBlocks: contentBlocks(),
  });

  await fixture.owner.shutdown();
  assert.deepEqual(fixture.owner.diagnostics(), {
    liveRunCount: 0,
    trackedBindingCount: 0,
    providerGenerationCount: 0,
    rejectedHandoffCount: 0,
  });
});

test("a synchronously unavailable event consumer fails before any Provider mutation", async () => {
  const adapter = new FakeAdapter({ nextEventThrows: true });
  const fixture = runtimeFixture({ factory: runtimeFactory(adapter) });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(adapter.closeCalls, 1);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_not_sent");

  await fixture.owner.shutdown();
});

test("a transient post-admission read failure retains the owner until the same Run becomes dispatch-ready", async () => {
  const adapter = new FakeAdapter();
  const baseReads = runtimeReads(() => recoveryProjection());
  let sessionReads = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: {
      ...baseReads,
      async sessionGet(input, options) {
        sessionReads += 1;
        if (sessionReads === 1) throw new Error("temporary read failure");
        return await baseReads.sessionGet(input, options);
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  assert.equal(sessionReads, 2);
  assert.equal(adapter.startInputs.length, 1);
  assert.equal(fixture.bindingResolutions.length, 1);
  assert.equal(fixture.terminals.length, 0);

  await fixture.owner.shutdown();
});

test("runtime reconstructs an accepted near-maximum directory scope from bounded chunks", async () => {
  const directories = nearMaximumAdditionalDirectories();
  const snapshot: RunExecutionSnapshot = {
    ...executionSnapshot(),
    workspace: {
      key: TEST_WORKSPACE.workspaceKey,
      path: workspacePath(),
      allowedAdditionalDirectories: directories,
    },
  };
  const snapshotByteLength = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  assert.ok(snapshotByteLength > 256 * 1024);
  assert.ok(snapshotByteLength <= APPLICATION_RUN_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes);
  const baseReads = runtimeReads(() => recoveryProjection());
  const fixture = runtimeFixture({
    reads: {
      ...baseReads,
      async sessionGet() {
        const { allowedAdditionalDirectories: _inlineDirectories, ...session } = sessionDetail();
        return {
          session: {
            ...session,
            allowedAdditionalDirectoriesByteLength: Buffer.byteLength(JSON.stringify(directories), "utf8"),
            allowedAdditionalDirectoriesState: "chunked",
          },
          execution: { state: "running", activeRunId: "run-1", latestRunId: "run-1" },
        };
      },
      async sessionDirectoriesChunk(input) {
        return chunkResult({ sessionId: input.sessionId }, directories, input.offset, input.maxBytes);
      },
      async runGet(input) {
        return {
          sessionId: input.sessionId,
          workspaceKey: input.workspaceKey,
          run: {
            id: input.runId,
            sessionId: input.sessionId,
            ordinal: 1,
            initiatingMessageId: "message-1",
            phase: "queued",
            executionSnapshotByteLength: snapshotByteLength,
            executionSnapshotState: "chunked",
            externalSideEffectState: "absent",
            createdAt: 1,
            updatedAt: 1,
            version: 1,
          },
        };
      },
      async runSnapshotChunk(input) {
        return chunkResult({ sessionId: input.sessionId, runId: input.runId }, snapshot, input.offset, input.maxBytes);
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  assert.equal(fixture.bindingResolutions.length, 1);
  assert.equal(fixture.terminals.length, 0);
  await fixture.owner.shutdown();
});

test("shutdown re-drives a pending admission context after persistence recovers", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const baseReads = runtimeReads(() => recoveryProjection());
  let readsAvailable = false;
  const fixture = runtimeFixture({
    factory,
    reads: {
      ...baseReads,
      async sessionGet(input, options) {
        if (!readsAvailable) throw new Error("temporary read failure");
        return await baseReads.sessionGet(input, options);
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.owner.diagnostics().liveRunCount === 1);
  await assert.rejects(fixture.owner.shutdown(), ApplicationRunRuntimeShutdownPendingError);

  readsAvailable = true;
  await fixture.owner.shutdown();

  assert.equal(factory.starts, 0);
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(fixture.owner.diagnostics().liveRunCount, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("shutdown exact-retries a pending Binding resolution before terminalizing the Run", async () => {
  let resolutionAvailable = false;
  const fixture = runtimeFixture({
    bindingResolutionUnavailable: () => !resolutionAvailable,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.bindingResolutions.length > 0);
  await assert.rejects(fixture.owner.shutdown(), ApplicationRunRuntimeShutdownPendingError);

  resolutionAvailable = true;
  await fixture.owner.shutdown();

  assert.ok(fixture.bindingResolutions.length > 1);
  assert.ok(
    fixture.bindingResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.bindingResolutions[0]),
    ),
  );
  assert.equal(fixture.owner.diagnostics().liveRunCount, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "dispatch_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("an exact handoff retries persistence for an already-owned Run without a second Provider mutation", async () => {
  const adapter = new FakeAdapter();
  let readyCalls = 0;
  let retryCalls = 0;
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    dispatchReady: {
      async ready() {
        readyCalls += 1;
        await ready;
      },
    },
    events: {
      accept() {},
      async retryRun(runId) {
        assert.equal(runId, "run-1");
        retryCalls += 1;
        return true;
      },
      releaseGeneration() {},
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => readyCalls === 1);
  fixture.owner.handoff(admission());
  await waitFor(() => retryCalls === 1);
  assert.equal(adapter.startInputs.length, 1);

  releaseReady();
  await fixture.owner.shutdown();
});

test("an exact handoff coalesces until a later retryable Dispatch owner can be re-driven", async () => {
  const adapter = new FakeAdapter();
  let releaseReady!: () => void;
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const pendingRunIds = new Set<string>();
  let readyCalls = 0;
  let retryCalls = 0;
  let eventRetryCalls = 0;
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    dispatchReady: {
      async ready(dispatch) {
        readyCalls += 1;
        await readyGate;
        pendingRunIds.add(dispatch.admission.runId);
      },
      pendingRunIds: () => [...pendingRunIds],
      async retryPending(runId) {
        retryCalls += 1;
        return pendingRunIds.delete(runId);
      },
      async flushPending() {
        return pendingRunIds.size === 0;
      },
    },
    events: {
      accept() {},
      async retryRun() {
        eventRetryCalls += 1;
        return true;
      },
      releaseGeneration() {},
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => readyCalls === 1);
  fixture.owner.handoff(admission());
  await waitFor(() => eventRetryCalls === 1);

  releaseReady();
  await waitFor(() => retryCalls === 2);

  assert.deepEqual([...pendingRunIds], []);
  assert.equal(adapter.startInputs.length, 1);
  assert.equal(fixture.owner.diagnostics().liveRunCount, 0);
  await fixture.owner.shutdown();
});

test("shutdown flushes a Dispatch owner registered by in-flight work after its initial flush", async () => {
  let releaseReady!: () => void;
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  let observeFirstFlush!: () => void;
  const firstFlush = new Promise<void>((resolve) => {
    observeFirstFlush = resolve;
  });
  const pendingRunIds = new Set<string>();
  let readyCalls = 0;
  let flushCalls = 0;
  const fixture = runtimeFixture({
    dispatchReady: {
      async ready(dispatch) {
        readyCalls += 1;
        await readyGate;
        pendingRunIds.add(dispatch.admission.runId);
      },
      pendingRunIds: () => [...pendingRunIds],
      async retryPending(runId) {
        return pendingRunIds.delete(runId);
      },
      async flushPending() {
        flushCalls += 1;
        if (flushCalls === 1) observeFirstFlush();
        pendingRunIds.clear();
        return true;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => readyCalls === 1);
  const shutdown = fixture.owner.shutdown();
  await firstFlush;
  releaseReady();
  await shutdown;

  assert.equal(flushCalls, 2);
  assert.deepEqual([...pendingRunIds], []);
  assert.equal(fixture.owner.diagnostics().liveRunCount, 0);
});

test("creating Binding work is owned once and a current-generation active Binding does not resume", async () => {
  const adapter = new FakeAdapter();
  let recovery = recoveryProjection({ bindingState: "creating", externalConversationId: null });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(() => recovery),
    onResolveBinding() {
      recovery = recoveryProjection({ bindingState: "active", externalConversationId: "thread-1" });
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  fixture.owner.handoff(admission({ bindingState: "active" }));
  await waitFor(() => fixture.ready.length === 2);

  assert.equal(adapter.startInputs.length, 1);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(fixture.bindingResolutions.length, 1);
  assert.equal(fixture.terminals.length, 0);

  await fixture.owner.shutdown();
});

test("an inherited retry creating a Binding preserves model provenance for Thread start", async () => {
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(
      () => recoveryProjection({ bindingState: "creating", externalConversationId: null }),
      "codex",
      "inherited",
    ),
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  assert.deepEqual(adapter.startInputs, [
    {
      model: "gpt-5.6",
      modelSelection: "inherited",
      reasoningEffort: "high",
      workspacePath: workspacePath(),
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      persistence: "persistent",
    },
  ]);
  assert.equal(adapter.resumeInputs.length, 0);

  await fixture.owner.shutdown();
});

test("Binding resolution response loss replays the same durable command without creating another Thread", async () => {
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    bindingResolutionUnknownOnce: true,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  assert.equal(adapter.startInputs.length, 1);
  assert.equal(fixture.bindingResolutions.length, 2);
  assert.deepEqual(fixture.bindingResolutions[0], fixture.bindingResolutions[1]);
  assert.equal(fixture.terminals.length, 0);

  await fixture.owner.shutdown();
});

test("an active persistent Binding is resumed in a new generation before it becomes dispatch-ready", async () => {
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(() =>
      recoveryProjection({
        bindingState: "active",
        externalConversationId: "thread-existing",
      }),
    ),
  });

  fixture.owner.handoff(admission({ bindingState: "active" }));
  await waitFor(() => fixture.ready.length === 1);

  assert.equal(adapter.startInputs.length, 0);
  assert.deepEqual(adapter.resumeInputs, [
    {
      threadId: "thread-existing",
      model: "gpt-5.6",
      modelSelection: "explicit",
      reasoningEffort: "high",
      workspacePath: workspacePath(),
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    },
  ]);
  assert.equal(adapter.eventWaitsBeforeFirstMutation > 0, true);
  assert.equal(fixture.ready[0]?.threadId, "thread-existing");

  await fixture.owner.shutdown();
});

test("an inherited retry resumes the Thread with its source Run model provenance", async () => {
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(
      () =>
        recoveryProjection({
          bindingState: "active",
          externalConversationId: "thread-existing",
        }),
      "codex",
      "inherited",
    ),
  });

  fixture.owner.handoff(admission({ bindingState: "active" }));
  await waitFor(() => fixture.ready.length === 1);

  assert.deepEqual(adapter.resumeInputs, [
    {
      threadId: "thread-existing",
      model: "gpt-5.6",
      modelSelection: "inherited",
      reasoningEffort: "high",
      workspacePath: workspacePath(),
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    },
  ]);

  await fixture.owner.shutdown();
});

test("Thread creation not-sent and ambiguous outcomes terminalize monotonically without retrying Provider mutation", async () => {
  for (const kind of ["not_sent", "ambiguous"] as const) {
    const adapter = new FakeAdapter({
      startResult:
        kind === "not_sent"
          ? { kind: "not_sent", effect: "none", code: "not_ready" }
          : { kind: "ambiguous", effect: "unknown", code: "timeout" },
    });
    const fixture = runtimeFixture({ factory: runtimeFactory(adapter) });

    fixture.owner.handoff(admission());
    await waitFor(() => fixture.terminals.length === 1);

    assert.equal(adapter.startInputs.length, 1);
    assert.equal(adapter.resumeInputs.length, 0);
    assert.equal(fixture.bindingResolutions.length, 0);
    assert.equal(fixture.ready.length, 0);
    assert.equal(
      fixture.terminals[0]?.preDispatchResolution.kind,
      kind === "not_sent" ? "binding_creation_not_sent" : "binding_creation_ambiguous",
    );
    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");

    await fixture.owner.shutdown();
  }
});

test("Thread mutation failure codes preserve terminal outcome and origin", async () => {
  for (const bindingState of ["creating", "active"] as const) {
    for (const expected of [
      {
        result: { kind: "not_sent", effect: "none", code: "invalid_input" },
        outcomeKind: "failed",
        failureOrigin: "application",
        providerErrorCode: null,
      },
      {
        result: { kind: "rejected", effect: "none", code: 429 },
        outcomeKind: "failed",
        failureOrigin: "provider",
        providerErrorCode: "429",
      },
      {
        result: { kind: "not_sent", effect: "none", code: "process_exited" },
        outcomeKind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: null,
      },
    ] as const) {
      const adapter = new FakeAdapter({
        startResult: expected.result,
        resumeResult: expected.result,
      });
      const fixture = runtimeFixture({
        factory: runtimeFactory(adapter),
        reads: runtimeReads(() =>
          recoveryProjection({
            bindingState,
            externalConversationId: bindingState === "active" ? "thread-existing" : null,
          }),
        ),
      });

      fixture.owner.handoff(admission({ bindingState }));
      await waitFor(() => fixture.terminals.length === 1);

      assert.equal(adapter.startInputs.length, bindingState === "creating" ? 1 : 0);
      assert.equal(adapter.resumeInputs.length, bindingState === "active" ? 1 : 0);
      assert.equal(
        fixture.terminals[0]?.preDispatchResolution.kind,
        bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
      );
      const outcome = fixture.terminals[0]?.outcome;
      assert.ok(outcome !== undefined && outcome.kind !== "completed" && outcome.kind !== "canceled");
      assert.equal(outcome.kind, expected.outcomeKind);
      assert.equal(outcome.failureOrigin, expected.failureOrigin);
      assert.equal(outcome.providerErrorCode, expected.providerErrorCode);
      assert.equal(fixture.ready.length, 0);

      await fixture.owner.shutdown();
    }
  }
});

test("an ambiguous Thread mutation retires its generation before later Run work starts", async () => {
  const first = new FakeAdapter({
    startResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const second = new FakeAdapter();
  const adapters = [first, second];
  const generations: string[] = [];
  const fixture = runtimeFixture({
    factory: {
      supports: (providerId) => providerId === "codex",
      async start(providerId: string, generationId: string) {
        generations.push(generationId);
        const adapter = adapters.shift();
        if (adapter === undefined) throw new Error("unexpected generation");
        return { providerId, generationId, adapter };
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);
  await waitFor(() => first.closeCalls === 1);

  fixture.owner.handoff(
    admission({
      runId: "run-2",
      attemptId: "attempt-2",
      bindingId: "binding-2",
    }),
  );
  await waitFor(() => fixture.ready.length === 1);

  assert.deepEqual(generations, ["codex-1", "codex-2"]);
  assert.equal(first.startInputs.length, 1);
  assert.equal(second.startInputs.length, 1);
  assert.equal(fixture.ready[0]?.generationId, "codex-2");

  await fixture.owner.shutdown();
});

test("pre-dispatch terminal response loss reuses one deterministic terminal identity", async () => {
  const adapter = new FakeAdapter({
    startResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    terminalUnknownOnce: true,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 2);

  assert.equal(adapter.startInputs.length, 1);
  assert.deepEqual(fixture.terminals[0], fixture.terminals[1]);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_ambiguous");

  await fixture.owner.shutdown();
});

test("an unconfirmed pre-dispatch terminal keeps a persistence-only retry owner", async () => {
  const adapter = new FakeAdapter({
    startResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    terminalUnknownCount: 2,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 2);
  await waitFor(() => fixture.owner.diagnostics().liveRunCount === 1);

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 3);
  await waitFor(() => fixture.owner.diagnostics().liveRunCount === 0);
  assert.deepEqual(fixture.terminals[0], fixture.terminals[1]);
  assert.deepEqual(fixture.terminals[1], fixture.terminals[2]);

  await fixture.owner.shutdown();
});

test("shutdown retries an unconfirmed terminal with the same frozen command before releasing ownership", async () => {
  const adapter = new FakeAdapter({
    startResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    terminalUnknownCount: 4,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 2);

  await assert.rejects(fixture.owner.shutdown(), ApplicationRunRuntimeShutdownPendingError);
  assert.equal(fixture.owner.diagnostics().liveRunCount, 1);

  await fixture.owner.shutdown();
  assert.equal(fixture.terminals.length, 5);
  assert.deepEqual(fixture.terminals[0], fixture.terminals[4]);
  assert.equal(fixture.owner.diagnostics().liveRunCount, 0);
});

test("resume uncertainty never falls back to a new Thread or publishes Dispatch readiness", async () => {
  const adapter = new FakeAdapter({
    resumeResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(() =>
      recoveryProjection({
        bindingState: "active",
        externalConversationId: "thread-existing",
      }),
    ),
  });

  fixture.owner.handoff(admission({ bindingState: "active" }));
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 1);
  assert.equal(fixture.ready.length, 0);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "dispatch_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");

  await fixture.owner.shutdown();
});

test("an accepted Thread keeps one Binding resolution owner after generation loss before terminalizing the Run", async () => {
  let recovery = recoveryProjection({ bindingState: "creating", externalConversationId: null });
  let adapter!: FakeAdapter;
  adapter = new FakeAdapter({
    async startOperation() {
      adapter.emit({
        kind: "connection_failure",
        code: "process_exited",
      });
      await new Promise((resolve) => setImmediate(resolve));
      return acceptedThread("thread-1");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    reads: runtimeReads(() => recovery),
    bindingResolutionUnknownCount: 4,
    onResolveBinding() {
      recovery = recoveryProjection({ bindingState: "active", externalConversationId: "thread-1" });
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(adapter.closeCalls, 1);
  assert.equal(fixture.bindingResolutions.length, 5);
  assert.ok(
    fixture.bindingResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.bindingResolutions[0]),
    ),
  );
  assert.equal(fixture.ready.length, 0);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "dispatch_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");

  await fixture.owner.shutdown();
});

test("an event consumer failure retries the exact event and drains queued terminal before generation release", async () => {
  const order: string[] = [];
  const acceptedEvents: CodexAdapterEvent[] = [];
  let releaseFirstAccept!: () => void;
  const firstAcceptGate = new Promise<void>((resolve) => {
    releaseFirstAccept = resolve;
  });
  let acceptAttempts = 0;
  const adapter = new FakeAdapter({
    onClose() {
      order.push("provider-close");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      async accept(_generationId, event) {
        acceptAttempts += 1;
        order.push(`event-${event.kind}-${acceptAttempts}`);
        if (acceptAttempts === 1) {
          await firstAcceptGate;
          throw new Error("event persistence failed");
        }
        acceptedEvents.push(event);
      },
      releaseGeneration() {
        order.push("generation-release");
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  adapter.emit({
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "active",
  });
  await waitFor(() => acceptAttempts === 1);
  adapter.emit({
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: {
      contentBlocks: [{ type: "text", text: "final answer" }],
    },
    contentFailure: null,
  });
  releaseFirstAccept();
  await waitFor(() => order.includes("generation-release"));

  assert.deepEqual(acceptedEvents, [
    {
      kind: "thread_status_observed",
      threadId: "thread-1",
      status: "active",
    },
    {
      kind: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finalAssistantMessage: {
        contentBlocks: [{ type: "text", text: "final answer" }],
      },
      contentFailure: null,
    },
  ]);
  assert.deepEqual(order, [
    "event-thread_status_observed-1",
    "provider-close",
    "event-thread_status_observed-2",
    "event-turn_terminal-3",
    "generation-release",
  ]);
  assert.equal(adapter.closeCalls, 1);

  await fixture.owner.shutdown();
});

test("connection failure retirement drains a queued terminal before releasing the generation", async () => {
  const order: string[] = [];
  let releaseConnectionFailure!: () => void;
  const connectionFailureGate = new Promise<void>((resolve) => {
    releaseConnectionFailure = resolve;
  });
  let connectionFailureAccepted = false;
  const adapter = new FakeAdapter({
    onClose() {
      order.push("provider-close");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      async accept(_generationId, event) {
        order.push(`event-${event.kind}`);
        if (event.kind === "connection_failure") {
          connectionFailureAccepted = true;
          await connectionFailureGate;
        }
      },
      releaseGeneration(_generationId, reason) {
        order.push(`generation-release-${reason.kind}`);
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  adapter.emit({
    kind: "connection_failure",
    code: "process_exited",
  });
  await waitFor(() => connectionFailureAccepted);
  adapter.emit({
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: {
      contentBlocks: [{ type: "text", text: "final answer" }],
    },
    contentFailure: null,
  });
  releaseConnectionFailure();
  await waitFor(() => order.includes("generation-release-connection_failure"));

  assert.deepEqual(order, [
    "event-connection_failure",
    "provider-close",
    "event-turn_terminal",
    "generation-release-connection_failure",
  ]);
  await fixture.owner.shutdown();
});

test("an unresolved event accept keeps the exact event and generation owner across shutdown retry", async () => {
  let acceptAvailable = false;
  let acceptAttempts = 0;
  let generationReleases = 0;
  const acceptedEvents: CodexAdapterEvent[] = [];
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      accept(_generationId, event) {
        acceptAttempts += 1;
        if (!acceptAvailable) throw new Error("event persistence failed");
        acceptedEvents.push(event);
      },
      releaseGeneration() {
        generationReleases += 1;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  adapter.emit({
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "active",
  });
  await waitFor(() => acceptAttempts >= 2);

  assert.equal(generationReleases, 0);
  await assert.rejects(fixture.owner.shutdown(), ApplicationRunRuntimeShutdownPendingError);
  assert.equal(generationReleases, 0);

  acceptAvailable = true;
  await fixture.owner.shutdown();
  assert.deepEqual(acceptedEvents, [
    {
      kind: "thread_status_observed",
      threadId: "thread-1",
      status: "active",
    },
  ]);
  assert.equal(generationReleases, 1);
});

test("generation release barrier keeps the Provider runtime open while interaction durability is pending", async () => {
  let barrierReady = false;
  let barrierCalls = 0;
  let generationReleases = 0;
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      accept() {},
      prepareGenerationRelease() {
        barrierCalls += 1;
        return { kind: barrierReady ? "ready" : "pending" };
      },
      releaseGeneration() {
        generationReleases += 1;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  await assert.rejects(fixture.owner.shutdown(), ApplicationRunRuntimeShutdownPendingError);
  assert.equal(barrierCalls, 1);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(generationReleases, 0);

  barrierReady = true;
  await fixture.owner.shutdown();
  assert.equal(barrierCalls, 2);
  assert.equal(adapter.closeCalls, 1);
  assert.equal(generationReleases, 1);
});

test("connection retirement rechecks a pending interaction barrier before closing the Provider", async () => {
  let barrierCalls = 0;
  let generationReleases = 0;
  const adapter = new FakeAdapter();
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      accept() {},
      prepareGenerationRelease() {
        barrierCalls += 1;
        return { kind: barrierCalls < 3 ? "pending" : "ready" };
      },
      releaseGeneration() {
        generationReleases += 1;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  adapter.emit({ kind: "connection_failure", code: "process_exited" });
  await waitFor(() => barrierCalls >= 2);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(generationReleases, 0);
  await waitFor(() => generationReleases === 1);
  assert.equal(barrierCalls, 3);
  assert.equal(adapter.closeCalls, 1);
  await fixture.owner.shutdown();
});

test("shutdown drains Provider events received before close before releasing the generation", async () => {
  const order: string[] = [];
  const acceptedEvents: CodexAdapterEvent[] = [];
  let releaseFirstAccept!: () => void;
  const firstAcceptGate = new Promise<void>((resolve) => {
    releaseFirstAccept = resolve;
  });
  let firstAcceptStarted = false;
  const adapter = new FakeAdapter({
    onClose() {
      order.push("provider-close");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      async accept(_generationId, event) {
        acceptedEvents.push(event);
        order.push(`event-${event.kind}`);
        if (!firstAcceptStarted) {
          firstAcceptStarted = true;
          await firstAcceptGate;
        }
      },
      releaseGeneration() {
        order.push("generation-release");
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  adapter.emit({
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "active",
  });
  await waitFor(() => firstAcceptStarted);
  adapter.emit({
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: {
      contentBlocks: [{ type: "text", text: "final answer" }],
    },
    contentFailure: null,
  });

  const shutdown = fixture.owner.shutdown();
  await waitFor(() => adapter.closeCalls === 1);
  assert.equal(order.includes("generation-release"), false);
  releaseFirstAccept();
  await shutdown;

  assert.deepEqual(acceptedEvents, [
    {
      kind: "thread_status_observed",
      threadId: "thread-1",
      status: "active",
    },
    {
      kind: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finalAssistantMessage: {
        contentBlocks: [{ type: "text", text: "final answer" }],
      },
      contentFailure: null,
    },
  ]);
  assert.deepEqual(order, [
    "event-thread_status_observed",
    "provider-close",
    "event-turn_terminal",
    "generation-release",
  ]);
});

test("Provider startup failure is Run-scoped and a later handoff may create a new generation", async () => {
  const adapter = new FakeAdapter();
  let starts = 0;
  const factory: ApplicationRunProviderRuntimeFactory & { starts: number } = {
    starts: 0,
    supports(providerId) {
      return providerId === "codex";
    },
    async start(providerId, generationId) {
      starts += 1;
      this.starts = starts;
      if (starts === 1) throw new Error("startup failed");
      return { providerId, generationId, adapter };
    },
  };
  const fixture = runtimeFixture({ factory });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);
  assert.equal(factory.starts, 1);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "process",
  );

  fixture.owner.handoff(admission({ runId: "run-2", attemptId: "attempt-2", bindingId: "binding-2" }));
  await waitFor(() => fixture.ready.length === 1);
  assert.equal(factory.starts, 2);
  assert.equal(fixture.ready[0]?.generationId, "codex-2");

  await fixture.owner.shutdown();
});

test("deterministic Codex runtime startup failures terminalize as failed application errors", async (context) => {
  await context.test("missing executable configuration", async () => {
    const fixture = runtimeFixture({
      factory: new CodexApplicationRunRuntimeFactory({}),
    });

    fixture.owner.handoff(admission());
    await waitFor(() => fixture.terminals.length === 1);

    assert.equal(fixture.terminals[0]?.outcome.kind, "failed");
    assert.equal(
      fixture.terminals[0]?.outcome.kind === "failed" && fixture.terminals[0].outcome.failureOrigin,
      "application",
    );
    assert.equal(
      fixture.terminals[0]?.outcome.kind === "failed" && fixture.terminals[0].outcome.errorSummary,
      "Provider runtime configuration is invalid.",
    );
    await fixture.owner.shutdown();
  });

  await context.test("wrong-platform native artifact", async () => {
    if (!["win32", "linux", "darwin"].includes(process.platform)) {
      context.skip(`unsupported test platform: ${process.platform}`);
      return;
    }
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-wrong-platform-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const executable = path.join(fixtureRoot, process.platform === "win32" ? "codex.exe" : "codex");
    const invalidHeader =
      process.platform === "linux"
        ? Uint8Array.from([0xfe, 0xed, 0xfa, 0xcf])
        : process.platform === "darwin"
          ? Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])
          : Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]);
    await writeFile(executable, invalidHeader);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    const fixture = runtimeFixture({
      factory: new CodexApplicationRunRuntimeFactory(
        { [WITHMATE_CODEX_EXECUTABLE_ENV]: executable },
        {
          createTransport() {
            throw new Error("transport must not be created for an invalid executable");
          },
        },
      ),
    });

    fixture.owner.handoff(admission());
    await waitFor(() => fixture.terminals.length === 1);

    assert.equal(fixture.terminals[0]?.outcome.kind, "failed");
    assert.equal(
      fixture.terminals[0]?.outcome.kind === "failed" && fixture.terminals[0].outcome.failureOrigin,
      "application",
    );
    assert.equal(
      fixture.terminals[0]?.outcome.kind === "failed" && fixture.terminals[0].outcome.errorSummary,
      "Provider runtime configuration is invalid.",
    );
    await fixture.owner.shutdown();
  });
});

test("Codex process startup failure terminalizes as interrupted process ownership", async () => {
  let closeCalls = 0;
  const failedTransport = {
    async start() {
      throw new Error("spawn failed");
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as CodexAppServerTransport;
  const fixture = runtimeFixture({
    factory: new CodexApplicationRunRuntimeFactory(
      { [WITHMATE_CODEX_EXECUTABLE_ENV]: process.execPath },
      { createTransport: () => failedTransport },
    ),
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(closeCalls, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "process",
  );
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.errorSummary,
    "Provider runtime startup was interrupted.",
  );
  await fixture.owner.shutdown();
});

test("an invalid Provider runtime owner cannot be replaced until its close succeeds", async () => {
  const order: string[] = [];
  let starts = 0;
  let closeAttempts = 0;
  let releases = 0;
  const invalidAdapter = new FakeAdapter({
    async closeOperation() {
      closeAttempts += 1;
      order.push(`invalid-close-${closeAttempts}`);
      if (closeAttempts === 1) throw new Error("close_failed");
    },
  });
  const validAdapter = new FakeAdapter();
  const factory: ApplicationRunProviderRuntimeFactory = {
    supports(providerId) {
      return providerId === "codex";
    },
    async start(providerId, generationId) {
      starts += 1;
      order.push(`runtime-start-${starts}`);
      if (starts === 1) {
        return {
          providerId,
          generationId: "foreign-generation",
          adapter: invalidAdapter,
        };
      }
      return { providerId, generationId, adapter: validAdapter };
    },
  };
  const fixture = runtimeFixture({
    factory,
    events: {
      accept() {},
      releaseGeneration() {
        releases += 1;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);
  assert.deepEqual(order, ["runtime-start-1", "invalid-close-1"]);
  assert.equal(starts, 1);
  assert.equal(releases, 0);

  fixture.owner.handoff(admission({ runId: "run-2", attemptId: "attempt-2", bindingId: "binding-2" }));
  await waitFor(() => fixture.ready.length === 1);
  assert.deepEqual(order, ["runtime-start-1", "invalid-close-1", "invalid-close-2", "runtime-start-2"]);
  assert.equal(releases, 0);

  await fixture.owner.shutdown();
  assert.equal(releases, 1);
});

test("an unsupported Session Provider terminalizes before Codex runtime startup or Thread mutation", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({
    factory,
    reads: runtimeReads(() => recoveryProjection(), "other"),
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 1);

  assert.equal(factory.starts, 0);
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(adapter.resumeInputs.length, 0);
  assert.equal(fixture.bindingResolutions.length, 0);
  assert.equal(fixture.ready.length, 0);
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "failed");

  await fixture.owner.shutdown();
});

test("owner tuple mismatch prevents Provider startup and cross-Run mutation", async () => {
  const adapter = new FakeAdapter();
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({
    factory,
    reads: runtimeReads(() => recoveryProjection({ attemptId: "foreign-attempt" })),
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.owner.diagnostics().liveRunCount === 0);

  assert.equal(factory.starts, 0);
  assert.equal(adapter.startInputs.length, 0);
  assert.equal(fixture.bindingResolutions.length, 0);
  assert.equal(fixture.terminals.length, 0);
  assert.equal(fixture.ready.length, 0);

  await fixture.owner.shutdown();
});

test("graceful shutdown closes Provider ownership before pending work performs its final Repository write", async () => {
  const order: string[] = [];
  const adapter = new FakeAdapter({
    startOperation(signal) {
      return new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            order.push("mutation-aborted");
            resolve({ kind: "not_sent", effect: "none", code: "aborted" });
          },
          { once: true },
        );
      });
    },
    onClose() {
      order.push("provider-close");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    onTerminal() {
      order.push("repository-terminal");
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => adapter.startInputs.length === 1);
  await fixture.owner.shutdown();
  order.push("worker-shutdown");

  assert.equal(order.filter((entry) => entry === "provider-close").length, 1);
  assert.notEqual(order.indexOf("provider-close"), -1);
  assert.notEqual(order.indexOf("repository-terminal"), -1);
  assert.notEqual(order.indexOf("worker-shutdown"), -1);
  assert.ok(order.indexOf("provider-close") < order.indexOf("repository-terminal"));
  assert.ok(order.indexOf("repository-terminal") < order.indexOf("worker-shutdown"));
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "application",
  );
});

test("shutdown terminalizes context that was read before closing began", async () => {
  const adapter = new FakeAdapter();
  let supportChecks = 0;
  let fixture!: ReturnType<typeof runtimeFixture>;
  let shutdown: Promise<void> | undefined;
  fixture = runtimeFixture({
    factory: {
      supports(providerId) {
        supportChecks += 1;
        if (supportChecks === 4) {
          queueMicrotask(() => {
            shutdown = fixture.owner.shutdown();
          });
        }
        return providerId === "codex";
      },
      async start(providerId: string, generationId: string) {
        return { providerId, generationId, adapter };
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);
  fixture.owner.handoff(
    admission({
      runId: "run-2",
      attemptId: "attempt-2",
      bindingId: "binding-2",
    }),
  );

  await waitFor(() => shutdown !== undefined);
  await shutdown;

  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.runId, "run-2");
  assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "binding_creation_not_sent");
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("a failed Provider close keeps the generation owned and shutdown pending until close succeeds", async () => {
  let closeAttempts = 0;
  let releases = 0;
  const adapter = new FakeAdapter({
    async closeOperation() {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("close_failed");
    },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    events: {
      accept() {},
      releaseGeneration() {
        releases += 1;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.ready.length === 1);

  await assert.rejects(
    fixture.owner.shutdown(),
    (error: unknown) => error instanceof ApplicationRunRuntimeShutdownPendingError,
  );
  assert.equal(releases, 0);
  await fixture.owner.shutdown();

  assert.equal(closeAttempts, 2);
  assert.equal(releases, 1);
});

test("Codex runtime startup retains failed cleanup and blocks a successor until the same owner closes", async () => {
  let transportCreations = 0;
  let firstCloseAttempts = 0;
  let firstCloseMaySucceed = false;
  let secondCloseAttempts = 0;
  const firstTransport = {
    async start() {
      throw new Error("startup_failed");
    },
    async close() {
      firstCloseAttempts += 1;
      if (!firstCloseMaySucceed) throw new Error("close_failed");
    },
  } as unknown as CodexAppServerTransport;
  const secondTransport = {
    async start() {
      return {
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
        userAgent: "codex-cli/0.145.0",
      };
    },
    request() {
      return Promise.reject(new Error("request is not used"));
    },
    nextEvent() {
      return new Promise(() => undefined);
    },
    async close() {
      secondCloseAttempts += 1;
    },
  } as unknown as CodexAppServerTransport;
  const factory = new CodexApplicationRunRuntimeFactory(
    { [WITHMATE_CODEX_EXECUTABLE_ENV]: process.execPath },
    {
      createTransport() {
        transportCreations += 1;
        return transportCreations === 1 ? firstTransport : secondTransport;
      },
    },
  );
  const signal = new AbortController().signal;

  await assert.rejects(
    factory.start("codex", "codex-1", signal),
    (error: unknown) =>
      error instanceof ApplicationRunProviderRuntimeStartupError &&
      error.failureKind === "process" &&
      /startup cleanup is pending/u.test(error.message),
  );
  assert.equal(transportCreations, 1);
  assert.equal(firstCloseAttempts, 1);

  await assert.rejects(
    factory.start("codex", "codex-2", signal),
    (error: unknown) =>
      error instanceof ApplicationRunProviderRuntimeStartupError &&
      error.failureKind === "process" &&
      error.cause instanceof Error &&
      error.cause.message === "close_failed",
  );
  assert.equal(transportCreations, 1);
  assert.equal(firstCloseAttempts, 2);

  firstCloseMaySucceed = true;
  const runtime = await factory.start("codex", "codex-3", signal);
  assert.equal(transportCreations, 2);
  assert.equal(firstCloseAttempts, 3);
  assert.equal(runtime.generationId, "codex-3");

  await runtime.adapter.close();
  assert.equal(secondCloseAttempts, 1);
});

test("runtime limits reject excess handoff observably without starting a second Provider mutation", async () => {
  const adapter = new FakeAdapter({
    startOperation(signal) {
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ kind: "not_sent", effect: "none", code: "aborted" }), {
          once: true,
        });
      });
    },
  });
  const factory = runtimeFactory(adapter);
  const fixture = runtimeFixture({
    factory,
    limits: { maxLiveRuns: 1, maxTrackedBindings: 1 },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => adapter.startInputs.length === 1);
  assert.throws(
    () =>
      fixture.owner.handoff(
        admission({
          runId: "run-2",
          attemptId: "attempt-2",
          bindingId: "binding-2",
        }),
      ),
    /work limit/u,
  );
  assert.equal(fixture.owner.diagnostics().rejectedHandoffCount, 1);
  assert.equal(factory.starts, 1);

  await fixture.owner.shutdown();
});

test("Binding owner capacity terminalizes create and resume work as failed before Provider Turn dispatch", async (context) => {
  for (const bindingState of ["creating", "active"] as const) {
    await context.test(bindingState, async () => {
      const adapter = new FakeAdapter();
      const fixture = runtimeFixture({
        factory: runtimeFactory(adapter),
        reads: runtimeReads((input) =>
          input.runId === "run-2"
            ? recoveryProjection({
                bindingState,
                externalConversationId: bindingState === "active" ? "thread-existing" : null,
              })
            : recoveryProjection(),
        ),
        limits: { maxLiveRuns: 1, maxTrackedBindings: 1 },
      });

      fixture.owner.handoff(admission());
      await waitFor(() => fixture.ready.length === 1);
      fixture.owner.handoff(
        admission({
          sessionId: "session-2",
          runId: "run-2",
          attemptId: "attempt-2",
          bindingId: "binding-2",
          bindingState,
        }),
      );
      await waitFor(() => fixture.terminals.length === 1);

      assert.equal(fixture.ready.length, 1);
      assert.equal(adapter.startInputs.length, bindingState === "creating" ? 2 : 1);
      assert.equal(adapter.resumeInputs.length, bindingState === "active" ? 1 : 0);
      assert.equal(fixture.terminals[0]?.runId, "run-2");
      assert.equal(fixture.terminals[0]?.preDispatchResolution.kind, "dispatch_not_sent");
      assert.equal(fixture.terminals[0]?.outcome.kind, "failed");
      assert.equal(
        fixture.terminals[0]?.outcome.kind === "failed" ? fixture.terminals[0].outcome.failureOrigin : undefined,
        "application",
      );

      await fixture.owner.shutdown();
    });
  }
});

test("a pending Dispatch owner can exact-retry at capacity while a different Run remains rejected", async () => {
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const pendingRunIds = new Set(["run-1"]);
  const retryCalls: string[] = [];
  const fixture = runtimeFixture({
    limits: { maxLiveRuns: 1, maxTrackedBindings: 1 },
    dispatchReady: {
      async ready() {
        throw new Error("A pending Dispatch retry must not create new work.");
      },
      pendingRunIds: () => [...pendingRunIds],
      async retryPending(runId) {
        retryCalls.push(runId);
        await retryGate;
        pendingRunIds.delete(runId);
        return true;
      },
      async flushPending() {
        return pendingRunIds.size === 0;
      },
    },
  });

  fixture.owner.handoff(admission());
  await waitFor(() => retryCalls.length === 1);
  assert.throws(
    () =>
      fixture.owner.handoff(
        admission({
          runId: "run-2",
          attemptId: "attempt-2",
          bindingId: "binding-2",
        }),
      ),
    /work limit/u,
  );

  releaseRetry();
  await waitFor(() => fixture.owner.diagnostics().liveRunCount === 0);
  assert.deepEqual(retryCalls, ["run-1"]);
  await fixture.owner.shutdown();
});

test("shutdown does not classify a fatal Persistence Worker as retryable closure", async () => {
  const adapter = new FakeAdapter({
    startResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
  });
  const fixture = runtimeFixture({
    factory: runtimeFactory(adapter),
    terminalUnknownCount: 100,
    persistenceRetryable: () => false,
  });

  fixture.owner.handoff(admission());
  await waitFor(() => fixture.terminals.length === 2);
  await assert.rejects(
    fixture.owner.shutdown(),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ApplicationRunRuntimeShutdownPendingError) &&
      /Persistence Worker is unavailable/u.test(error.message),
  );
});

test("Codex executable resolution requires an absolute native binary and never accepts a shim", async (context) => {
  assert.equal(
    await resolveConfiguredCodexExecutable({
      [WITHMATE_CODEX_EXECUTABLE_ENV]: process.execPath,
    }),
    process.execPath,
  );
  await assert.rejects(resolveConfiguredCodexExecutable({}), /not configured/u);
  await assert.rejects(
    resolveConfiguredCodexExecutable({
      [WITHMATE_CODEX_EXECUTABLE_ENV]: "codex",
    }),
    /absolute path/u,
  );

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-executable-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const shim = path.join(fixtureRoot, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(shim, "#!/usr/bin/env node\n");
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(shim, 0o755);
  }
  await assert.rejects(
    resolveConfiguredCodexExecutable({
      [WITHMATE_CODEX_EXECUTABLE_ENV]: shim,
    }),
    /native executable/u,
  );
  if (process.platform === "win32") {
    await assert.rejects(
      resolveConfiguredCodexExecutable({
        [WITHMATE_CODEX_EXECUTABLE_ENV]: path.join(fixtureRoot, "codex.cmd"),
      }),
      /native Windows executable/u,
    );
  }
});

test("Codex executable resolution validates the native format for the selected OS", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-native-format-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const linuxExecutable = path.join(fixtureRoot, "codex-linux");
  const truncatedLinuxExecutable = path.join(fixtureRoot, "codex-linux-truncated");
  const invalidLinuxOffsetExecutable = path.join(fixtureRoot, "codex-linux-offset");
  const invalidTrailingLinuxExecutable = path.join(fixtureRoot, "codex-linux-trailing-segment");
  const macExecutable = path.join(fixtureRoot, "codex-macos");
  const macFat64Executable = path.join(fixtureRoot, "codex-macos-fat64");
  const truncatedMacExecutable = path.join(fixtureRoot, "codex-macos-truncated");
  const truncatedMacFat64Executable = path.join(fixtureRoot, "codex-macos-fat64-truncated");
  const invalidMacSectionCountExecutable = path.join(fixtureRoot, "codex-macos-section-count");
  const windowsExecutable = path.join(fixtureRoot, "codex-windows.exe");
  const malformedWindowsExecutable = path.join(fixtureRoot, "codex-malformed.exe");
  const invalidTrailingWindowsExecutable = path.join(fixtureRoot, "codex-windows-trailing-section.exe");
  const linuxHeader = createElf64ExecutableFixture();
  const invalidLinuxOffsetHeader = linuxHeader.slice();
  new DataView(invalidLinuxOffsetHeader.buffer).setBigUint64(32, 4_096n, true);
  const invalidTrailingLinuxHeader = createElf64ExecutableFixture(2);
  const trailingProgramHeaderOffset = 64 + 56;
  const invalidTrailingLinuxView = new DataView(invalidTrailingLinuxHeader.buffer);
  invalidTrailingLinuxView.setUint32(trailingProgramHeaderOffset, 1, true);
  invalidTrailingLinuxView.setBigUint64(trailingProgramHeaderOffset + 8, 4_096n, true);
  invalidTrailingLinuxView.setBigUint64(trailingProgramHeaderOffset + 32, 1n, true);
  invalidTrailingLinuxView.setBigUint64(trailingProgramHeaderOffset + 40, 1n, true);
  const macHeader = createThinMachO64ExecutableFixture();
  const macFat64Header = createFatMachO64ExecutableFixture(macHeader);
  const invalidMacSectionCountHeader = macHeader.slice();
  new DataView(invalidMacSectionCountHeader.buffer).setUint32(32 + 64, 1, true);
  const windowsHeader = createPortableExecutableFixture();
  const invalidTrailingWindowsHeader = createPortableExecutableFixture(2);
  const trailingSectionOffset = 0x80 + 24 + 112 + 40;
  const invalidTrailingWindowsView = new DataView(invalidTrailingWindowsHeader.buffer);
  invalidTrailingWindowsView.setUint32(trailingSectionOffset + 16, 1, true);
  invalidTrailingWindowsView.setUint32(trailingSectionOffset + 20, invalidTrailingWindowsHeader.byteLength, true);

  await Promise.all([
    writeFile(linuxExecutable, linuxHeader),
    writeFile(truncatedLinuxExecutable, linuxHeader.slice(0, -1)),
    writeFile(invalidLinuxOffsetExecutable, invalidLinuxOffsetHeader),
    writeFile(invalidTrailingLinuxExecutable, invalidTrailingLinuxHeader),
    writeFile(macExecutable, macHeader),
    writeFile(macFat64Executable, macFat64Header),
    writeFile(truncatedMacExecutable, macHeader.slice(0, -1)),
    writeFile(truncatedMacFat64Executable, macFat64Header.slice(0, -1)),
    writeFile(invalidMacSectionCountExecutable, invalidMacSectionCountHeader),
    writeFile(windowsExecutable, windowsHeader),
    writeFile(malformedWindowsExecutable, windowsHeader.slice(0, -1)),
    writeFile(invalidTrailingWindowsExecutable, invalidTrailingWindowsHeader),
  ]);
  await Promise.all([
    chmod(linuxExecutable, 0o755),
    chmod(truncatedLinuxExecutable, 0o755),
    chmod(invalidLinuxOffsetExecutable, 0o755),
    chmod(invalidTrailingLinuxExecutable, 0o755),
    chmod(macExecutable, 0o755),
    chmod(macFat64Executable, 0o755),
    chmod(truncatedMacExecutable, 0o755),
    chmod(truncatedMacFat64Executable, 0o755),
    chmod(invalidMacSectionCountExecutable, 0o755),
  ]);

  assert.equal(
    await resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: linuxExecutable }, "linux"),
    linuxExecutable,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: truncatedLinuxExecutable }, "linux"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: invalidLinuxOffsetExecutable }, "linux"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: invalidTrailingLinuxExecutable }, "linux"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: macExecutable }, "linux"),
    /native executable/u,
  );
  assert.equal(
    await resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: macExecutable }, "darwin"),
    macExecutable,
  );
  assert.equal(
    await resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: macFat64Executable }, "darwin"),
    macFat64Executable,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: truncatedMacExecutable }, "darwin"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: truncatedMacFat64Executable }, "darwin"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: invalidMacSectionCountExecutable }, "darwin"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: linuxExecutable }, "darwin"),
    /native executable/u,
  );
  assert.equal(
    await resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: windowsExecutable }, "win32"),
    windowsExecutable,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: malformedWindowsExecutable }, "win32"),
    /native executable/u,
  );
  await assert.rejects(
    resolveConfiguredCodexExecutable({ [WITHMATE_CODEX_EXECUTABLE_ENV]: invalidTrailingWindowsExecutable }, "win32"),
    /native executable/u,
  );
});

function createElf64ExecutableFixture(programHeaderCount = 1): Uint8Array {
  const fixture = new Uint8Array(64 + programHeaderCount * 56);
  fixture.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  const view = new DataView(fixture.buffer);
  view.setUint16(16, 3, true);
  view.setUint16(18, 0x3e, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, programHeaderCount, true);
  view.setUint32(64, 1, true);
  view.setUint32(68, 5, true);
  view.setBigUint64(72, 0n, true);
  view.setBigUint64(96, BigInt(fixture.byteLength), true);
  view.setBigUint64(104, BigInt(fixture.byteLength), true);
  return fixture;
}

function createThinMachO64ExecutableFixture(): Uint8Array {
  const fixture = new Uint8Array(32 + 72 + 24);
  fixture.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  const view = new DataView(fixture.buffer);
  view.setUint32(4, 0x01000007, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 2, true);
  view.setUint32(20, 96, true);
  view.setUint32(32, 0x19, true);
  view.setUint32(36, 72, true);
  view.setBigUint64(72, 0n, true);
  view.setBigUint64(80, BigInt(fixture.byteLength), true);
  view.setUint32(92, 5, true);
  view.setUint32(104, 0x80000028, true);
  view.setUint32(108, 24, true);
  return fixture;
}

function createFatMachO64ExecutableFixture(slice: Uint8Array): Uint8Array {
  const sliceOffset = 40;
  const fixture = new Uint8Array(sliceOffset + slice.byteLength);
  fixture.set([0xca, 0xfe, 0xba, 0xbf], 0);
  const view = new DataView(fixture.buffer);
  view.setUint32(4, 1, false);
  view.setUint32(8, 0x01000007, false);
  view.setBigUint64(16, BigInt(sliceOffset), false);
  view.setBigUint64(24, BigInt(slice.byteLength), false);
  fixture.set(slice, sliceOffset);
  return fixture;
}

function createPortableExecutableFixture(sectionCount = 1): Uint8Array {
  const peOffset = 0x80;
  const optionalHeaderSize = 112;
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;
  const fixture = new Uint8Array(sectionTableOffset + sectionCount * 40 + 1);
  fixture.set([0x4d, 0x5a], 0);
  const view = new DataView(fixture.buffer);
  view.setUint32(0x3c, peOffset, true);
  fixture.set([0x50, 0x45, 0x00, 0x00], peOffset);
  view.setUint16(peOffset + 4, 0x8664, true);
  view.setUint16(peOffset + 6, sectionCount, true);
  view.setUint16(peOffset + 20, optionalHeaderSize, true);
  view.setUint16(peOffset + 22, 0x0002, true);
  view.setUint16(peOffset + 24, 0x020b, true);
  view.setUint32(peOffset + 24 + 16, 0x1000, true);
  view.setUint32(sectionTableOffset + 16, 1, true);
  view.setUint32(sectionTableOffset + 20, fixture.byteLength - 1, true);
  view.setUint32(sectionTableOffset + 36, 0x60000020, true);
  return fixture;
}

test("Codex runtime records the observed CLI identity without treating its version as an admission gate", () => {
  assert.equal(observeCodexCliVersion("codex-cli/0.145.0"), "0.145.0");
  assert.equal(observeCodexCliVersion("codex-cli/0.146.0"), "0.146.0");
  assert.equal(observeCodexCliVersion("codex-cli/future"), "future");
  assert.equal(observeCodexCliVersion("codex_cli_rs/0.147.0"), "codex_cli_rs/0.147.0");
});

test("Codex runtime starts an observed 0.146 App Server and lets decoded protocol operations decide compatibility", async () => {
  const methods: string[] = [];
  let closeCalls = 0;
  const transport = {
    async start() {
      return {
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
        userAgent: "codex-cli/0.146.0",
      };
    },
    request<TResult>(method: string): Promise<TResult> {
      methods.push(method);
      if (method !== "model/list") return Promise.reject(new Error("unexpected request"));
      return Promise.resolve({
        data: [
          {
            id: "gpt-5.6",
            model: "gpt-5.6",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.6",
            description: "General model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
            defaultReasoningEffort: "high",
            inputModalities: ["text", "image"],
            supportsPersonality: true,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
            futureField: "ignored",
          },
        ],
        nextCursor: null,
        futurePageField: true,
      } as TResult);
    },
    nextEvent() {
      return new Promise(() => undefined);
    },
    observeServerRequestResolution() {
      return Object.freeze({ kind: "invalid" as const });
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as CodexAppServerTransport;
  const factory = new CodexApplicationRunRuntimeFactory(
    { [WITHMATE_CODEX_EXECUTABLE_ENV]: process.execPath },
    { createTransport: () => transport },
  );

  const runtime = await factory.start("codex", "codex-0.146", new AbortController().signal);
  const preflightCapability = runtime.adapter.preflightCapability;
  if (preflightCapability === undefined) assert.fail("expected Codex capability preflight");
  const result = await preflightCapability.call(runtime.adapter, {
    model: "gpt-5.6",
    modelSelection: "explicit",
    reasoningEffort: "high",
    requiredModality: "text",
  });

  assert.deepEqual(result, { kind: "supported", effect: "none" });
  assert.deepEqual(methods, ["model/list"]);

  await runtime.adapter.close();
  assert.equal(closeCalls, 1);
});

type RuntimeFixtureOptions = Readonly<{
  factory?: ReturnType<typeof runtimeFactory> | ApplicationRunProviderRuntimeFactory;
  reads?: ApplicationRunRuntimeReadPort;
  limits?: Readonly<{
    maxLiveRuns?: number;
    maxTrackedBindings?: number;
    recoveryAttachTimeoutMs?: number;
  }>;
  bindingResolutionUnknownOnce?: boolean;
  bindingResolutionUnknownCount?: number;
  bindingResolutionUnavailable?(): boolean;
  terminalUnknownOnce?: boolean;
  terminalUnknownCount?: number;
  dispatchReady?: ApplicationRunDispatchReadyPort;
  events?: ApplicationRunProviderEventPort;
  persistenceRetryable?: () => boolean;
  onResolveBinding?(): void;
  onTerminal?(): void;
}>;

function runtimeFixture(options: RuntimeFixtureOptions = {}) {
  const bindingResolutions: Parameters<ApplicationRunRuntimeWritePort["resolveProviderBinding"]>[0][] = [];
  const terminals: Parameters<ApplicationRunRuntimeWritePort["completeRun"]>[0][] = [];
  const ready: Parameters<ApplicationRunDispatchReadyPort["ready"]>[0][] = [];
  let bindingResolutionCalls = 0;
  let terminalCalls = 0;
  const writes: ApplicationRunRuntimeWritePort = {
    async resolveProviderBinding(command) {
      bindingResolutions.push(command);
      bindingResolutionCalls += 1;
      if (
        options.bindingResolutionUnavailable?.() === true ||
        (options.bindingResolutionUnknownOnce === true && bindingResolutionCalls === 1) ||
        bindingResolutionCalls <= (options.bindingResolutionUnknownCount ?? 0)
      ) {
        throw new PersistenceClientError({
          code: "request_timeout",
          message: "response lost",
          retryable: true,
          effect: "unknown",
        });
      }
      options.onResolveBinding?.();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        bindingId: command.bindingId,
        bindingState: "active",
        externalConversationId: command.resolution.externalConversationId,
        ephemeralOwnership: "not_applicable",
      });
    },
    async completeRun(command) {
      terminals.push(command);
      terminalCalls += 1;
      if (
        (options.terminalUnknownOnce === true && terminalCalls === 1) ||
        terminalCalls <= (options.terminalUnknownCount ?? 0)
      ) {
        throw new PersistenceClientError({
          code: "request_timeout",
          message: "response lost",
          retryable: true,
          effect: "unknown",
        });
      }
      options.onTerminal?.();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        phase: command.outcome.kind,
        finalAssistantMessageId: null,
        terminalEventId: command.terminalEvent.id,
        childDeliveryId: null,
        delegationState: null,
        terminalAt: 100,
      });
    },
  };
  const owner = new ApplicationRunRuntimeService({
    reads: options.reads ?? runtimeReads(() => recoveryProjection()),
    writes,
    runtimeFactory: options.factory ?? runtimeFactory(new FakeAdapter()),
    dispatchReady:
      options.dispatchReady ??
      ({
        ready(dispatch) {
          ready.push(dispatch);
        },
      } satisfies ApplicationRunDispatchReadyPort),
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.persistenceRetryable === undefined ? {} : { persistenceRetryable: options.persistenceRetryable }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { owner, bindingResolutions, terminals, ready };
}

function runtimeReads(
  recovery: (
    input: Parameters<ApplicationRunRuntimeReadPort["recoveryGet"]>[0],
  ) => ReturnType<typeof recoveryProjection>,
  providerId = "codex",
  modelSelection: "explicit" | "inherited" = "explicit",
): ApplicationRunRuntimeReadPort {
  return {
    async sessionGet(input) {
      return {
        session: sessionDetail(providerId, input.sessionId),
        execution: {
          state: "running",
          activeRunId: input.sessionId === "session-2" ? "run-2" : "run-1",
          latestRunId: input.sessionId === "session-2" ? "run-2" : "run-1",
        },
      };
    },
    async sessionDirectoriesChunk() {
      throw new Error("inline directories must not use chunks");
    },
    async runGet(input) {
      const snapshot = executionSnapshot(providerId, modelSelection);
      return {
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        run: {
          id: input.runId,
          sessionId: input.sessionId,
          ordinal: 1,
          initiatingMessageId: input.runId === "run-2" ? "message-2" : "message-1",
          phase: "queued",
          executionSnapshotByteLength: Buffer.byteLength(JSON.stringify(snapshot)),
          executionSnapshotState: "inline",
          executionSnapshot: snapshot,
          externalSideEffectState: "absent",
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      };
    },
    async runSnapshotChunk() {
      throw new Error("inline snapshot must not use chunks");
    },
    async messageContentChunk(input) {
      return chunkResult(
        {
          sessionId: input.sessionId,
          messageId: input.messageId,
        },
        contentBlocks(),
        input.offset,
        input.maxBytes,
      );
    },
    async recoveryGet(input) {
      const value = recovery(input);
      return {
        ...value,
        providerId,
        runId: input.runId,
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        ...(input.runId === "run-2"
          ? {
              attemptId: "attempt-2",
              bindingId: "binding-2",
            }
          : {}),
      };
    },
  };
}

function sessionDetail(providerId = "codex", sessionId = "session-1") {
  return {
    id: sessionId,
    title: "Session",
    providerId,
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    workspacePath: workspacePath(),
    localRepositoryKey: null,
    repositoryName: null,
    allowedAdditionalDirectoriesByteLength: Buffer.byteLength(JSON.stringify([additionalDirectory()])),
    allowedAdditionalDirectoriesState: "inline" as const,
    allowedAdditionalDirectories: [additionalDirectory()],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 1,
    lifecycleStatus: "active" as const,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  };
}

function recoveryProjection(
  overrides: Readonly<{
    attemptId?: string;
    bindingState?: "creating" | "active";
    externalConversationId?: string | null;
  }> = {},
) {
  return {
    runId: "run-1",
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runPhase: "queued",
    runUpdatedAt: 1,
    attemptId: overrides.attemptId ?? "attempt-1",
    attemptOrdinal: 1,
    attemptState: "preparing",
    externalExecutionId: null,
    bindingId: "binding-1",
    providerId: "codex",
    persistenceMode: "persistent" as const,
    bindingState: overrides.bindingState ?? ("creating" as const),
    externalConversationId: overrides.externalConversationId ?? null,
    dispatchState: "pending" as const,
    providerIdempotencyKey: null,
  };
}

function recoveryCandidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    runId: "run-1",
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    sessionProviderId: "codex",
    runPhase: "queued",
    runVersion: 1,
    initiatingMessageId: "message-1",
    runCreatedAt: 1,
    runUpdatedAt: 1,
    cancelRequestedAt: null,
    externalSideEffectState: "none",
    currentAttemptCount: 1,
    attemptId: "attempt-1",
    attemptOrdinal: 1,
    attemptState: "preparing",
    attemptProviderBindingId: "binding-1",
    externalExecutionId: null,
    bindingCandidateCount: 1,
    bindingId: "binding-1",
    bindingSessionId: "session-1",
    bindingProviderId: "codex",
    persistenceMode: "persistent",
    bindingState: "active",
    bindingCreatorAttemptId: "attempt-1",
    bindingCreatorRunId: "run-1",
    bindingCreatorSessionId: "session-1",
    externalConversationId: "thread-1",
    dispatchCount: 1,
    dispatchState: "pending",
    providerIdempotencyKey: null,
    ...overrides,
  };
}

function acceptedRecoveryCandidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return recoveryCandidate({
    runPhase: "active",
    runVersion: 4,
    externalSideEffectState: "present",
    attemptState: "active",
    externalExecutionId: "turn-1",
    dispatchState: "accepted",
    ...overrides,
  });
}

function runtimeReadsWithCandidates(candidates: readonly RecoveryCandidate[]): ApplicationRunRuntimeReadPort {
  const base = runtimeReads(() => recoveryProjection());
  return {
    ...base,
    async recoveryCandidatesPage() {
      return { items: candidates };
    },
    async recoveryGet(input) {
      const candidate = candidates.find(
        (item) =>
          item.sessionId === input.sessionId && item.workspaceKey === input.workspaceKey && item.runId === input.runId,
      );
      if (candidate === undefined) return base.recoveryGet(input);
      return {
        runId: candidate.runId,
        sessionId: candidate.sessionId,
        workspaceKey: candidate.workspaceKey,
        runPhase: candidate.runPhase,
        runUpdatedAt: candidate.runUpdatedAt,
        attemptId: candidate.attemptId,
        attemptOrdinal: candidate.attemptOrdinal,
        attemptState: candidate.attemptState,
        externalExecutionId: candidate.externalExecutionId,
        bindingId: candidate.bindingId,
        providerId: candidate.bindingProviderId,
        persistenceMode: candidate.persistenceMode,
        bindingState: candidate.bindingState,
        externalConversationId: candidate.externalConversationId,
        dispatchState: candidate.dispatchState,
        providerIdempotencyKey: candidate.providerIdempotencyKey,
      };
    },
    async runGet(input) {
      const projection = await base.runGet(input);
      const candidate = candidates.find(
        (item) =>
          item.sessionId === input.sessionId && item.workspaceKey === input.workspaceKey && item.runId === input.runId,
      );
      if (candidate === undefined) return projection;
      return {
        ...projection,
        run: {
          ...projection.run,
          phase: candidate.runPhase,
          version: candidate.runVersion,
          externalSideEffectState: candidate.externalSideEffectState,
          updatedAt: candidate.runUpdatedAt,
          ...(candidate.cancelRequestedAt === null ? {} : { cancelRequestedAt: candidate.cancelRequestedAt }),
        },
      };
    },
  };
}

function executionSnapshot(
  providerId = "codex",
  modelSelection: "explicit" | "inherited" = "explicit",
): RunExecutionSnapshot {
  return {
    providerId,
    definitionVersion: "codex-provider-v1",
    modelSelection,
    settings: {
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandbox: { mode: "workspace-write", networkAccess: false },
    },
    workspace: {
      key: TEST_WORKSPACE.workspaceKey,
      path: workspacePath(),
      allowedAdditionalDirectories: [additionalDirectory()],
    },
    character: null,
  };
}

function contentBlocks(): readonly TextContentBlock[] {
  return [{ type: "text", text: "hello" }];
}

function admission(
  overrides: Partial<
    Pick<ApplicationRunAdmissionRecord, "sessionId" | "runId" | "attemptId" | "bindingId" | "bindingState">
  > = {},
): ApplicationRunAdmissionRecord {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    messageId: overrides.runId === "run-2" ? "message-2" : "message-1",
    runId: overrides.runId ?? "run-1",
    attemptId: overrides.attemptId ?? "attempt-1",
    bindingId: overrides.bindingId ?? "binding-1",
    runPhase: "queued",
    bindingState: overrides.bindingState ?? "creating",
    dispatchState: "pending",
    admittedAt: 1,
  };
}

function workspacePath(): string {
  return process.platform === "win32" ? "C:\\workspace" : "/workspace";
}

function additionalDirectory(): string {
  return process.platform === "win32" ? "C:\\shared" : "/shared";
}

function nearMaximumAdditionalDirectories(): readonly string[] {
  const targetLength = ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength - 32;
  const directories = Array.from({ length: 128 }, (_value, index) => {
    const prefix = path.join(path.parse(process.cwd()).root, `scope-${index.toString().padStart(3, "0")}-`);
    return `${prefix}${"x".repeat(targetLength - prefix.length)}`;
  });
  let remaining =
    ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes - Buffer.byteLength(JSON.stringify(directories), "utf8");
  for (let index = 0; index < directories.length && remaining > 0; index += 1) {
    const capacity = ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength - (directories[index] as string).length;
    const appended = Math.min(capacity, remaining);
    directories[index] = `${directories[index]}${"x".repeat(appended)}`;
    remaining -= appended;
  }
  assert.equal(
    Buffer.byteLength(JSON.stringify(directories), "utf8"),
    ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes,
  );
  return Object.freeze(directories);
}

function success<TValue>(value: TValue): RepositoryCommandResult<TValue> {
  return { ok: true, value, replayed: false };
}

function chunkResult<TScope extends Readonly<Record<string, string>>>(
  scope: TScope,
  value: unknown,
  offset: number,
  maxBytes: number,
): TScope & Readonly<{ offset: number; totalBytes: number; eof: boolean; bytes: ArrayBuffer }> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes));
  return {
    ...scope,
    offset,
    totalBytes: bytes.byteLength,
    eof: offset + chunk.byteLength === bytes.byteLength,
    bytes: chunk.buffer,
  };
}

function runtimeFactory(adapter: FakeAdapter) {
  return {
    starts: 0,
    supports(providerId: string) {
      return providerId === "codex";
    },
    async start(providerId: string, generationId: string) {
      this.starts += 1;
      return { providerId, generationId, adapter };
    },
  } satisfies ApplicationRunProviderRuntimeFactory & { starts: number };
}

class FakeAdapter implements ApplicationRunProviderAdapterPort {
  readonly preflightInputs: CodexAdapterCapabilityPreflightInput[] = [];
  readonly startInputs: CodexStartThreadInput[] = [];
  readonly resumeInputs: CodexResumeThreadInput[] = [];
  readonly readInputs: CodexReadThreadInput[] = [];
  readonly turnInputs: CodexStartTurnInput[] = [];
  readonly interruptInputs: CodexInterruptTurnInput[] = [];
  eventWaits = 0;
  eventWaitsBeforeFirstMutation = 0;
  closeCalls = 0;
  #closed = false;
  readonly #events: CodexAdapterEvent[] = [];
  #eventResolve: ((event: CodexAdapterEvent) => void) | undefined;
  #eventReject: ((error: Error) => void) | undefined;
  readonly #startResult: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
  readonly #resumeResult: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
  readonly #readResult: CodexAdapterReadResult<CodexAdapterReadThreadSnapshot>;
  readonly #interruptResult: CodexAdapterMutationResult<CodexAdapterInterruptAcknowledgement>;
  readonly #preflightResult: CodexAdapterCapabilityPreflightResult;
  readonly #startOperation:
    ((signal: AbortSignal | undefined) => Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>>) | undefined;
  readonly #nextEventThrows: boolean;
  readonly #onClose: (() => void) | undefined;
  readonly #closeOperation: (() => Promise<void>) | undefined;

  constructor(
    options: Readonly<{
      startResult?: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
      resumeResult?: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
      readResult?: CodexAdapterReadResult<CodexAdapterReadThreadSnapshot>;
      interruptResult?: CodexAdapterMutationResult<CodexAdapterInterruptAcknowledgement>;
      preflightResult?: CodexAdapterCapabilityPreflightResult;
      startOperation?(signal: AbortSignal | undefined): Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>>;
      nextEventThrows?: boolean;
      onClose?(): void;
      closeOperation?(): Promise<void>;
    }> = {},
  ) {
    this.#startResult = options.startResult ?? acceptedThread("thread-1");
    this.#resumeResult = options.resumeResult ?? acceptedThread("thread-existing");
    this.#readResult =
      options.readResult ??
      ({
        kind: "accepted",
        effect: "none",
        value: {
          threadId: "thread-1",
          status: "active",
          cliVersion: "0.145.0",
          turns: [{ turnId: "turn-1", status: "in_progress", itemCount: 0 }],
        },
      } as const);
    this.#interruptResult =
      options.interruptResult ??
      ({
        kind: "accepted",
        effect: "present",
        value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
      } as const);
    this.#preflightResult = options.preflightResult ?? { kind: "supported", effect: "none" };
    this.#startOperation = options.startOperation;
    this.#nextEventThrows = options.nextEventThrows === true;
    this.#onClose = options.onClose;
    this.#closeOperation = options.closeOperation;
  }

  async preflightCapability(input: CodexAdapterCapabilityPreflightInput) {
    this.preflightInputs.push(input);
    return this.#preflightResult;
  }

  async startThread(input: CodexStartThreadInput, options?: Readonly<{ signal?: AbortSignal }>) {
    this.#recordMutationReadiness();
    this.startInputs.push(input);
    return this.#startOperation === undefined ? this.#startResult : this.#startOperation(options?.signal);
  }

  async resumeThread(input: CodexResumeThreadInput) {
    this.#recordMutationReadiness();
    this.resumeInputs.push(input);
    return this.#resumeResult;
  }

  async readThread(input: CodexReadThreadInput) {
    this.readInputs.push(input);
    return this.#readResult;
  }

  async startTurn(input: CodexStartTurnInput): Promise<CodexAdapterMutationResult<CodexAdapterTurnSnapshot>> {
    this.#recordMutationReadiness();
    this.turnInputs.push(input);
    return {
      kind: "accepted",
      effect: "present",
      value: {
        threadId: input.threadId,
        turnId: "turn-1",
        status: "in_progress",
      },
    };
  }

  async interruptTurn(input: CodexInterruptTurnInput) {
    this.#recordMutationReadiness();
    this.interruptInputs.push(input);
    return this.#interruptResult;
  }

  nextEvent(): Promise<CodexAdapterEvent> {
    this.eventWaits += 1;
    if (this.#nextEventThrows) throw new Error("event consumer unavailable");
    const event = this.#events.shift();
    if (event !== undefined) return Promise.resolve(event);
    if (this.#closed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => {
      this.#eventResolve = resolve;
      this.#eventReject = reject;
    });
  }

  emit(event: CodexAdapterEvent): void {
    const resolve = this.#eventResolve;
    if (resolve === undefined) {
      this.#events.push(event);
      return;
    }
    this.#eventResolve = undefined;
    this.#eventReject = undefined;
    resolve(event);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.closeCalls += 1;
    await this.#closeOperation?.();
    this.#closed = true;
    this.#onClose?.();
    this.#eventReject?.(new Error("closed"));
  }

  #recordMutationReadiness(): void {
    if (this.startInputs.length + this.resumeInputs.length === 0) {
      this.eventWaitsBeforeFirstMutation = this.eventWaits;
    }
  }
}

function acceptedThread(threadId: string): CodexAdapterMutationResult<CodexAdapterThreadSnapshot> {
  return {
    kind: "accepted",
    effect: "present",
    value: {
      threadId,
      status: "idle",
      model: "gpt-5.6",
      modelProvider: "openai",
      cliVersion: "0.145.0",
      reasoningEffort: "high",
    },
  };
}

function acceptedActiveThread(threadId: string): CodexAdapterMutationResult<CodexAdapterThreadSnapshot> {
  return {
    kind: "accepted",
    effect: "present",
    value: {
      threadId,
      status: "active",
      model: "gpt-5.6",
      modelProvider: "openai",
      cliVersion: "0.145.0",
      reasoningEffort: "high",
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime owner state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
