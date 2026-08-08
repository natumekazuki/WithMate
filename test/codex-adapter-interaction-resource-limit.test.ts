import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationRunInteractionCollectionWireBytes,
  applicationRunInteractionWireItemBytes,
} from "../src/shared/application-run-interaction-limits.js";
import {
  CODEX_ADAPTER_LIMITS,
  CodexAdapter,
  type CodexAdapterEvent,
  type CodexAdapterRequestOptions,
  type CodexAdapterServerRequestPort,
  type CodexAdapterTransportEvent,
  type CodexAdapterTransportPort,
} from "../src/main/providers/codex/index.js";
import { CodexTransportError } from "../src/main/providers/codex/transport-error.js";

const threadId = "thread-1";
const turnId = "turn-1";
const workspacePath = process.cwd();

test("pending-count overflow declines approvals but interrupts user input for its exact owner", async () => {
  const { adapter, transport } = await activeAdapter();
  try {
    for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxPendingInteractions; index += 1) {
      transport.emit(
        serverRequest(index, "item/commandExecution/requestApproval", commandParams(`command-${index}`)).event,
      );
      assert.equal((await adapter.nextEvent()).kind, "interaction_pending");
    }

    const overflowApproval = serverRequest(
      "overflow-approval",
      "item/commandExecution/requestApproval",
      commandParams("overflow-approval"),
    );
    transport.emit(overflowApproval.event);
    assert.equal(diagnosticCode(await adapter.nextEvent()), "resource_limit");
    await waitFor(() => overflowApproval.responses.length === 1);
    assert.deepEqual(overflowApproval.responses, [{ decision: "decline" }]);
    assert.equal(interruptRequests(transport).length, 0);

    const overflowInput = serverRequest(
      "overflow-input",
      "item/tool/requestUserInput",
      userInputParams("overflow-input"),
    );
    transport.emit(overflowInput.event);
    assert.equal(diagnosticCode(await adapter.nextEvent()), "resource_limit");
    await assertOneExactInterrupt(transport);
    assert.deepEqual(overflowInput.responses, []);

    await assertNoAdditionalPendingInteraction(adapter, transport);
  } finally {
    await adapter.close();
  }
});

test("projection-byte overflow interrupts user input for its exact owner without publishing it", async () => {
  const { adapter, transport } = await activeAdapter();
  try {
    const userBytes = userInputProjectionBytes();
    let usedBytes = 0;
    let itemIndex = 0;
    const maximumPaths = filePaths(itemIndex, CODEX_ADAPTER_LIMITS.maxInteractionFileChanges, 512);
    const maximumBytes = fileProjectionBytes(maximumPaths);

    while (
      applicationRunInteractionCollectionWireBytes(usedBytes + maximumBytes + userBytes, itemIndex + 2) <=
      CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes
    ) {
      usedBytes += await admitFileProjection(adapter, transport, itemIndex, maximumPaths, maximumBytes);
      itemIndex += 1;
    }

    if (
      applicationRunInteractionCollectionWireBytes(usedBytes + userBytes, itemIndex + 1) <=
      CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes
    ) {
      const minimumBytes =
        CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes -
        applicationRunInteractionCollectionWireBytes(usedBytes + userBytes, itemIndex + 2) +
        1;
      const maximumCandidateBytes =
        CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes -
        applicationRunInteractionCollectionWireBytes(usedBytes, itemIndex + 1);
      const candidate = findFileProjection(itemIndex, minimumBytes, maximumCandidateBytes);
      assert.ok(candidate, "expected a bounded file projection that reaches the aggregate threshold");
      usedBytes += await admitFileProjection(adapter, transport, itemIndex, candidate.paths, candidate.bytes);
      itemIndex += 1;
    }
    assert.ok(
      applicationRunInteractionCollectionWireBytes(usedBytes, itemIndex) <=
        CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes,
    );
    assert.ok(
      applicationRunInteractionCollectionWireBytes(usedBytes + userBytes, itemIndex + 1) >
        CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes,
    );

    const overflowInput = serverRequest(
      "projection-overflow-input",
      "item/tool/requestUserInput",
      userInputParams("projection-overflow-input"),
    );
    transport.emit(overflowInput.event);
    assert.equal(diagnosticCode(await adapter.nextEvent()), "resource_limit");
    await assertOneExactInterrupt(transport);
    assert.deepEqual(overflowInput.responses, []);

    await assertNoAdditionalPendingInteraction(adapter, transport);
  } finally {
    await adapter.close();
  }
});

test("a resource-limit decline write rejection fails the connection and releases pending interactions", async () => {
  const { adapter, transport } = await activeAdapter();
  try {
    let firstPending: Extract<CodexAdapterEvent, { kind: "interaction_pending" }> | undefined;
    for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxPendingInteractions; index += 1) {
      transport.emit(
        serverRequest(index, "item/commandExecution/requestApproval", commandParams(`command-${index}`)).event,
      );
      const event = await adapter.nextEvent();
      assert.equal(event.kind, "interaction_pending");
      if (event.kind === "interaction_pending") firstPending ??= event;
    }
    assert.ok(firstPending);

    const overflow = serverRequest(
      "decline-write-rejected",
      "item/commandExecution/requestApproval",
      commandParams("decline-write-rejected"),
      new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }),
    );
    transport.emit(overflow.event);
    assert.equal(diagnosticCode(await adapter.nextEvent()), "resource_limit");

    await waitFor(() => transport.closeCalls === 1);
    assert.deepEqual(await adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
    assert.deepEqual(
      adapter.reserveInteractionResponse(firstPending.handle, {
        interactionId: firstPending.snapshot.interactionId,
        kind: "codex.command_approval",
        payload: { decision: "decline" },
      }),
      { kind: "not_reserved", code: "write_rejected" },
    );
  } finally {
    await adapter.close();
  }
});

test("an unavailable interaction decline write rejection fails the connection and releases its handle", async () => {
  const { adapter, transport } = await activeAdapter();
  try {
    const unavailable = serverRequest(
      "unavailable-decline-write-rejected",
      "item/commandExecution/requestApproval",
      { ...commandParams("unavailable-decline-write-rejected"), commandActions: [] },
      new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }),
    );
    transport.emit(unavailable.event);
    const pending = await adapter.nextEvent();
    assert.equal(pending.kind, "interaction_pending");
    if (pending.kind !== "interaction_pending") assert.fail("expected unavailable interaction");
    assert.equal(pending.snapshot.answerable, false);

    await waitFor(() => transport.closeCalls === 1);
    assert.deepEqual(await adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
    assert.deepEqual(
      adapter.reserveInteractionResponse(pending.handle, {
        interactionId: pending.snapshot.interactionId,
        kind: "codex.command_approval",
        payload: { decision: "decline" },
      }),
      { kind: "not_reserved", code: "write_rejected" },
    );
  } finally {
    await adapter.close();
  }
});

test("a resource-limit user-input interrupt failure fails the connection and releases pending interactions", async () => {
  const failures: readonly Readonly<{ label: string; response: unknown }>[] = [
    {
      label: "not sent",
      response: new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }),
    },
    {
      label: "provider rejected",
      response: new CodexTransportError({ kind: "remote_error", code: -32600 }),
    },
    { label: "invalid response", response: null },
  ];

  for (const failure of failures) {
    const { adapter, transport } = await activeAdapter(failure.response);
    try {
      let firstPending: Extract<CodexAdapterEvent, { kind: "interaction_pending" }> | undefined;
      for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxPendingInteractions; index += 1) {
        transport.emit(
          serverRequest(index, "item/commandExecution/requestApproval", commandParams(`command-${index}`)).event,
        );
        const event = await adapter.nextEvent();
        assert.equal(event.kind, "interaction_pending", failure.label);
        if (event.kind === "interaction_pending") firstPending ??= event;
      }
      assert.ok(firstPending, failure.label);

      const overflowInput = serverRequest(
        `interrupt-${failure.label}`,
        "item/tool/requestUserInput",
        userInputParams(`interrupt-${failure.label}`),
      );
      transport.emit(overflowInput.event);
      assert.equal(diagnosticCode(await adapter.nextEvent()), "resource_limit", failure.label);

      await waitFor(() => transport.closeCalls === 1);
      assert.deepEqual(
        await adapter.nextEvent(),
        { kind: "connection_failure", code: "protocol_failed" },
        failure.label,
      );
      assert.deepEqual(
        adapter.reserveInteractionResponse(firstPending.handle, {
          interactionId: firstPending.snapshot.interactionId,
          kind: "codex.command_approval",
          payload: { decision: "decline" },
        }),
        { kind: "not_reserved", code: "write_rejected" },
        failure.label,
      );
    } finally {
      await adapter.close();
    }
  }
});

test("opaque request identity prevents raw ID reuse, unknown resolution, and late duplicate from resolving another interaction", async () => {
  const first = await activeAdapter();
  try {
    const request = serverRequest("shared-id", "item/commandExecution/requestApproval", commandParams("first"));
    first.transport.emit(request.event);
    const pending = await first.adapter.nextEvent();
    assert.equal(pending.kind, "interaction_pending");
    first.transport.emit({
      kind: "notification",
      method: "serverRequest/resolved",
      params: { threadId, requestId: "shared-id" },
    });
    assert.equal((await first.adapter.nextEvent()).kind, "interaction_resolved");
    first.transport.emit({
      kind: "notification",
      method: "serverRequest/resolved",
      params: { threadId, requestId: "shared-id" },
    });
    assert.equal(diagnosticCode(await first.adapter.nextEvent()), "protocol_anomaly");
    assert.deepEqual(await first.adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
  } finally {
    await first.adapter.close();
  }

  const unknown = await activeAdapter();
  try {
    unknown.transport.emit({
      kind: "notification",
      method: "serverRequest/resolved",
      params: { threadId, requestId: "unknown-id" },
    });
    assert.equal(diagnosticCode(await unknown.adapter.nextEvent()), "protocol_anomaly");
    assert.deepEqual(await unknown.adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
  } finally {
    await unknown.adapter.close();
  }

  const reused = await activeAdapter();
  try {
    reused.transport.emit(serverRequest(7, "item/commandExecution/requestApproval", commandParams("first")).event);
    assert.equal((await reused.adapter.nextEvent()).kind, "interaction_pending");
    reused.transport.emit(serverRequest(7, "item/commandExecution/requestApproval", commandParams("second")).event);
    assert.equal(diagnosticCode(await reused.adapter.nextEvent()), "protocol_anomaly");
    assert.deepEqual(await reused.adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
  } finally {
    await reused.adapter.close();
  }
});

test("direct waiter and queued admission release raw payload while preserving exactly-once lifecycle", async () => {
  const { adapter, transport } = await activeAdapter({});
  try {
    const request = serverRequest("payload-release-direct", "item/commandExecution/requestApproval", {
      ...commandParams("payload-release-direct-item"),
      futureAdditivePayload: { text: "x".repeat(64 * 1_024) },
    });
    const queued = serverRequest("payload-release-queued", "item/commandExecution/requestApproval", {
      ...commandParams("payload-release-queued-item"),
      futureAdditivePayload: { text: "y".repeat(64 * 1_024) },
    });
    transport.emit(request.event);
    transport.emit(queued.event);
    const event = await adapter.nextEvent();
    assert.equal(event.kind, "interaction_pending");
    if (event.kind !== "interaction_pending") assert.fail("expected interaction");
    const queuedEvent = await adapter.nextEvent();
    assert.equal(queuedEvent.kind, "interaction_pending");
    assert.equal(request.releaseCalls, 1);
    assert.equal(request.retainedParams, undefined);
    assert.equal(queued.releaseCalls, 1);
    assert.equal(queued.retainedParams, undefined);

    const reserved = adapter.reserveInteractionResponse(event.handle, {
      interactionId: event.snapshot.interactionId,
      kind: "codex.command_approval",
      payload: { decision: "accept" },
    });
    assert.equal(reserved.kind, "reserved");
    if (reserved.kind !== "reserved") assert.fail("expected reservation");
    assert.deepEqual(await adapter.writeReservedInteractionResponse(reserved.reservation), {
      kind: "write_attempted",
      effect: "unknown",
      providerResolution: "pending",
    });
    assert.deepEqual(await adapter.writeReservedInteractionResponse(reserved.reservation), {
      kind: "not_sent",
      effect: "none",
      code: "already_used",
    });
    assert.deepEqual(request.responses, [{ decision: "accept" }]);

    transport.emit({
      kind: "notification",
      method: "serverRequest/resolved",
      params: { threadId, requestId: "payload-release-direct" },
    });
    assert.equal((await adapter.nextEvent()).kind, "interaction_resolved");
    transport.emit({
      kind: "notification",
      method: "turn/completed",
      params: { threadId, turn: turnFixture({ status: "completed" }) },
    });
    assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
    assert.deepEqual(request.responses, [{ decision: "accept" }]);
  } finally {
    await adapter.close();
  }
});

async function activeAdapter(
  interactionResponse: unknown = {},
): Promise<Readonly<{ adapter: CodexAdapter; transport: ControlledTransport }>> {
  const transport = new ControlledTransport([
    threadOperationFixture({ approvalPolicy: "on-request" }),
    { turn: turnFixture() },
    interactionResponse,
  ]);
  const adapter = new CodexAdapter(transport, { cliVersion: "0.145.0" });
  assert.equal(
    (
      await adapter.startThread({
        model: "gpt-5.4",
        modelSelection: "explicit",
        workspacePath,
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        persistence: "persistent",
      })
    ).kind,
    "accepted",
  );
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  assert.equal(
    (
      await adapter.startTurn({
        threadId,
        contentBlocks: [{ type: "text", text: "exercise interaction limits" }],
        approvalPolicy: "on-request",
      })
    ).kind,
    "accepted",
  );
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  return Object.freeze({ adapter, transport });
}

async function admitFileProjection(
  adapter: CodexAdapter,
  transport: ControlledTransport,
  itemIndex: number,
  paths: readonly string[],
  expectedBytes: number,
): Promise<number> {
  const itemId = `file-item-${itemIndex}`;
  transport.emit({
    kind: "notification",
    method: "item/fileChange/patchUpdated",
    params: {
      threadId,
      turnId,
      itemId,
      changes: paths.map((path) => ({ path, kind: { type: "update" }, diff: "" })),
    },
  });
  transport.emit(
    serverRequest(`file-request-${itemIndex}`, "item/fileChange/requestApproval", {
      threadId,
      turnId,
      itemId,
    }).event,
  );
  const event = await adapter.nextEvent();
  assert.equal(event.kind, "interaction_pending");
  if (event.kind !== "interaction_pending") assert.fail("expected file interaction");
  assert.equal(event.snapshot.kind, "codex.file_change_approval");
  const actualBytes = applicationRunInteractionWireItemBytes(event.snapshot);
  assert.equal(actualBytes, expectedBytes);
  return actualBytes;
}

function findFileProjection(
  itemIndex: number,
  minimumBytes: number,
  maximumBytes: number,
): Readonly<{ paths: readonly string[]; bytes: number }> | undefined {
  for (let count = 1; count <= CODEX_ADAPTER_LIMITS.maxInteractionFileChanges; count += 1) {
    const minimumPaths = filePaths(itemIndex, count, 10);
    const baseBytes = fileProjectionBytes(minimumPaths);
    const pathLength = 10 + Math.max(0, Math.ceil((minimumBytes - baseBytes) / count));
    if (pathLength > 512) continue;
    const paths = filePaths(itemIndex, count, pathLength);
    const bytes = fileProjectionBytes(paths);
    if (bytes >= minimumBytes && bytes <= maximumBytes) return Object.freeze({ paths, bytes });
  }
  return undefined;
}

function filePaths(itemIndex: number, count: number, length: number): readonly string[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const prefix = `${itemIndex.toString(36).padStart(2, "0")}-${index.toString(36).padStart(3, "0")}-`;
      return `${prefix}${"x".repeat(length - prefix.length - 3)}.ts`;
    }),
  );
}

function fileProjectionBytes(paths: readonly string[]): number {
  return applicationRunInteractionWireItemBytes({
    interactionId: "0".repeat(36),
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    kind: "codex.file_change_approval",
    answerable: true,
    display: {
      summary: "Codex requests permission to apply file changes.",
      changes: paths.map((displayPath) => ({ displayPath, changeKind: "update" })),
    },
  });
}

function userInputProjectionBytes(): number {
  return applicationRunInteractionWireItemBytes({
    interactionId: "0".repeat(36),
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    kind: "codex.user_input",
    answerable: true,
    display: {
      questions: [
        {
          questionId: "choice",
          header: "Choice",
          prompt: "Choose a value",
          allowOther: false,
          options: [
            { label: "one", description: "First" },
            { label: "two", description: "Second" },
          ],
        },
      ],
    },
  });
}

function commandParams(itemId: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ threadId, turnId, itemId, startedAtMs: 1, command: "node --version", cwd: workspacePath });
}

function userInputParams(itemId: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    threadId,
    turnId,
    itemId,
    questions: Object.freeze([
      Object.freeze({
        id: "choice",
        header: "Choice",
        question: "Choose a value",
        isSecret: false,
        isOther: false,
        options: Object.freeze([
          Object.freeze({ label: "one", description: "First" }),
          Object.freeze({ label: "two", description: "Second" }),
        ]),
      }),
    ]),
  });
}

function serverRequest(id: string | number, method: string, params: unknown, failure?: Error) {
  const responses: unknown[] = [];
  const protocolParams =
    (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") &&
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params)
      ? Object.freeze({ startedAtMs: 1, ...params })
      : params;
  let releaseCalls = 0;
  const identity = Object.freeze(Object.create(null)) as CodexAdapterServerRequestPort["identity"];
  fakeRequestIds.set(identity, id);
  const request = {
    identity,
    method,
    params: protocolParams,
    respond: (result: unknown) => {
      if (failure !== undefined) return Promise.reject(failure);
      responses.push(result);
      return Promise.resolve();
    },
    releasePayload: () => {
      releaseCalls += 1;
      request.params = undefined;
    },
  };
  const event = Object.freeze({
    kind: "serverRequest" as const,
    request,
  });
  return Object.freeze({
    event,
    responses,
    get retainedParams() {
      return request.params;
    },
    get releaseCalls() {
      return releaseCalls;
    },
  });
}

const fakeRequestIds = new WeakMap<object, string | number>();

async function assertOneExactInterrupt(transport: ControlledTransport): Promise<void> {
  await waitFor(() => interruptRequests(transport).length === 1);
  assert.deepEqual(interruptRequests(transport), [{ method: "turn/interrupt", params: { threadId, turnId } }]);
}

function interruptRequests(transport: ControlledTransport): readonly Readonly<{ method: string; params: unknown }>[] {
  return transport.requestDetails.filter((request) => request.method === "turn/interrupt");
}

async function assertNoAdditionalPendingInteraction(
  adapter: CodexAdapter,
  transport: ControlledTransport,
): Promise<void> {
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId, turn: turnFixture({ status: "interrupted" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
}

function diagnosticCode(event: CodexAdapterEvent): string | undefined {
  return event.kind === "diagnostic" ? event.diagnostic.code : undefined;
}

class ControlledTransport implements CodexAdapterTransportPort {
  readonly requestDetails: Array<Readonly<{ method: string; params: unknown }>> = [];
  closeCalls = 0;
  readonly #responses: unknown[];
  readonly #events: CodexAdapterTransportEvent[] = [];
  readonly #resolutionIdentities = new Map<string, CodexAdapterServerRequestPort["identity"]>();
  readonly #resolved = new Set<string>();
  #waiter:
    | Readonly<{
        resolve: (event: CodexAdapterTransportEvent) => void;
        reject: (error: Error) => void;
      }>
    | undefined;

  constructor(responses: readonly unknown[]) {
    this.#responses = [...responses];
  }

  request<TResult>(method: string, params?: unknown, _options?: CodexAdapterRequestOptions): Promise<TResult> {
    this.requestDetails.push(Object.freeze({ method, params }));
    if (method === "model/list") return Promise.resolve({ data: [modelFixture()], nextCursor: null } as TResult);
    const response = this.#responses.shift();
    if (response === undefined) return Promise.reject(new Error("missing fake response"));
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response as TResult);
  }

  observeServerRequestResolution(requestId: unknown) {
    const key = `${typeof requestId}:${String(requestId)}`;
    const identity = this.#resolutionIdentities.get(key);
    if (identity === undefined) return Object.freeze({ kind: "invalid" } as const);
    if (this.#resolved.has(key)) return Object.freeze({ kind: "duplicate" } as const);
    this.#resolved.add(key);
    return Object.freeze({ kind: "current" as const, identity });
  }

  nextEvent(): Promise<CodexAdapterTransportEvent> {
    const event = this.#events.shift();
    if (event !== undefined) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  emit(event: CodexAdapterTransportEvent): void {
    let delivered = event;
    if (event.kind === "serverRequest") {
      const id = fakeRequestIds.get(event.request.identity);
      if (id !== undefined) {
        const key = `${typeof id}:${String(id)}`;
        if (this.#resolutionIdentities.has(key)) {
          delivered = Object.freeze({
            kind: "protocolAnomaly",
            code: "duplicate_or_late_response_id",
            responseIdType: typeof id as "number" | "string",
          });
        } else {
          this.#resolutionIdentities.set(key, event.request.identity);
        }
      }
    }
    const waiter = this.#waiter;
    if (waiter === undefined) this.#events.push(delivered);
    else {
      this.#waiter = undefined;
      waiter.resolve(delivered);
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(new Error("transport closed"));
    return Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function threadOperationFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    thread: threadFixture(),
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: workspacePath,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort: "medium",
    ...overrides,
  };
}

function threadFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: threadId,
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: workspacePath,
    cliVersion: "0.145.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function turnFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function modelFixture(): Record<string, unknown> {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "General model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: true,
  };
}
