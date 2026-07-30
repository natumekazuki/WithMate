import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type {
  ApplicationRunExecutionSettings,
  ApplicationRunStartRequest,
} from "../src/shared/application-run-model.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../src/shared/application-run-payload-limits.js";
import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../src/shared/allowed-additional-directories.js";
import {
  type ApplicationRunAdmissionCommand,
  type ApplicationRunAdmissionPort,
  type ApplicationRunAdmissionRecord,
  RepositoryApplicationRunAdmissionPort,
} from "../src/main/application-run-admission-service.js";
import { ApplicationRunService, type ApplicationRunServiceOptions } from "../src/main/application-run-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type { RepositoryWriteClient } from "../src/main/repository-write-client.js";
import { MESSAGE_CONTENT_LIMITS } from "../src/shared/message-content.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";

type Authorization = Readonly<{ principal: "owner" }>;
type Reads = ApplicationRunServiceOptions<Authorization>["reads"];

const authorization: Authorization = { principal: "owner" };
const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000701";
const defaultWorkspace = resolveWorkspaceIdentity(path.resolve("workspace"))!;
const otherWorkspace = resolveWorkspaceIdentity(path.resolve("other-workspace"))!;
const sharedDirectory = path.resolve("shared");
const execution: ApplicationRunExecutionSettings = {
  model: "gpt-test",
  reasoningEffort: "medium",
  sandbox: { mode: "workspace-write", networkAccess: false },
};

test("start authorizes a write target, derives private scope from Session, and projects only public Run identity", async () => {
  const authorized: unknown[] = [];
  const admitted: ApplicationRunAdmissionCommand[] = [];
  const handedOff: ApplicationRunAdmissionRecord[] = [];
  const service = createService({
    access: {
      async authorize(input) {
        authorized.push(input);
        return { allowed: true };
      },
    },
    admission: admissionPort(admitted),
    handoff: { handoff: (record) => handedOff.push(record) },
  });

  const response = await service.start(startRequest());

  assert.deepEqual(authorized, [
    {
      operation: "start",
      access: "write",
      context: { authorization },
      target: { kind: "session_run_start", sessionId: "session-1" },
    },
  ]);
  assert.equal(admitted.length, 1);
  assert.deepEqual(admitted[0], {
    operation: "start",
    sessionId: "session-1",
    workspaceKey: defaultWorkspace.workspaceKey,
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "hello" }],
    executionSnapshot: {
      providerId: "codex",
      model: "gpt-test",
      modelSelection: "explicit",
      reasoning: { effort: "medium" },
      approval: { policy: "never" },
      sandbox: { mode: "workspace-write", networkAccess: false },
      workspace: {
        key: defaultWorkspace.workspaceKey,
        path: defaultWorkspace.workspacePath,
        allowedAdditionalDirectories: [sharedDirectory],
      },
      character: null,
    },
    providerRequest: {
      contentBlocks: [{ type: "text", text: "hello" }],
      model: "gpt-test",
      reasoningEffort: "medium",
      approvalPolicy: "never",
      sandboxPolicy: {
        mode: "workspace-write",
        networkAccess: false,
        writableRoots: [defaultWorkspace.workspacePath, sharedDirectory],
      },
      workspacePath: defaultWorkspace.workspacePath,
    },
  });
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus !== "success") return;
  assert.deepEqual(response.value, { sessionId: "session-1", runId: "run-new", phase: "queued" });
  assert.deepEqual(response.persistence, { status: "committed", effect: "none", replayed: false });
  assert.equal(handedOff.length, 1);
  assert.equal(JSON.stringify(response).includes("attempt-"), false);
  assert.equal(JSON.stringify(response).includes("binding-"), false);
  assert.equal(JSON.stringify(response).includes("workspace"), false);
  assert.equal(JSON.stringify(response).includes("codex"), false);
});

test("Repository admission adapter omits caller-owned identities and provider-native idempotency", async () => {
  const writes: unknown[] = [];
  const fakeWrites = {
    async admitNormalRun(command: unknown) {
      writes.push(command);
      return admissionSuccess();
    },
    async admitRetryRun(command: unknown) {
      writes.push(command);
      return admissionSuccess({ retryOfRunId: "run-source" });
    },
  } as unknown as RepositoryWriteClient;
  const port = new RepositoryApplicationRunAdmissionPort(fakeWrites);
  const base = {
    sessionId: "session-1",
    workspaceKey: defaultWorkspace.workspaceKey,
    idempotencyKey,
    executionSnapshot: repositoryExecutionSnapshot(),
    providerRequest: { prompt: "hello" },
  } as const;

  await port.admit({
    ...base,
    operation: "start",
    contentBlocks: [{ type: "text", text: "hello" }],
  });
  await port.admit({
    ...base,
    operation: "retry",
    retryOfRunId: "run-source",
    contentBlocks: [{ type: "text", text: "source body" }],
  });

  assert.deepEqual(writes, [
    {
      sessionId: "session-1",
      workspaceKey: defaultWorkspace.workspaceKey,
      idempotencyKey,
      message: { contentBlocks: [{ type: "text", text: "hello" }] },
      run: { executionSnapshot: repositoryExecutionSnapshot() },
      dispatch: { providerRequest: { prompt: "hello" }, providerIdempotencyKey: null },
    },
    {
      sessionId: "session-1",
      workspaceKey: defaultWorkspace.workspaceKey,
      idempotencyKey,
      retryOfRunId: "run-source",
      run: { executionSnapshot: repositoryExecutionSnapshot() },
      dispatch: { providerRequest: { prompt: "hello" }, providerIdempotencyKey: null },
    },
  ]);
});

test("retry reuses the source Message, inherits the full snapshot, and overrides only specified settings", async () => {
  const admitted: ApplicationRunAdmissionCommand[] = [];
  const chunkRequests: unknown[] = [];
  const sourceContent = [{ type: "text", text: "source body" }] as const;
  const service = createService({
    reads: reads({
      messageContentChunk: chunkReader(
        { sessionId: "session-1", messageId: "message-source" },
        sourceContent,
        chunkRequests,
        5,
      ) as Reads["messageContentChunk"],
    }),
    admission: admissionPort(admitted, { retryOfRunId: "run-source" }),
  });

  const response = await service.retry({
    context: { authorization },
    sessionId: "session-1",
    retryOfRunId: "run-source",
    idempotencyKey,
    executionOverrides: { reasoningEffort: "high" },
  });

  assert.equal(response.overallStatus, "success");
  assert.ok(chunkRequests.length > 1);
  assert.equal(admitted.length, 1);
  const command = admitted[0]!;
  assert.equal(command.operation, "retry");
  if (command.operation !== "retry") return;
  assert.deepEqual(command.contentBlocks, sourceContent);
  assert.equal(command.retryOfRunId, "run-source");
  assert.deepEqual(command.executionSnapshot, {
    ...repositoryExecutionSnapshot(),
    modelSelection: "inherited",
    reasoning: { effort: "high" },
  });
  assert.deepEqual(command.providerRequest.contentBlocks, sourceContent);
  assert.equal(command.providerRequest.model, "gpt-source");
  assert.equal(command.providerRequest.reasoningEffort, "high");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.value, {
      sessionId: "session-1",
      runId: "run-new",
      retryOfRunId: "run-source",
      phase: "queued",
    });
  }
});

test("start and retry reject caller-controlled scope, unknown fields, accessors, sparse content, and Proxy input", async () => {
  let admissions = 0;
  const service = createService({
    admission: {
      async admit() {
        admissions += 1;
        return admissionSuccess();
      },
    },
  });
  const withWorkspace = { ...startRequest(), workspacePath: "C:\\attacker" };
  const withProvider = { ...startRequest(), providerId: "other" };
  const sparse = startRequest() as unknown as {
    contentBlocks: unknown[];
  };
  sparse.contentBlocks = new Array(1);
  const accessor = startRequest() as Record<string, unknown>;
  Object.defineProperty(accessor, "sessionId", { enumerable: true, get: () => "session-1" });
  const proxy = new Proxy(startRequest(), {
    ownKeys() {
      throw new Error("trap");
    },
  });
  const transparentProxy = new Proxy(startRequest(), {});
  const proxiedBlockRequest = startRequest() as unknown as { contentBlocks: unknown[] };
  proxiedBlockRequest.contentBlocks = [new Proxy({ type: "text", text: "hello" }, {})];
  const proxiedArrayRequest = startRequest() as unknown as { contentBlocks: unknown[] };
  proxiedArrayRequest.contentBlocks = new Proxy([{ type: "text", text: "hello" }], {});

  for (const request of [
    withWorkspace,
    withProvider,
    sparse,
    accessor,
    proxy,
    transparentProxy,
    proxiedBlockRequest,
    proxiedArrayRequest,
  ]) {
    assert.deepEqual(await service.start(request as ApplicationRunStartRequest<Authorization>), requestFailure());
  }
  assert.deepEqual(
    await service.retry({
      context: { authorization },
      sessionId: "session-1",
      retryOfRunId: "run-source",
      idempotencyKey,
      executionOverrides: {
        sandbox: { mode: "workspace-write", networkAccess: false },
        workspacePath: "C:\\bad",
      } as never,
    }),
    requestFailure(),
  );
  assert.equal(admissions, 0);
});

test("authorization actively observes timeout and cancellation even when the access port never settles", async () => {
  let reads = 0;
  let admissions = 0;
  const service = createService({
    access: {
      authorize: () => new Promise(() => {}),
    },
    reads: readsWithSessionCounter(() => {
      reads += 1;
    }),
    admission: {
      async admit() {
        admissions += 1;
        return admissionSuccess();
      },
    },
  });

  const timeout = await settlesWithin(service.start(startRequest(), { timeoutMs: 10 }));
  assert.equal(timeout.overallStatus, "failure");
  if (timeout.overallStatus === "failure") {
    assert.equal(timeout.error.code, "operation_timeout");
    assert.deepEqual(timeout.persistence, { status: "not_attempted", effect: "none" });
  }

  const abort = new AbortController();
  const canceledPromise = service.start(startRequest(), { signal: abort.signal });
  abort.abort();
  const canceled = await settlesWithin(canceledPromise);
  assert.equal(canceled.overallStatus, "failure");
  if (canceled.overallStatus === "failure") {
    assert.equal(canceled.error.code, "operation_canceled");
    assert.deepEqual(canceled.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(reads, 0);
  assert.equal(admissions, 0);
});

test("a non-cooperative repository read times out with no persistence effect and never reaches admission", async () => {
  let admissions = 0;
  const service = createService({
    reads: reads({
      sessionGet: () => new Promise(() => {}),
    }),
    admission: {
      async admit() {
        admissions += 1;
        return admissionSuccess();
      },
    },
  });

  const response = await settlesWithin(service.start(startRequest(), { timeoutMs: 100 }));

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "persistence_timeout");
    assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
  }
  assert.equal(admissions, 0);
});

test("a non-cooperative admission timeout reports unknown effect and does not hand off work", async () => {
  let handoffs = 0;
  const service = createService({
    admission: {
      admit: () => new Promise(() => {}),
    },
    handoff: {
      handoff() {
        handoffs += 1;
      },
    },
  });

  const response = await settlesWithin(service.start(startRequest(), { timeoutMs: 100 }));

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "persistence_timeout");
    assert.deepEqual(response.persistence, {
      status: "failed",
      effect: "unknown",
      reconciliation: "exact_request_required",
    });
  }
  assert.equal(handoffs, 0);
});

test("a fulfilled admission remains successful when cancellation arrives during handoff", async () => {
  const abort = new AbortController();
  let handoffs = 0;
  const service = createService({
    admission: {
      async admit() {
        return admissionSuccess();
      },
    },
    handoff: {
      handoff() {
        abort.abort();
        handoffs += 1;
      },
    },
  });

  const response = await service.start(startRequest(), { signal: abort.signal });

  assert.equal(response.overallStatus, "success");
  assert.equal(handoffs, 1);
});

test("exact start and retry replay return every current phase without scheduling Provider work again", async () => {
  const phases = [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ] as const;
  for (const operation of ["start", "retry"] as const) {
    for (const phase of phases) {
      let handoffs = 0;
      const service = createService({
        admission: {
          async admit() {
            return {
              ...admissionSuccess(operation === "retry" ? { retryOfRunId: "run-source" } : {}, {
                runPhase: phase,
                bindingState: "active",
                dispatchState: "accepted",
              }),
              replayed: true,
            };
          },
        },
        handoff: {
          handoff() {
            handoffs += 1;
          },
        },
      });

      const response =
        operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

      assert.equal(response.overallStatus, "success");
      if (response.overallStatus === "success") {
        assert.equal(response.value.phase, phase);
        assert.equal(response.persistence.replayed, true);
      }
      assert.equal(handoffs, 0);
    }
  }
});

test("fresh start and retry reject every non-queued admission phase", async () => {
  const phases = [
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ] as const;
  for (const operation of ["start", "retry"] as const) {
    for (const phase of phases) {
      let handoffs = 0;
      const service = createService({
        admission: admissionPort([], operation === "retry" ? { retryOfRunId: "run-source" } : {}, {
          runPhase: phase,
          bindingState: "active",
          dispatchState: "accepted",
        }),
        handoff: {
          handoff() {
            handoffs += 1;
          },
        },
      });

      const response =
        operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

      assert.equal(response.overallStatus, "failure");
      if (response.overallStatus === "failure") {
        assert.equal(response.error.code, "internal_error");
        assert.deepEqual(response.persistence, {
          status: "failed",
          effect: "unknown",
          reconciliation: "exact_request_required",
        });
      }
      assert.equal(handoffs, 0);
    }
  }
});

test("start and retry reject a non-boolean admission replay state for queued and terminal phases", async () => {
  for (const operation of ["start", "retry"] as const) {
    for (const phase of ["queued", "completed"] as const) {
      let handoffs = 0;
      const service = createService({
        admission: {
          async admit() {
            return {
              ...admissionSuccess(operation === "retry" ? { retryOfRunId: "run-source" } : {}, {
                runPhase: phase,
                bindingState: "active",
                dispatchState: "accepted",
              }),
              replayed: "false",
            } as never;
          },
        },
        handoff: {
          handoff() {
            handoffs += 1;
          },
        },
      });

      const response =
        operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

      assert.equal(response.overallStatus, "failure");
      if (response.overallStatus === "failure") {
        assert.equal(response.error.code, "internal_error");
        assert.deepEqual(response.persistence, {
          status: "failed",
          effect: "unknown",
          reconciliation: "exact_request_required",
        });
      }
      assert.equal(handoffs, 0);
    }
  }
});

test("exact replay never restarts creating Binding work but may recover a safe active Binding pending Dispatch", async () => {
  for (const bindingState of ["creating", "active"] as const) {
    let handoffs = 0;
    const service = createService({
      admission: {
        async admit() {
          return {
            ...admissionSuccess({}, { bindingState }),
            replayed: true,
          };
        },
      },
      handoff: {
        handoff() {
          handoffs += 1;
        },
      },
    });

    const response = await service.start(startRequest());

    assert.equal(response.overallStatus, "success");
    assert.equal(handoffs, bindingState === "active" ? 1 : 0);
  }
});

test("exact replay reaches Repository while the committed Run is active, but canceling pending work is not handed off", async () => {
  let admissions = 0;
  let handoffs = 0;
  const service = createService({
    reads: reads({ sessionGet: async () => sessionProjection({ activeRunId: "run-new" }) }),
    admission: {
      async admit() {
        admissions += 1;
        return {
          ...admissionSuccess(
            {},
            {
              runPhase: "canceling",
              bindingState: "active",
              dispatchState: "pending",
            },
          ),
          replayed: true,
        };
      },
    },
    handoff: {
      handoff() {
        handoffs += 1;
      },
    },
  });

  const response = await service.start(startRequest());

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.runId, "run-new");
    assert.equal(response.value.phase, "canceling");
    assert.equal(response.persistence.replayed, true);
  }
  assert.equal(admissions, 1);
  assert.equal(handoffs, 0);
});

test("authorization and missing retry source reject before admission", async () => {
  let admissions = 0;
  const admission: ApplicationRunAdmissionPort = {
    async admit() {
      admissions += 1;
      return admissionSuccess();
    },
  };
  const denied = createService({
    admission,
    access: {
      async authorize() {
        return { allowed: false, error: { code: "forbidden", message: "denied", retryable: false } };
      },
    },
  });
  assert.equal((await denied.start(startRequest())).overallStatus, "failure");

  const missing = createService({
    admission,
    reads: reads({
      runGet: async () => {
        throw new PersistenceClientError({
          code: "not_found",
          message: "missing",
          retryable: false,
          effect: "none",
        });
      },
    }),
  });
  const missingResponse = await missing.retry(retryRequest());
  assert.equal(missingResponse.overallStatus, "failure");
  if (missingResponse.overallStatus === "failure") {
    assert.equal(missingResponse.error.kind, "domain");
    assert.equal(missingResponse.error.code, "not_found");
  }
  assert.equal(admissions, 0);
});

test("exact start and retry replays reach Repository after the Session lifecycle changes", async () => {
  for (const operation of ["start", "retry"] as const) {
    let admissions = 0;
    const service = createService({
      reads: reads({
        sessionGet: async () => sessionProjection({ lifecycleStatus: operation === "start" ? "archived" : "closed" }),
      }),
      admission: {
        async admit() {
          admissions += 1;
          return {
            ...admissionSuccess(operation === "retry" ? { retryOfRunId: "run-source" } : {}, {
              runPhase: "completed",
              bindingState: "active",
              dispatchState: "accepted",
            }),
            replayed: true,
          };
        },
      },
    });

    const response = operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

    assert.equal(response.overallStatus, "success");
    if (response.overallStatus === "success") {
      assert.equal(response.value.runId, "run-new");
      assert.equal(response.value.phase, "completed");
      assert.equal(response.persistence.replayed, true);
    }
    assert.equal(admissions, 1);
  }
});

test("new start and retry requests delegate Session lifecycle rejection to Repository", async () => {
  for (const operation of ["start", "retry"] as const) {
    let admissions = 0;
    const service = createService({
      reads: reads({
        sessionGet: async () => sessionProjection({ lifecycleStatus: operation === "start" ? "archived" : "closed" }),
      }),
      admission: {
        async admit() {
          admissions += 1;
          return {
            ok: false,
            replayed: false,
            error: {
              code: "lifecycle_conflict",
              message: "Run admission requires an active Session.",
              retryable: false,
            },
          };
        },
      },
    });

    const response = operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") {
      assert.equal(response.error.kind, "domain");
      assert.equal(response.error.code, "lifecycle_conflict");
    }
    assert.equal(admissions, 1);
  }
});

test("a new request for a busy Session delegates the race-safe rejection to Repository", async () => {
  let admissions = 0;
  const service = createService({
    reads: reads({ sessionGet: async () => sessionProjection({ activeRunId: "run-active" }) }),
    admission: {
      async admit() {
        admissions += 1;
        return {
          ok: false,
          replayed: false,
          error: {
            code: "session_busy",
            message: "Session already has a non-terminal Run.",
            retryable: true,
          },
        };
      },
    },
  });

  const response = await service.start(startRequest());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.kind, "domain");
    assert.equal(response.error.code, "session_busy");
  }
  assert.equal(admissions, 1);
});

test("retry rejects non-terminal and stale execution scope without creating a new Message or admission", async () => {
  let admissions = 0;
  const admission: ApplicationRunAdmissionPort = {
    async admit() {
      admissions += 1;
      return admissionSuccess();
    },
  };
  const nonTerminal = createService({
    admission,
    reads: reads({ runGet: async () => runProjection({ phase: "active" }) }),
  });
  const nonTerminalResponse = await nonTerminal.retry(retryRequest());
  assert.equal(nonTerminalResponse.overallStatus, "failure");
  if (nonTerminalResponse.overallStatus === "failure")
    assert.equal(nonTerminalResponse.error.code, "lifecycle_conflict");

  const stale = createService({
    admission,
    reads: reads({
      runGet: async () =>
        runProjection({
          executionSnapshot: {
            ...repositoryExecutionSnapshot(),
            providerId: "other-provider",
          },
        }),
    }),
  });
  const staleResponse = await stale.retry(retryRequest());
  assert.equal(staleResponse.overallStatus, "failure");
  assert.equal(admissions, 0);
});

test("retry records whether the model was inherited or explicitly overridden", async () => {
  const inherited: ApplicationRunAdmissionCommand[] = [];
  const inheritedService = createService({
    admission: admissionPort(inherited, { retryOfRunId: "run-source" }),
  });
  const inheritedResponse = await inheritedService.retry(retryRequest());
  assert.equal(inheritedResponse.overallStatus, "success");
  assert.equal(inherited[0]?.executionSnapshot.model, "gpt-source");
  assert.equal(inherited[0]?.executionSnapshot.modelSelection, "inherited");

  const overridden: ApplicationRunAdmissionCommand[] = [];
  const overriddenService = createService({
    admission: admissionPort(overridden, { retryOfRunId: "run-source" }),
  });
  const overriddenResponse = await overriddenService.retry({
    ...retryRequest(),
    executionOverrides: { model: "gpt-override" },
  });
  assert.equal(overriddenResponse.overallStatus, "success");
  assert.equal(overridden[0]?.executionSnapshot.model, "gpt-override");
  assert.equal(overridden[0]?.executionSnapshot.modelSelection, "explicit");
});

test("start and retry preserve a canonical Session workspace path beyond the identifier length", async () => {
  const longWorkspacePath = path.resolve(`workspace-${"w".repeat(1_024)}`);
  const longWorkspace = resolveWorkspaceIdentity(longWorkspacePath)!;
  assert.ok(longWorkspacePath.length > 1_024);

  for (const operation of ["start", "retry"] as const) {
    const admitted: ApplicationRunAdmissionCommand[] = [];
    const longSnapshot = repositoryExecutionSnapshot(longWorkspacePath, longWorkspace.workspaceKey);
    const service = createService({
      admission: admissionPort(admitted, operation === "retry" ? { retryOfRunId: "run-source" } : {}),
      reads: reads({
        sessionGet: async () =>
          sessionProjection({
            workspaceKey: longWorkspace.workspaceKey,
            workspacePath: longWorkspacePath,
          }),
        runGet: async () =>
          runProjection({
            workspaceKey: longWorkspace.workspaceKey,
            executionSnapshot: longSnapshot,
          }),
      }),
    });

    const response = operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

    assert.equal(response.overallStatus, "success");
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.executionSnapshot.workspace.path, longWorkspacePath);
    assert.equal(admitted[0]?.providerRequest.workspacePath, longWorkspacePath);
  }
});

test("start and retry preserve the combined maximum Message and accepted Session directory scope", async () => {
  const directories = nearMaximumAdditionalDirectories();
  const emptyContentBytes = jsonByteLength([{ type: "text", text: "" }]);
  const contentBlocks = [
    { type: "text" as const, text: "x".repeat(MESSAGE_CONTENT_LIMITS.maxJsonBytes - emptyContentBytes) },
  ];
  const sourceSnapshot = {
    ...repositoryExecutionSnapshot(),
    sandbox: execution.sandbox,
    workspace: {
      key: defaultWorkspace.workspaceKey,
      path: defaultWorkspace.workspacePath,
      allowedAdditionalDirectories: directories,
    },
  };

  for (const operation of ["start", "retry"] as const) {
    const admitted: ApplicationRunAdmissionCommand[] = [];
    const service = createService({
      admission: admissionPort(admitted, operation === "retry" ? { retryOfRunId: "run-source" } : {}),
      reads: reads({
        sessionGet: async () => sessionProjection({ allowedAdditionalDirectories: directories }),
        runGet: async () => runProjection({ executionSnapshot: sourceSnapshot }),
        messageContentChunk: chunkReader(
          { sessionId: "session-1", messageId: "message-source" },
          contentBlocks,
        ) as Reads["messageContentChunk"],
      }),
    });

    const response =
      operation === "start"
        ? await service.start({ ...startRequest(), contentBlocks })
        : await service.retry(retryRequest());

    assert.equal(response.overallStatus, "success");
    assert.equal(admitted.length, 1);
    const command = admitted[0] as ApplicationRunAdmissionCommand;
    assert.ok(
      jsonByteLength(command.executionSnapshot) <= APPLICATION_RUN_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes,
    );
    assert.ok(jsonByteLength(command.providerRequest) <= APPLICATION_RUN_PAYLOAD_LIMITS.providerRequestMaxJsonBytes);
    assert.ok(jsonByteLength(command.providerRequest) > 5 * 1024 * 1024);
  }
});

test("retry reconstructs an accepted maximum execution snapshot from bounded chunks", async () => {
  const directories = nearMaximumAdditionalDirectories();
  const sourceSnapshot = {
    ...repositoryExecutionSnapshot(),
    workspace: {
      key: defaultWorkspace.workspaceKey,
      path: defaultWorkspace.workspacePath,
      allowedAdditionalDirectories: directories,
    },
  };
  const snapshotRequests: unknown[] = [];
  const admitted: ApplicationRunAdmissionCommand[] = [];
  const service = createService({
    admission: admissionPort(admitted, { retryOfRunId: "run-source" }),
    reads: reads({
      sessionGet: async () => sessionProjection({ allowedAdditionalDirectories: directories }),
      runGet: async () =>
        runProjection({
          executionSnapshotState: "chunked",
          executionSnapshot: sourceSnapshot,
        }),
      runSnapshotChunk: chunkReader(
        { sessionId: "session-1", runId: "run-source" },
        sourceSnapshot,
        snapshotRequests,
      ) as Reads["runSnapshotChunk"],
    }),
  });

  const response = await service.retry(retryRequest());

  assert.equal(response.overallStatus, "success");
  assert.ok(snapshotRequests.length > 1);
  assert.ok(snapshotRequests.every((request) => (request as Readonly<{ maxBytes: number }>).maxBytes <= 256 * 1024));
  assert.equal(admitted.length, 1);
});

test("start and retry reject a Session projection whose workspace path and key do not match", async () => {
  for (const operation of ["start", "retry"] as const) {
    const admitted: ApplicationRunAdmissionCommand[] = [];
    const service = createService({
      admission: admissionPort(admitted),
      reads: reads({
        sessionGet: async () => sessionProjection({ workspaceKey: otherWorkspace.workspaceKey }),
      }),
    });

    const response = operation === "start" ? await service.start(startRequest()) : await service.retry(retryRequest());

    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") {
      assert.equal(response.error.code, "persistence_operation_failed");
      assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
    }
    assert.equal(admitted.length, 0);
  }
});

test("chunked Session directories and execution snapshot are reconstructed with bounded reads", async () => {
  const directoryRequests: unknown[] = [];
  const snapshotRequests: unknown[] = [];
  const admitted: ApplicationRunAdmissionCommand[] = [];
  const service = createService({
    admission: admissionPort(admitted, { retryOfRunId: "run-source" }),
    reads: reads({
      sessionGet: async () =>
        sessionProjection({
          directoriesState: "chunked",
        }),
      sessionDirectoriesChunk: chunkReader(
        { sessionId: "session-1" },
        [sharedDirectory],
        directoryRequests,
        3,
      ) as Reads["sessionDirectoriesChunk"],
      runGet: async () =>
        runProjection({
          executionSnapshotState: "chunked",
          executionSnapshot: undefined,
        }),
      runSnapshotChunk: chunkReader(
        { sessionId: "session-1", runId: "run-source" },
        repositoryExecutionSnapshot(),
        snapshotRequests,
        7,
      ) as Reads["runSnapshotChunk"],
    }),
  });

  const response = await service.retry(retryRequest());

  assert.equal(response.overallStatus, "success");
  assert.ok(directoryRequests.length > 1);
  assert.ok(snapshotRequests.length > 1);
  assert.ok(
    [...directoryRequests, ...snapshotRequests].every(
      (request) => (request as Readonly<{ maxBytes: number }>).maxBytes <= 256 * 1024,
    ),
  );
  assert.equal(admitted.length, 1);
});

test("a malformed admission result cannot leak internal fields through the public projection", async () => {
  const service = createService({
    admission: admissionPort([], {}, { dispatchState: "sent", threadId: "private-thread" }),
  });
  const response = await service.start(startRequest());
  assert.equal(response.overallStatus, "failure");
  assert.equal(JSON.stringify(response).includes("private-thread"), false);
});

test("provider capacity failure preserves the public limit without exposing Provider identity", async () => {
  const service = createService({
    admission: {
      async admit() {
        return {
          ok: false,
          error: {
            code: "capacity_exceeded",
            message: "Provider capacity was reached.",
            retryable: true,
            details: {
              scope: "provider",
              providerId: "provider-private",
              current: 4,
              limit: 4,
            },
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.start(startRequest());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus !== "failure") assert.fail("expected capacity failure");
  assert.deepEqual(response.error, {
    kind: "domain",
    code: "capacity_exceeded",
    message: "Provider capacity was reached.",
    retryable: true,
    details: { scope: "provider", current: 4, limit: 4 },
  });
  assert.equal(JSON.stringify(response).includes("provider-private"), false);
});

test("Run admission rejects a supplemental-input capacity scope", async () => {
  const service = createService({
    admission: {
      async admit() {
        return {
          ok: false,
          error: {
            code: "capacity_exceeded",
            message: "Unexpected Run input capacity.",
            retryable: true,
            details: {
              scope: "run",
              runId: "run-private",
              current: 64,
              limit: 64,
            },
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.start(startRequest());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus !== "failure") assert.fail("expected a projection failure");
  assert.equal(response.error.kind, "application");
  assert.equal(JSON.stringify(response).includes("run-private"), false);
});

function createService(
  overrides: Partial<ApplicationRunServiceOptions<Authorization>> = {},
): ApplicationRunService<Authorization> {
  return new ApplicationRunService({
    reads: overrides.reads ?? reads(),
    admission: overrides.admission ?? admissionPort([]),
    handoff: overrides.handoff ?? { handoff() {} },
    access:
      overrides.access ??
      ({
        async authorize() {
          return { allowed: true };
        },
      } as const),
    snapshotAuthorization(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Object.getOwnPropertyDescriptor(value, "principal")?.value !== "owner"
      ) {
        throw new TypeError("invalid authorization");
      }
      return authorization;
    },
  });
}

function startRequest(): ApplicationRunStartRequest<Authorization> {
  return {
    context: { authorization },
    sessionId: "session-1",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "hello" }],
    execution,
  };
}

function retryRequest() {
  return {
    context: { authorization },
    sessionId: "session-1",
    retryOfRunId: "run-source",
    idempotencyKey,
  } as const;
}

function admissionPort(
  commands: ApplicationRunAdmissionCommand[],
  relation: Readonly<{ retryOfRunId?: string }> = {},
  recordOverrides: Readonly<Record<string, unknown>> = {},
): ApplicationRunAdmissionPort {
  return {
    async admit(command) {
      commands.push(command);
      return admissionSuccess(relation, recordOverrides);
    },
  };
}

function admissionSuccess(
  relation: Readonly<{ retryOfRunId?: string }> = {},
  recordOverrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    ok: true,
    replayed: false,
    value: {
      sessionId: "session-1",
      messageId: "message-source",
      runId: "run-new",
      ...relation,
      attemptId: "attempt-new",
      bindingId: "binding-new",
      runPhase: "queued" as const,
      bindingState: "creating" as const,
      dispatchState: "pending" as const,
      admittedAt: 10,
      ...recordOverrides,
    },
  } as const;
}

function reads(overrides: Partial<Reads> = {}): Reads {
  return {
    sessionGet: overrides.sessionGet ?? (async () => sessionProjection()),
    sessionDirectoriesChunk:
      overrides.sessionDirectoriesChunk ??
      (chunkReader({ sessionId: "session-1" }, [sharedDirectory]) as Reads["sessionDirectoriesChunk"]),
    runGet: overrides.runGet ?? (async () => runProjection()),
    runSnapshotChunk:
      overrides.runSnapshotChunk ??
      (chunkReader(
        { sessionId: "session-1", runId: "run-source" },
        repositoryExecutionSnapshot(),
      ) as Reads["runSnapshotChunk"]),
    messageContentChunk:
      overrides.messageContentChunk ??
      (chunkReader({ sessionId: "session-1", messageId: "message-source" }, [
        { type: "text", text: "source body" },
      ]) as Reads["messageContentChunk"]),
    runEventsPage:
      overrides.runEventsPage ??
      (async () => ({
        sessionId: "session-1",
        runId: "run-new",
        workspaceKey: defaultWorkspace.workspaceKey,
        items: [],
        continuationCursor: "cursor",
        hasMore: false,
      })),
  };
}

function readsWithSessionCounter(onRead: () => void): Reads {
  return reads({
    sessionGet: async () => {
      onRead();
      return sessionProjection();
    },
  });
}

function sessionProjection(
  overrides: Readonly<{
    lifecycleStatus?: "active" | "archived" | "closed";
    activeRunId?: string;
    directoriesState?: "inline" | "chunked";
    allowedAdditionalDirectories?: readonly string[];
    workspaceKey?: string;
    workspacePath?: string;
  }> = {},
) {
  const directoriesState = overrides.directoriesState ?? "inline";
  const allowedAdditionalDirectories = overrides.allowedAdditionalDirectories ?? [sharedDirectory];
  const workspacePath = overrides.workspacePath ?? defaultWorkspace.workspacePath;
  const workspace = resolveWorkspaceIdentity(workspacePath)!;
  return {
    session: {
      id: "session-1",
      title: "Session",
      providerId: "codex",
      workspaceKey: overrides.workspaceKey ?? workspace.workspaceKey,
      workspacePath,
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: jsonByteLength(allowedAdditionalDirectories),
      allowedAdditionalDirectoriesState: directoriesState,
      ...(directoriesState === "inline" ? { allowedAdditionalDirectories } : {}),
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 1,
      lifecycleStatus: overrides.lifecycleStatus ?? "active",
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    },
    execution: {
      state: overrides.activeRunId === undefined ? ("not_started" as const) : ("running" as const),
      ...(overrides.activeRunId === undefined ? {} : { activeRunId: overrides.activeRunId }),
    },
  };
}

function runProjection(
  overrides: Readonly<{
    phase?: string;
    workspaceKey?: string;
    executionSnapshotState?: "inline" | "chunked";
    executionSnapshot?: unknown;
  }> = {},
) {
  const snapshotState = overrides.executionSnapshotState ?? "inline";
  const executionSnapshot = overrides.executionSnapshot ?? repositoryExecutionSnapshot();
  return {
    sessionId: "session-1",
    workspaceKey: overrides.workspaceKey ?? defaultWorkspace.workspaceKey,
    run: {
      id: "run-source",
      sessionId: "session-1",
      ordinal: 1,
      initiatingMessageId: "message-source",
      phase: overrides.phase ?? "failed",
      executionSnapshotByteLength: jsonByteLength(executionSnapshot),
      executionSnapshotState: snapshotState,
      ...(snapshotState === "inline" ? { executionSnapshot } : {}),
      externalSideEffectState: "present",
      createdAt: 1,
      startedAt: 2,
      terminalAt: 3,
      updatedAt: 3,
      version: 4,
    },
  };
}

function repositoryExecutionSnapshot(
  workspacePath = defaultWorkspace.workspacePath,
  workspaceKey = defaultWorkspace.workspaceKey,
) {
  return {
    providerId: "codex",
    model: "gpt-source",
    modelSelection: "explicit" as const,
    reasoning: { effort: "medium" },
    approval: { policy: "never" },
    sandbox: { mode: "read-only", networkAccess: false },
    workspace: {
      key: workspaceKey,
      path: workspacePath,
      allowedAdditionalDirectories: [sharedDirectory],
    },
    character: null,
  };
}

function chunkReader<TScope extends Readonly<Record<string, string>>>(
  scope: TScope,
  value: unknown,
  requests: unknown[] = [],
  forcedChunkBytes?: number,
) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return async (request: Readonly<{ offset: number; maxBytes: number }>) => {
    requests.push(request);
    const size = Math.min(request.maxBytes, forcedChunkBytes ?? request.maxBytes, encoded.byteLength - request.offset);
    const bytes = encoded.slice(request.offset, request.offset + size);
    return {
      ...scope,
      offset: request.offset,
      totalBytes: encoded.byteLength,
      eof: request.offset + bytes.byteLength === encoded.byteLength,
      bytes: bytes.buffer,
    } as TScope &
      Readonly<{
        offset: number;
        totalBytes: number;
        eof: boolean;
        bytes: ArrayBuffer;
      }>;
  };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function nearMaximumAdditionalDirectories(): readonly string[] {
  const targetLength = ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength - 32;
  const directories = Array.from({ length: 128 }, (_value, index) => {
    const prefix = path.join(path.parse(process.cwd()).root, `scope-${index.toString().padStart(3, "0")}-`);
    return `${prefix}${"x".repeat(targetLength - prefix.length)}`;
  });
  let remaining = ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes - jsonByteLength(directories);
  for (let index = 0; index < directories.length && remaining > 0; index += 1) {
    const capacity = ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength - (directories[index] as string).length;
    const appended = Math.min(capacity, remaining);
    directories[index] = `${directories[index]}${"x".repeat(appended)}`;
    remaining -= appended;
  }
  assert.equal(jsonByteLength(directories), ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes);
  return Object.freeze(directories);
}

async function settlesWithin<TValue>(value: Promise<TValue>): Promise<TValue> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Operation did not settle.")), 250);
    }),
  ]);
}

function requestFailure() {
  return {
    overallStatus: "failure",
    error: {
      kind: "request",
      code: "request_invalid",
      message: "Application operation request is invalid.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  } as const;
}
