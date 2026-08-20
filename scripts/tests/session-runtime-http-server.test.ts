import assert from "node:assert/strict";
import { request as httpRequest, type ClientRequest } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import { test } from "node:test";

import {
  SESSION_RUNTIME_OPERATIONS,
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../../src/session-runtime-exchange.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import {
  SESSION_RUNTIME_AGENT_OPERATION,
  createSessionRuntimeHttpServer,
} from "../../src-electron/session-runtime-http-server.js";

const secrets = {
  apiSecret: "api-secret",
  cliSecret: "cli-secret",
  mcpSecret: "mcp-secret",
  runtimeInstanceId: "runtime-1",
};

const defaultBindingRegistry = new AgentRuntimeBindingRegistry();
const defaultBinding = defaultBindingRegistry.issueOrReuse({
  actorSessionId: "session-actor",
  providerId: "codex",
  operationGrants: [SESSION_RUNTIME_AGENT_OPERATION],
});
const boundServerOptions = {
  ...secrets,
  agentRuntimeBindingRegistry: defaultBindingRegistry,
};

const turnInput = {
  provider: "codex",
  userMessage: "hello",
  model: "gpt-5.4",
  reasoningEffort: "high",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  attachments: [],
} as const;

const applicationOperationInputs: Record<(typeof SESSION_RUNTIME_OPERATIONS)[number], unknown> = {
  "runtime.catalog": {},
  "session.self": {},
  "session.create": {
    title: "Session", provider: "codex", catalogRevision: 4,
    workspace: { kind: "session_folder" }, idempotencyKey: "create-key",
  },
  "session.list": {},
  "session.get": { sessionId: "session-1" },
  "session.rename": { sessionId: "session-1", title: "Renamed", idempotencyKey: "rename-key" },
  "session.files.list": { sessionId: "session-1" },
  "session.files.read_text": { sessionId: "session-1", relativePath: "brief.md" },
  "session.files.write_text": {
    sessionId: "session-1", relativePath: "brief.md", content: "brief", replace: false,
    idempotencyKey: "write-key",
  },
  "turn.options": { sessionId: "session-1" },
  "turn.run": {
    sessionId: "session-1", catalogRevision: 4, idempotencyKey: "run-key",
    responseMode: "deferred", terminalFailureNotification: { targetSessionId: "target-session" }, turn: turnInput,
  },
  "turn.enqueue": {
    sessionId: "session-1", catalogRevision: 4, idempotencyKey: "enqueue-key",
    terminalFailureNotification: { targetSessionId: "target-session" }, turn: turnInput,
  },
  "turn.list": { sessionId: "session-1" },
  "turn.get": { sessionId: "session-1", executionId: "execution-1" },
  "turn.cancel": { sessionId: "session-1", executionId: "execution-1", idempotencyKey: "cancel-key" },
  "interaction.list": { sessionId: "session-1" },
  "interaction.respond": {
    sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
    response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-key",
    responseMode: "deferred",
  },
  "transcript.export": {
    sessionId: "session-1", format: "json", maxBytes: 1024, destination: { kind: "inline" },
  },
};

test("ID-01: 全application operationはvalid bindingのtrusted actor contextだけをhandlerへ渡す", async () => {
  const calls: Array<{ operation: string; actorSessionId: string | null }> = [];
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation, _input, _adapter, context) => {
      calls.push({
        operation,
        actorSessionId: context.agentRuntimeBinding?.actorSessionId ?? null,
      });
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    for (const operation of SESSION_RUNTIME_OPERATIONS) {
      const body = JSON.stringify({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation,
        input: applicationOperationInputs[operation],
      });
      assert.equal((await post(address.port, exchangePayload("mcp", body))).status, 200, operation);
    }
    assert.deepEqual(calls, SESSION_RUNTIME_OPERATIONS.map((operation) => ({
      operation,
      actorSessionId: "session-actor",
    })));
  } finally {
    await server.stop();
  }
});

test("ID-01: binding missingは全application operationをhandler前に拒否する", async () => {
  let calls = 0;
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation) => {
      calls += 1;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    for (const operation of SESSION_RUNTIME_OPERATIONS) {
      const body = JSON.stringify({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation,
        input: applicationOperationInputs[operation],
      });
      const response = await post(address.port, exchangePayload("cli", body, {
        agentRuntimeBindingReference: null,
      }));
      assert.equal(response.status, 403, operation);
      assert.equal(JSON.parse(response.body).error.code, "SESSION_BINDING_REQUIRED", operation);
    }
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("Session runtime authenticates identity and adapter before invoking handler", async () => {
  const calls: string[] = [];
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation, _input, adapter) => {
      calls.push(`${adapter}:${operation}`);
      return createSessionRuntimeResult(operation, { ok: true });
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const unauthorized = await post(address.port, exchangePayload("cli", body, { apiSecret: "wrong" }));
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(calls, []);

    const authorized = await post(address.port, exchangePayload("cli", body));
    assert.equal(authorized.status, 200);
    assert.deepEqual(calls, ["cli:turn.get"]);

    const wrongAdapter = await post(address.port, exchangePayload("mcp", body, { adapterSecret: secrets.cliSecret }));
    assert.equal(wrongAdapter.status, 401);
    assert.deepEqual(calls, ["cli:turn.get"]);
  } finally {
    await server.stop();
  }
});

test("SESSION-SELF-01: session.selfは有効なruntime bindingからactor Sessionだけを解決する", async () => {
  const registry = new AgentRuntimeBindingRegistry();
  const allowed = registry.issueOrReuse({
    actorSessionId: "session-actor",
    providerId: "codex",
    operationGrants: [SESSION_RUNTIME_AGENT_OPERATION],
  });
  const forbidden = registry.issueOrReuse({
    actorSessionId: "session-forbidden",
    providerId: "codex",
    operationGrants: [],
  });
  const expired = registry.issueOrReuse({
    actorSessionId: "session-expired",
    providerId: "codex",
    operationGrants: [SESSION_RUNTIME_AGENT_OPERATION],
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const calls: string[] = [];
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    agentRuntimeBindingRegistry: registry,
    handle: async (operation, _input, _adapter, context) => {
      calls.push(context.agentRuntimeBinding?.actorSessionId ?? "missing");
      return createSessionRuntimeResult(operation, {
        sessionId: context.agentRuntimeBinding?.actorSessionId,
      });
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.self",
      input: {},
    });

    const missing = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: null,
    }));
    const blank = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: " ",
    }));
    const invalid = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: "unknown",
    }));
    const grantMissing = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: forbidden.bindingReference,
    }));
    const bindingExpired = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: expired.bindingReference,
    }));
    assert.deepEqual(
      [missing, blank, invalid, grantMissing, bindingExpired].map((response) => response.status),
      [403, 403, 403, 403, 403],
    );
    assert.deepEqual(
      [missing, blank, invalid, grantMissing, bindingExpired].map((response) => JSON.parse(response.body).error.code),
      [
        "SESSION_BINDING_REQUIRED",
        "SESSION_BINDING_INVALID",
        "SESSION_BINDING_INVALID",
        "SESSION_BINDING_FORBIDDEN",
        "SESSION_BINDING_INVALID",
      ],
    );
    assert.deepEqual(calls, []);

    const authorized = await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: allowed.bindingReference,
    }));
    assert.equal(authorized.status, 200);
    assert.equal(JSON.parse(authorized.body).result.sessionId, "session-actor");
    assert.deepEqual(calls, ["session-actor"]);

    registry.revokeSession("session-actor");
    assert.equal((await post(address.port, exchangePayload("mcp", body, {
      agentRuntimeBindingReference: allowed.bindingReference,
    }))).status, 403);
    assert.deepEqual(calls, ["session-actor"]);
  } finally {
    await server.stop();
  }
});

test("Session runtime rejects a declared body over 8 MiB before handler invocation", async () => {
  let invoked = false;
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation) => {
      invoked = true;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await post(address.port, exchangePayload("cli", "{}"), {
      "Content-Length": String(SESSION_RUNTIME_MAX_BODY_BYTES + 1),
    }, false);
    assert.equal(response.status, 413);
    assert.equal(invoked, false);
  } finally {
    await server.stop();
  }
});

test("Session runtime status proves the discovered runtime identity", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/status?nonce=status-nonce`);
    assert.equal(response.status, 200);
    const result = await response.json() as { runtimeInstanceId: string; challenge: { hmacSha256: string } };
    assert.equal(result.runtimeInstanceId, secrets.runtimeInstanceId);
    assert.equal(
      result.challenge.hmacSha256,
      createSessionRuntimeChallenge(secrets.apiSecret, secrets.runtimeInstanceId, "status-nonce"),
    );
  } finally {
    await server.stop();
  }
});

test("RL-01: Session runtime replaces an oversized success response with a stable error", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: async (operation) => createSessionRuntimeResult(operation, {
      assistantText: "a".repeat(SESSION_RUNTIME_MAX_RESPONSE_BYTES),
    }),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const response = await post(address.port, exchangePayload("cli", body));
    assert.equal(response.status, 413);
    const error = JSON.parse(response.body).error;
    assert.equal(error.code, "CONTENT_TOO_LARGE");
    assert.equal(error.effect, "not_applied");
    assert.ok(Buffer.byteLength(response.body) <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
  } finally {
    await server.stop();
  }
});

test("APPLIED-ID-01: HTTP境界のfinal envelope超過でもmutationのeffectとresource IDを返す", async () => {
  const createResult = createBoundarySessionResult("session-created");
  const renameResult = createBoundarySessionResult("session-1");
  const executionBase = {
    id: "execution-1",
    sessionId: "session-1",
    operation: "turn.run" as const,
    state: "completed" as const,
    result: { assistantText: "" },
    errorCode: "",
    reason: "",
    createdAt: "2026-08-11T00:00:00.000Z",
    admittedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:00:01.000Z",
    updatedAt: "2026-08-11T00:00:01.000Z",
  };
  const execution = {
    ...executionBase,
    result: {
      assistantText: "a".repeat(
        SESSION_RUNTIME_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(executionBase), "utf8"),
      ),
    },
  };
  for (const [operation, result] of [
    ["session.create", createResult],
    ["session.rename", renameResult],
    ["turn.run", execution],
  ] as const) {
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
    assert.ok(
      Buffer.byteLength(JSON.stringify(createSessionRuntimeResult(operation, result)), "utf8")
        > SESSION_RUNTIME_MAX_RESPONSE_BYTES,
    );
  }
  const application = new SessionExternalApplicationService({
    resolveTurnInitiator: async (actorSessionId) => ({
      kind: "session",
      sessionId: actorSessionId,
      character: {
        characterId: "character-actor",
        name: "Actor",
        iconFilePath: "C:/characters/actor.png",
      },
    }),
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    executionService: {
      beginShutdown() {},
      async run() { return execution; },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { return createResult as never; },
      async list() { throw new Error("unused"); },
      async get() { throw new Error("unused"); },
      async rename() { return renameResult as never; },
    },
  });
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    handle: (operation, input, _adapter, context) =>
      application.execute(operation, input, context.agentRuntimeBinding),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const requests = [
      {
        operation: "session.create",
        input: {
          title: "New Session",
          provider: "codex",
          catalogRevision: 4,
          workspace: { kind: "session_folder" },
          idempotencyKey: "create-key",
        },
      },
      {
        operation: "session.rename",
        input: { sessionId: "session-1", title: "Renamed", idempotencyKey: "rename-key" },
      },
      {
        operation: "turn.run",
        input: {
          sessionId: "session-1",
          catalogRevision: 4,
          idempotencyKey: "run-key",
          responseMode: "deferred",
          turn: {
            provider: "codex",
            userMessage: "hello",
            model: "gpt-5.4",
            reasoningEffort: "high",
            approvalMode: "on-request",
            codexSandboxMode: "workspace-write",
            attachments: [],
          },
        },
      },
    ] as const;

    const responses = [];
    for (const request of requests) {
      const body = JSON.stringify({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        ...request,
      });
      responses.push(await post(address.port, exchangePayload("cli", body)));
    }

    const errors = responses.map((response) => JSON.parse(response.body).error);
    assert.deepEqual(responses.map((response) => response.status), [413, 413, 413]);
    assert.deepEqual(errors.map((error) => error.effect), ["applied", "applied", "applied"]);
    assert.equal(errors[0].details.sessionId, "session-created");
    assert.equal(errors[1].details.sessionId, "session-1");
    assert.equal(errors[2].details.sessionId, "session-1");
    assert.equal(errors[2].details.executionId, "execution-1");
    assert.ok(responses.every((response) => Buffer.byteLength(response.body) <= SESSION_RUNTIME_MAX_RESPONSE_BYTES));
  } finally {
    await server.stop();
  }
});

function createBoundarySessionResult(sessionId: string): { sessionId: string; padding: string } {
  const empty = { sessionId, padding: "" };
  return {
    ...empty,
    padding: "a".repeat(
      SESSION_RUNTIME_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(empty), "utf8"),
    ),
  };
}

test("HTTP-PREAUTH-01: unfinished pre-auth requestはdeadlineで破棄される", async () => {
  let invoked = false;
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    preAuthTimeoutMs: 30,
    handle: async (operation) => {
      invoked = true;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const request = await openPreAuthRequest(address.port);
    await waitForRequestClose(request, 500);
    assert.equal(invoked, false);
  } finally {
    await server.stop();
  }
});

test("HTTP-PREAUTH-01: stopはunfinished pre-auth socketを待たずに破棄する", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    preAuthTimeoutMs: 30_000,
    shutdownGraceMs: 50,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  const address = server.address();
  assert.ok(address);
  const request = await openPreAuthRequest(address.port);
  const startedAt = Date.now();
  await server.stop();
  assert.ok(Date.now() - startedAt < 250);
  await waitForRequestClose(request, 500);
});

test("HTTP-PREAUTH-01: aggregate pre-auth byte budget超過はhandler前にstable errorへ収束する", async () => {
  let invoked = false;
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    maxPreAuthAggregateBytes: 64,
    handle: async (operation) => {
      invoked = true;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const response = await post(address.port, exchangePayload("cli", body));
    assert.equal(response.status, 503);
    const error = JSON.parse(response.body).error;
    assert.equal(error.code, "RUNTIME_UNAVAILABLE");
    assert.equal(error.retryable, true);
    assert.equal(error.effect, "not_applied");
    assert.equal(invoked, false);
  } finally {
    await server.stop();
  }
});

test("HTTP-PREAUTH-01: 複数requestのaggregate byte budgetを共有し解放後に再受付する", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    maxPreAuthAggregateBytes: 1_024,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const first = await openPartialPreAuthRequest(address.port, 900);
    const second = await openPartialPreAuthRequest(address.port, 200);
    const rejected = await second.response;
    assert.equal(rejected.status, 503);
    assert.equal(JSON.parse(rejected.body).error.code, "RUNTIME_UNAVAILABLE");
    first.request.destroy();
    await waitForRequestClose(first.request, 500);

    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    assert.ok(Buffer.byteLength(exchangePayload("cli", body)) > 1_024 - 900);
    const accepted = await post(address.port, exchangePayload("cli", body));
    assert.equal(accepted.status, 200);
  } finally {
    await server.stop();
  }
});

test("HTTP-PREAUTH-01: live pre-auth connection数をhard limitする", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    maxPreAuthConnections: 1,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const heldRequest = await openPreAuthRequest(address.port);
    await assert.rejects(Promise.race([
      openPreAuthRequest(address.port),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("connection limit was not enforced")), 500)),
    ]));
    heldRequest.destroy();
  } finally {
    await server.stop();
  }
});

test("EXT-SHUTDOWN-07: stopはstuck authenticated handlerをfinite grace後に切り離す", async () => {
  const handlerStarted = createDeferred();
  const releaseHandler = createDeferred();
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    shutdownGraceMs: 20,
    handle: async (operation) => {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  const address = server.address();
  assert.ok(address);
  const body = JSON.stringify({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.get",
    input: { sessionId: "session-1", executionId: "execution-1" },
  });
  const response = post(address.port, exchangePayload("cli", body)).catch(() => undefined);
  await handlerStarted.promise;
  const firstStopping = server.stop();
  const secondStopping = server.stop();
  await Promise.race([
    Promise.all([firstStopping, secondStopping]),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("authenticated handler shutdown did not settle within the finite deadline")),
      500,
    )),
  ]);
  releaseHandler.resolve();
  await response;
});

test("HTTP-PREAUTH-01: stopはheader未完了socketをgrace内に破棄する", async () => {
  const server = createSessionRuntimeHttpServer({
    ...boundServerOptions,
    shutdownGraceMs: 30,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  const address = server.address();
  assert.ok(address);
  const socket = await openSlowHeaderSocket(address.port);
  const closed = waitForSocketClose(socket, 500);
  const startedAt = Date.now();
  await server.stop();
  await closed;
  assert.ok(Date.now() - startedAt < 250);
});

function exchangePayload(
  adapter: "cli" | "mcp",
  envelopeBody: string,
  overrides: {
    apiSecret?: string;
    adapterSecret?: string;
    agentRuntimeBindingReference?: string | null;
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: overrides.apiSecret ?? secrets.apiSecret,
    adapter,
    adapterSecret: overrides.adapterSecret ?? (adapter === "cli" ? secrets.cliSecret : secrets.mcpSecret),
    ...(overrides.agentRuntimeBindingReference === null
      ? {}
      : { agentRuntimeBindingReference: overrides.agentRuntimeBindingReference ?? defaultBinding.bindingReference }),
    envelope: JSON.parse(envelopeBody),
  });
}

function challengeHeaders(nonce: string): Record<string, string> {
  return {
    [SESSION_RUNTIME_INSTANCE_HEADER]: secrets.runtimeInstanceId,
    [SESSION_RUNTIME_NONCE_HEADER]: nonce,
  };
}

function post(
  port: number,
  payload: string,
  headers: Record<string, string> = {},
  writeBody = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...challengeHeaders("nonce-1"),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        request.destroy();
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", reject);
    request.once("information", (information) => {
      if (information.statusCode === 103) request.end(writeBody ? payload : undefined);
    });
    request.flushHeaders();
  });
}

function openPreAuthRequest(port: number): Promise<ClientRequest> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...challengeHeaders("held-nonce"),
      },
    });
    request.once("error", reject);
    request.once("information", (information) => {
      if (information.statusCode === 103) resolve(request);
    });
    request.flushHeaders();
  });
}

function openPartialPreAuthRequest(
  port: number,
  bytes: number,
): Promise<{ request: ClientRequest; response: Promise<{ status: number; body: string }> }> {
  return new Promise((resolve, reject) => {
    let resolveResponse = (_value: { status: number; body: string }) => undefined;
    const response = new Promise<{ status: number; body: string }>((nextResolve) => { resolveResponse = nextResolve; });
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...challengeHeaders(`partial-${bytes}`),
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => resolveResponse({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.once("information", (information) => {
      if (information.statusCode !== 103) return;
      request.write(Buffer.alloc(bytes, 0x20));
      resolve({ request, response });
    });
    request.flushHeaders();
  });
}

function openSlowHeaderSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port }, () => {
      socket.write(`POST ${SESSION_RUNTIME_OPERATION_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function waitForRequestClose(request: ClientRequest, timeoutMs: number): Promise<void> {
  if (request.destroyed) return;
  await Promise.race([
    new Promise<void>((resolve) => request.once("close", resolve)),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("request did not close")), timeoutMs)),
  ]);
}

async function waitForSocketClose(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) return;
  await Promise.race([
    new Promise<void>((resolve) => socket.once("close", resolve)),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("socket did not close")), timeoutMs)),
  ]);
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
