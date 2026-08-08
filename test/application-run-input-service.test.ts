import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunInputService,
  RepositoryApplicationRunInputAdmissionPort,
  RepositoryApplicationRunInputReplayPort,
  type ApplicationRunInputAdmissionPort,
  type ApplicationRunInputOwnerPort,
  type ApplicationRunInputOwnerReservation,
} from "../src/main/application-run-input-service.js";
import type { RepositoryWriteClient } from "../src/main/repository-write-client.js";
import type { RepositoryReadClient } from "../src/main/repository-read-client.js";
import type { RunInputAdmissionResult } from "../src/shared/repository-write-model.js";

type Authorization = Readonly<{ principal: "owner" }>;

const authorization: Authorization = { principal: "owner" };
const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000801";

test("send-input authorizes, preflights, durably admits, and allowlists a pending result", async () => {
  const calls: string[] = [];
  const commands: unknown[] = [];
  const handoffs: unknown[] = [];
  const releases: unknown[] = [];
  const service = createService({
    access: {
      async authorize(input) {
        calls.push("authorize");
        assert.deepEqual(input, {
          operation: "send-input",
          access: "write",
          context: { authorization },
          target: { kind: "run_input", sessionId: "session-1", runId: "run-1" },
        });
        return { allowed: true };
      },
    },
    owner: owner({
      calls,
      handoff: (record) => handoffs.push(record),
      release: (record) => releases.push(record),
    }),
    admission: {
      async admit(command) {
        calls.push("admit");
        commands.push(command);
        return success();
      },
    },
  });

  const response = await service.sendInput(request());

  assert.deepEqual(calls, ["authorize", "preflight", "admit", "handoff"]);
  assert.deepEqual(commands, [
    {
      sessionId: "session-1",
      workspaceKey: "workspace-1",
      idempotencyKey,
      runId: "run-1",
      attemptId: "attempt-1",
      ephemeralOwnerToken: null,
      contentBlocks: [{ type: "text", text: "continue" }],
    },
  ]);
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus !== "success") return;
  assert.deepEqual(response.value, {
    sessionId: "session-1",
    runId: "run-1",
    messageId: "message-input-1",
    deliveryState: "pending",
  });
  assert.deepEqual(response.persistence, { status: "committed", effect: "none", replayed: false });
  assert.equal(handoffs.length, 1);
  assert.equal(releases.length, 0);
  const publicJson = JSON.stringify(response);
  for (const privateValue of [
    "attempt-1",
    "binding-1",
    "generation-1",
    "conversation-1",
    "execution-1",
    "workspace-1",
    "provider-1",
  ]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("invalid input and authorization denial never reach live owner or Repository", async () => {
  const calls: string[] = [];
  const service = createService({
    access: {
      async authorize() {
        calls.push("authorize");
        return {
          allowed: false,
          error: { code: "forbidden", message: "denied", retryable: false },
        };
      },
    },
    owner: owner({ calls }),
    admission: admission(calls),
  });

  const invalid = await service.sendInput({ ...request(), attemptId: "caller-attempt" } as never);
  assert.equal(invalid.overallStatus, "failure");
  if (invalid.overallStatus === "failure") assert.equal(invalid.error.kind, "request");
  assert.deepEqual(calls, []);

  const denied = await service.sendInput(request());
  assert.equal(denied.overallStatus, "failure");
  if (denied.overallStatus === "failure") assert.equal(denied.error.kind, "access");
  assert.deepEqual(calls, ["authorize"]);
});

test("live owner and capacity failures happen before durable admission", async () => {
  for (const preflight of [
    {
      ok: false,
      error: {
        code: "lifecycle_conflict",
        message: "active owner unavailable",
        retryable: true,
      },
    },
    {
      ok: false,
      error: {
        code: "capacity_exceeded",
        message: "Run input queue is full.",
        retryable: true,
        details: { scope: "run", runId: "run-1", current: 64, limit: 64 },
      },
    },
  ] as const) {
    let admissions = 0;
    const service = createService({
      owner: {
        async preflight() {
          return preflight;
        },
        handoff() {
          assert.fail("handoff must not run");
        },
        release() {
          assert.fail("release must not run without a reservation");
        },
      },
      admission: {
        async admit() {
          admissions += 1;
          return success();
        },
      },
    });
    const response = await service.sendInput(request());
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") {
      assert.equal(response.error.kind, "domain");
      assert.equal(response.error.code, preflight.error.code);
      assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
    }
    assert.equal(admissions, 0);
  }
});

test("durable Run input capacity rejection preserves its public scope and releases the reservation", async () => {
  let releases = 0;
  const service = createService({
    owner: owner({
      release: () => {
        releases += 1;
      },
    }),
    admission: {
      async admit() {
        return {
          ok: false,
          error: {
            code: "capacity_exceeded",
            message: "Run input capacity is exhausted.",
            retryable: true,
            details: { scope: "run", runId: "run-1", current: 64, limit: 64 },
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.sendInput(request());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.deepEqual(response.error, {
      kind: "domain",
      code: "capacity_exceeded",
      message: "Run input capacity is exhausted.",
      retryable: true,
      details: { scope: "run", runId: "run-1", current: 64, limit: 64 },
    });
    assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });
  }
  assert.equal(releases, 1);
});

test("durable Run input capacity rejects a foreign Run scope instead of projecting its identity", async () => {
  let releases = 0;
  const service = createService({
    owner: owner({
      release: () => {
        releases += 1;
      },
    }),
    admission: {
      async admit() {
        return {
          ok: false,
          error: {
            code: "capacity_exceeded",
            message: "Run input capacity is exhausted.",
            retryable: true,
            details: { scope: "run", runId: "run-private", current: 64, limit: 64 },
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.sendInput(request());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus !== "failure") assert.fail("expected a projection failure");
  assert.equal(response.error.kind, "application");
  assert.equal(JSON.stringify(response).includes("run-private"), false);
  assert.deepEqual(response.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
  assert.equal(releases, 1);
});

test("a terminal race after an absent probe returns the newly durable exact replay", async () => {
  let probes = 0;
  const terminal = result({
    deliveryState: "aborted",
    resolutionCode: "run_terminal_not_sent",
    resolvedAt: 30,
  });
  const service = createService({
    replay: {
      async probe() {
        probes += 1;
        return probes === 1 ? { kind: "absent" } : { kind: "replay", value: terminal };
      },
    },
    owner: {
      async preflight() {
        return {
          ok: false,
          error: { code: "lifecycle_conflict", message: "Run became terminal.", retryable: true },
        };
      },
      handoff() {
        assert.fail("terminal replay must not hand off");
      },
      release() {
        assert.fail("terminal replay has no reservation");
      },
    },
  });

  const response = await service.sendInput(request());

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.deliveryState, "aborted");
    assert.equal(response.value.resolutionCode, "run_terminal_not_sent");
  }
  assert.equal(probes, 2);
});

test("terminal and dispatching replays return current public state without a second handoff", async () => {
  for (const record of [
    result({
      deliveryState: "dispatching",
      resolutionCode: null,
      dispatchingAt: 20,
      resolvedAt: null,
    }),
    result({
      deliveryState: "accepted",
      resolutionCode: null,
      dispatchingAt: 20,
      resolvedAt: 30,
    }),
    result({
      deliveryState: "rejected",
      resolutionCode: "delivery_not_sent",
      dispatchingAt: 20,
      resolvedAt: 30,
    }),
    result({
      deliveryState: "ambiguous",
      resolutionCode: "process_unknown",
      dispatchingAt: 20,
      resolvedAt: 30,
    }),
    result({
      deliveryState: "aborted",
      resolutionCode: "run_terminal_not_sent",
      dispatchingAt: null,
      resolvedAt: 30,
    }),
  ] as const) {
    let handoffs = 0;
    let releases = 0;
    let admissions = 0;
    const service = createService({
      replay: {
        async probe() {
          return { kind: "replay", value: record };
        },
      },
      owner: {
        async preflight() {
          assert.fail("a durable non-pending replay must not require a live owner");
        },
        handoff() {
          handoffs += 1;
        },
        release() {
          releases += 1;
        },
      },
      admission: {
        async admit() {
          admissions += 1;
          return { ok: true, value: record, replayed: true };
        },
      },
    });
    const response = await service.sendInput(request());
    assert.equal(response.overallStatus, "success", JSON.stringify(response));
    if (response.overallStatus === "success") {
      assert.equal(
        response.value.deliveryState,
        record.deliveryState === "dispatching" ? "pending" : record.deliveryState,
      );
      assert.equal(Object.hasOwn(response.value, "resolutionCode"), record.resolutionCode !== null);
    }
    assert.equal(handoffs, 0);
    assert.equal(releases, 0);
    assert.equal(admissions, 0);
  }
});

test("an exact pending replay hands off the same durable Message and Delivery", async () => {
  const handoffs: unknown[] = [];
  let releases = 0;
  const service = createService({
    replay: {
      async probe() {
        return { kind: "replay", value: result() };
      },
    },
    owner: owner({
      handoff: (record) => handoffs.push(record),
      release: () => {
        releases += 1;
      },
    }),
    admission: {
      async admit() {
        return { ok: true, value: result(), replayed: true };
      },
    },
  });

  const response = await service.sendInput(request());

  assert.equal(response.overallStatus, "success");
  assert.equal(handoffs.length, 1);
  assert.equal(releases, 0);
  const handoff = handoffs[0] as Readonly<Record<string, unknown>>;
  assert.deepEqual(
    { ...handoff, reservation: undefined },
    {
      reservation: undefined,
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      messageId: "message-input-1",
      messageOrdinal: 2,
      bindingId: "binding-1",
      admittedAt: 10,
      contentBlocks: [{ type: "text", text: "continue" }],
    },
  );
  assert.deepEqual(
    { ...(handoff.reservation as ApplicationRunInputOwnerReservation), token: undefined },
    { ...reservation(), token: undefined },
  );
});

test("Repository rejection releases the reservation and handoff failure leaves a durable recovery candidate", async () => {
  let releases = 0;
  const rejected = createService({
    owner: owner({
      release: () => {
        releases += 1;
      },
    }),
    admission: {
      async admit() {
        return {
          ok: false,
          error: { code: "lifecycle_conflict", message: "stale owner", retryable: false },
          replayed: false,
        };
      },
    },
  });
  const rejectedResponse = await rejected.sendInput(request());
  assert.equal(rejectedResponse.overallStatus, "failure");
  assert.equal(releases, 1);

  const durable = createService({
    owner: owner({
      handoff: () => {
        throw new Error("injected");
      },
      release: () => {
        releases += 1;
      },
    }),
  });
  const durableResponse = await durable.sendInput(request());
  assert.equal(durableResponse.overallStatus, "success");
  assert.equal(releases, 2);
});

test("client timeout after admission starts reports unknown effect while server-side handoff continues", async () => {
  let resolveAdmission!: (value: ReturnType<typeof success>) => void;
  let admissions = 0;
  let handoffs = 0;
  const service = createService({
    owner: owner({
      handoff: () => {
        handoffs += 1;
      },
    }),
    admission: {
      admit() {
        admissions += 1;
        return new Promise((resolve) => {
          resolveAdmission = resolve;
        });
      },
    },
  });
  const pending = service.sendInput(request(), { timeoutMs: 10 });
  await waitFor(() => admissions === 1);
  const response = await pending;
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.kind, "persistence");
    assert.equal(response.error.effect, "unknown");
    assert.deepEqual(response.persistence, {
      status: "failed",
      effect: "unknown",
      reconciliation: "exact_request_required",
    });
  }
  resolveAdmission(success());
  await waitFor(() => handoffs === 1);
});

test("Repository adapter forwards only internal preflight scope plus caller intent", async () => {
  const commands: unknown[] = [];
  const writes = {
    async admitRunInput(command: unknown) {
      commands.push(command);
      return success();
    },
  } as unknown as RepositoryWriteClient;
  const port = new RepositoryApplicationRunInputAdmissionPort(writes);
  const command = {
    sessionId: "session-1",
    workspaceKey: "workspace-1",
    idempotencyKey,
    runId: "run-1",
    attemptId: "attempt-1",
    ephemeralOwnerToken: null,
    contentBlocks: [{ type: "text", text: "continue" }],
  } as const;

  await port.admit(command);

  assert.deepEqual(commands, [command]);
});

test("Repository replay adapter forwards only caller-owned idempotency scope", async () => {
  const commands: unknown[] = [];
  const reads = {
    async runInputReplayProbe(command: unknown) {
      commands.push(command);
      return { kind: "absent" };
    },
  } as unknown as RepositoryReadClient;
  const port = new RepositoryApplicationRunInputReplayPort(reads);
  const command = {
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "continue" }],
  } as const;

  await port.probe(command);

  assert.deepEqual(commands, [command]);
});

function createService(
  options: Partial<ConstructorParameters<typeof ApplicationRunInputService<Authorization>>[0]> = {},
) {
  return new ApplicationRunInputService<Authorization>({
    access: options.access ?? {
      async authorize() {
        return { allowed: true };
      },
    },
    snapshotAuthorization:
      options.snapshotAuthorization ??
      ((value) => {
        assert.deepEqual(value, authorization);
        return { ...authorization };
      }),
    owner: options.owner ?? owner(),
    admission: options.admission ?? {
      async admit() {
        return success();
      },
    },
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  });
}

function request() {
  return {
    context: { authorization },
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
    contentBlocks: [{ type: "text" as const, text: "continue" }],
  };
}

function reservation(): ApplicationRunInputOwnerReservation {
  return {
    token: {},
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    providerId: "provider-1",
    attemptId: "attempt-1",
    bindingId: "binding-1",
    persistenceMode: "persistent",
    ephemeralOwnerToken: null,
    generationId: "generation-1",
    conversationId: "conversation-1",
    executionId: "execution-1",
  };
}

function owner(
  options: {
    calls?: string[];
    handoff?: ApplicationRunInputOwnerPort["handoff"];
    release?: ApplicationRunInputOwnerPort["release"];
  } = {},
): ApplicationRunInputOwnerPort {
  return {
    async preflight() {
      options.calls?.push("preflight");
      return { ok: true, value: reservation() };
    },
    handoff(record) {
      options.calls?.push("handoff");
      options.handoff?.(record);
    },
    release(record) {
      options.calls?.push("release");
      options.release?.(record);
    },
  };
}

function admission(calls: string[] = []): ApplicationRunInputAdmissionPort {
  return {
    async admit() {
      calls.push("admit");
      return success();
    },
  };
}

function success(overrides: Partial<RunInputAdmissionResult> = {}) {
  return { ok: true, value: result(overrides), replayed: false } as const;
}

function result(overrides: Partial<RunInputAdmissionResult> = {}): RunInputAdmissionResult {
  return {
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    messageId: "message-input-1",
    messageOrdinal: 2,
    bindingId: "binding-1",
    deliveryState: "pending",
    resolutionCode: null,
    admittedAt: 10,
    dispatchingAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
