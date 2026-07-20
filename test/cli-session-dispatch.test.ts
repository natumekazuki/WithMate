import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CLI_EXIT_CODES, CLI_SCHEMA_VERSION } from "../src/cli/contract.js";
import { runCliWithSessionOperations } from "../src/cli/invocation.js";
import type { ApplicationSessionMessageOperations, ApplicationSessionOperations } from "../src/main/index.js";

type Authorization = Readonly<{ principal: string }>;
type Operations = ApplicationSessionOperations<Authorization>;
type MessageOperations = ApplicationSessionMessageOperations<Authorization>;
type OperationName = keyof Operations;
type Call = Readonly<{ operation: OperationName; request: unknown; options: unknown }>;

const authorization: Authorization = { principal: "local-user" };
const uuid = "018f1f4e-7f0a-7000-8000-000000000001";
const workspacePath = path.resolve("workspace-1");
const additionalDirectory = path.resolve("workspace-shared");

test("all Session argv dispatch only public Application operation requests", async () => {
  const fake = recordingOperations(({ operation }) => successResponse(operation));
  const invocations = [
    [
      "session",
      "create",
      "--title",
      "Session title",
      "--workspace",
      workspacePath,
      "--idempotency-key",
      uuid,
      "--provider",
      "codex",
      "--additional-directory",
      additionalDirectory,
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "2",
      "--timeout-ms",
      "5000",
    ],
    [
      "session",
      "list",
      "--workspace",
      workspacePath,
      "--lifecycle-status",
      "active",
      "--cursor",
      "cursor-1",
      "--limit",
      "10",
    ],
    ["session", "read", "--session-id", "session-1"],
    ["session", "directories-chunk", "--session-id", "session-1", "--offset", "0", "--max-bytes", "4"],
    ["session", "archive", "--session-id", "session-1", "--idempotency-key", uuid],
    ["session", "unarchive", "--session-id", "session-1", "--idempotency-key", uuid],
    [
      "session",
      "close",
      "--session-id",
      "session-1",
      "--idempotency-key",
      uuid,
      "--expected-lifecycle-status",
      "active",
    ],
    ["session", "delete", "--session-id", "session-1", "--idempotency-key", uuid, "--confirm-local-only"],
  ] as const;

  for (const argv of invocations) {
    const result = await runCliWithSessionOperations(argv, dependencies(fake.operations));
    assert.equal(result.exitCode, CLI_EXIT_CODES.success, argv.join(" "));
    assert.equal(result.stderr, "");
    const output = oneJsonObject(result.stdout);
    assert.equal(output.schemaVersion, CLI_SCHEMA_VERSION);
    assert.equal(output.kind, "operation");
  }

  assert.deepEqual(fake.calls, [
    {
      operation: "create",
      request: {
        context: { authorization },
        title: "Session title",
        workspacePath,
        idempotencyKey: uuid,
        providerId: "codex",
        allowedAdditionalDirectories: [additionalDirectory],
        defaultCharacterId: "character-1",
        maxConcurrentChildRuns: 2,
      },
      options: { timeoutMs: 5000 },
    },
    {
      operation: "list",
      request: {
        context: { authorization },
        workspacePath,
        lifecycleStatus: "active",
        cursor: "cursor-1",
        limit: 10,
      },
      options: {},
    },
    {
      operation: "read",
      request: { context: { authorization }, sessionId: "session-1" },
      options: {},
    },
    {
      operation: "readDirectoriesChunk",
      request: { context: { authorization }, sessionId: "session-1", offset: 0, maxBytes: 4 },
      options: {},
    },
    {
      operation: "archive",
      request: { context: { authorization }, sessionId: "session-1", idempotencyKey: uuid },
      options: {},
    },
    {
      operation: "unarchive",
      request: { context: { authorization }, sessionId: "session-1", idempotencyKey: uuid },
      options: {},
    },
    {
      operation: "close",
      request: {
        context: { authorization },
        sessionId: "session-1",
        idempotencyKey: uuid,
        expectedLifecycleStatus: "active",
      },
      options: {},
    },
    {
      operation: "delete",
      request: { context: { authorization }, sessionId: "session-1", idempotencyKey: uuid },
      options: {},
    },
  ]);
  assert.equal(
    invocations.some((argv) => argv.some((value: string) => value === "--database")),
    false,
  );
});

test("caller idempotency survives exact retry and conflicting request reuse", async () => {
  let createCount = 0;
  const fake = recordingOperations(({ operation, request }) => {
    assert.equal(operation, "create");
    createCount += 1;
    const providerId = (request as Readonly<{ providerId: string }>).providerId;
    if (providerId !== "codex") {
      return failure(
        { kind: "domain", code: "idempotency_conflict", message: "conflict", retryable: false },
        { status: "rejected", effect: "none" },
      );
    }
    return {
      overallStatus: "success",
      value: {
        sessionId: "session-1",
        title: "Session title",
        workspacePath,
        localRepositoryKey: null,
        repositoryName: null,
        lifecycleStatus: "active",
        createdAt: 1,
      },
      persistence: { status: "committed", effect: "none", replayed: createCount > 1 },
    };
  });
  const baseArgv = [
    "session",
    "create",
    "--title",
    "Session title",
    "--workspace",
    workspacePath,
    "--idempotency-key",
    uuid,
    "--provider",
    "codex",
    "--default-character",
    "character-1",
    "--max-concurrent-child-runs",
    "2",
  ] as const;

  const first = await runCliWithSessionOperations(baseArgv, dependencies(fake.operations));
  const retry = await runCliWithSessionOperations(baseArgv, dependencies(fake.operations));
  const conflicting = await runCliWithSessionOperations(
    baseArgv.map((value) => (value === "codex" ? "other-provider" : value)),
    dependencies(fake.operations),
  );

  assert.equal(first.exitCode, CLI_EXIT_CODES.success);
  assert.equal(retry.exitCode, CLI_EXIT_CODES.success);
  assert.equal(
    (
      (oneJsonObject(retry.stdout).applicationResponse as Readonly<Record<string, unknown>>).persistence as Readonly<
        Record<string, unknown>
      >
    ).replayed,
    true,
  );
  assert.equal(conflicting.exitCode, CLI_EXIT_CODES.domainRejected);
  assert.deepEqual(
    fake.calls.map((call) => (call.request as Readonly<{ idempotencyKey: string }>).idempotencyKey),
    [uuid, uuid, uuid],
  );
});

test("Application response families remain observable at the argv boundary", async () => {
  const cases = [
    {
      argv: ["session", "list"],
      response: {
        overallStatus: "partial_success",
        value: { items: [] },
        issues: [{ kind: "omission", code: "response_size_limit", message: "omitted" }],
        persistence: { status: "read", effect: "none" },
      },
      exitCode: CLI_EXIT_CODES.partialSuccess,
    },
    {
      argv: ["session", "read", "--session-id", "session-1"],
      response: failure(
        { kind: "request", code: "request_invalid", message: "invalid", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.usageInvalid,
    },
    {
      argv: ["session", "read", "--session-id", "session-1"],
      response: failure(
        { kind: "access", code: "forbidden", message: "denied", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.accessRejected,
    },
    {
      argv: ["session", "read", "--session-id", "session-1"],
      response: failure(
        { kind: "domain", code: "not_found", message: "missing", retryable: false },
        { status: "rejected", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.domainRejected,
    },
    {
      argv: ["session", "archive", "--session-id", "session-1", "--idempotency-key", uuid],
      response: failure(
        { kind: "persistence", code: "persistence_unavailable", message: "down", retryable: true, effect: "none" },
        { status: "failed", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.persistenceFailedNoEffect,
    },
    {
      argv: ["session", "archive", "--session-id", "session-1", "--idempotency-key", uuid],
      response: failure(
        { kind: "persistence", code: "persistence_unavailable", message: "lost", retryable: true, effect: "unknown" },
        { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
      ),
      exitCode: CLI_EXIT_CODES.persistenceFailedUnknownEffect,
    },
    {
      argv: ["session", "read", "--session-id", "session-1"],
      response: failure(
        { kind: "operation", code: "operation_timeout", message: "timeout", retryable: true },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.timeout,
    },
    {
      argv: ["session", "read", "--session-id", "session-1"],
      response: failure(
        { kind: "operation", code: "operation_canceled", message: "canceled", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.canceled,
    },
    {
      argv: ["session", "delete", "--session-id", "session-1", "--idempotency-key", uuid, "--confirm-local-only"],
      response: {
        overallStatus: "partial_success",
        value: {
          sessionId: "session-1",
          cleanupToken: uuid,
          deletedSessionCount: 1,
          localOnly: true,
          cleanupStatus: "pending",
        },
        issues: [
          {
            kind: "cleanup",
            code: "session_files_cleanup_pending",
            message: "Session Files cleanup is pending.",
            cleanupToken: uuid,
            retryable: true,
            reconciliation: "exact_request_required",
          },
        ],
        persistence: { status: "committed", effect: "none", replayed: false },
      },
      exitCode: CLI_EXIT_CODES.partialSuccess,
    },
    {
      argv: ["session", "delete", "--session-id", "session-1", "--idempotency-key", uuid, "--confirm-local-only"],
      response: failure(
        { kind: "domain", code: "session_busy", message: "busy", retryable: true },
        { status: "rejected", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.domainRejected,
    },
    {
      argv: ["session", "delete", "--session-id", "session-1", "--idempotency-key", uuid, "--confirm-local-only"],
      response: failure(
        { kind: "persistence", code: "persistence_unavailable", message: "lost", retryable: true, effect: "unknown" },
        { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
      ),
      exitCode: CLI_EXIT_CODES.persistenceFailedUnknownEffect,
    },
  ] as const;

  for (const candidate of cases) {
    const fake = recordingOperations(() => candidate.response);
    const result = await runCliWithSessionOperations(candidate.argv, dependencies(fake.operations));
    assert.equal(result.exitCode, candidate.exitCode);
    assert.equal(result.stderr, "");
    const output = oneJsonObject(result.stdout);
    assert.equal(output.kind, "operation");
    assert.deepEqual(output.applicationResponse, candidate.response);
  }
});

test("AbortSignal and timeout are passed to the Application operation", async () => {
  const controller = new AbortController();
  const fake = recordingOperations(({ operation }) => successResponse(operation));
  const result = await runCliWithSessionOperations(
    ["session", "read", "--session-id", "session-1", "--timeout-ms", "250"],
    { ...dependencies(fake.operations), signal: controller.signal },
  );

  assert.equal(result.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(fake.calls[0]?.options, { timeoutMs: 250, signal: controller.signal });
});

test("thrown and malformed Application fulfillments become sanitized runtime failures", async () => {
  const throwing = recordingOperations(() => {
    throw new Error("private stack and database path");
  });
  const malformed = recordingOperations(() => ({
    overallStatus: "success",
    value: { sessionId: "other-session", lifecycleStatus: "archived", updatedAt: 1 },
    persistence: { status: "committed", effect: "none", replayed: false },
  }));

  for (const fake of [throwing, malformed]) {
    const result = await runCliWithSessionOperations(
      ["session", "archive", "--session-id", "session-1", "--idempotency-key", uuid],
      dependencies(fake.operations),
    );
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("private stack"), false);
    assert.equal(result.stdout.includes("database path"), false);
    assert.match(result.stdout, /"kind":"runtime_failure"/u);
  }
});

test("help, version, and argv failures have stable output without invoking operations", async () => {
  const fake = recordingOperations(() => {
    throw new Error("operations must not be called");
  });
  const help = await runCliWithSessionOperations(["--help"], dependencies(fake.operations));
  const version = await runCliWithSessionOperations(["--version"], dependencies(fake.operations));
  const invalid = await runCliWithSessionOperations(["session", "read"], dependencies(fake.operations));

  assert.match(help.stdout, /^Usage: withmate/u);
  assert.equal(help.exitCode, CLI_EXIT_CODES.success);
  assert.equal(version.stdout, "0.1.0\n");
  assert.equal(version.exitCode, CLI_EXIT_CODES.success);
  assert.equal(invalid.exitCode, CLI_EXIT_CODES.usageInvalid);
  assert.equal(oneJsonObject(invalid.stdout).kind, "usage_failure");
  assert.equal(fake.calls.length, 0);
});

function dependencies(operations: Operations) {
  return { version: "0.1.0", operations, messageOperations: unsupportedMessageOperations(), authorization } as const;
}

function unsupportedMessageOperations(): MessageOperations {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected Message operation");
  };
  return { messages: unsupported, messageContentChunk: unsupported };
}

function recordingOperations(
  respond: (call: Call) => unknown,
): Readonly<{ operations: Operations; calls: readonly Call[] }> {
  const calls: Call[] = [];
  async function invoke<TOperation extends OperationName>(
    operation: TOperation,
    request: unknown,
    options: unknown,
  ): Promise<Awaited<ReturnType<Operations[TOperation]>>> {
    const call = { operation, request, options } as const;
    calls.push(call);
    return respond(call) as Awaited<ReturnType<Operations[TOperation]>>;
  }
  const operations: Operations = {
    create: (request, options) => invoke("create", request, options),
    updateTitle: (request, options) => invoke("updateTitle", request, options),
    list: (request, options) => invoke("list", request, options),
    listLocalRepositories: (request, options) => invoke("listLocalRepositories", request, options),
    read: (request, options) => invoke("read", request, options),
    readDirectoriesChunk: (request, options) => invoke("readDirectoriesChunk", request, options),
    archive: (request, options) => invoke("archive", request, options),
    unarchive: (request, options) => invoke("unarchive", request, options),
    close: (request, options) => invoke("close", request, options),
    delete: (request, options) => invoke("delete", request, options),
  };
  return { operations, calls };
}

function successResponse(operation: OperationName): unknown {
  const readPersistence = { status: "read", effect: "none" } as const;
  const writePersistence = { status: "committed", effect: "none", replayed: false } as const;
  switch (operation) {
    case "create":
      return {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          title: "Session title",
          workspacePath,
          localRepositoryKey: null,
          repositoryName: null,
          lifecycleStatus: "active",
          createdAt: 1,
        },
        persistence: writePersistence,
      };
    case "updateTitle":
      return {
        overallStatus: "success",
        value: { sessionId: "session-1", title: "Renamed", updatedAt: 2 },
        persistence: writePersistence,
      };
    case "list":
      return { overallStatus: "success", value: { items: [listItem()] }, persistence: readPersistence };
    case "listLocalRepositories":
      return { overallStatus: "success", value: { items: [] }, persistence: readPersistence };
    case "read":
      return { overallStatus: "success", value: readValue(), persistence: readPersistence };
    case "readDirectoriesChunk":
      return {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          offset: 0,
          totalBytes: 4,
          eof: true,
          bytes: Uint8Array.from([0, 1, 2, 3]).buffer,
        },
        persistence: readPersistence,
      };
    case "archive":
      return transitionResponse("archived", writePersistence);
    case "unarchive":
      return transitionResponse("active", writePersistence);
    case "close":
      return transitionResponse("closed", writePersistence);
    case "delete":
      return {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          cleanupToken: uuid,
          deletedSessionCount: 1,
          localOnly: true,
          cleanupStatus: "completed",
        },
        persistence: writePersistence,
      };
  }
}

function transitionResponse(status: "active" | "archived" | "closed", persistence: unknown) {
  return {
    overallStatus: "success",
    value: { sessionId: "session-1", lifecycleStatus: status, updatedAt: 2 },
    persistence,
  };
}

function listItem() {
  return {
    id: "session-1",
    title: "Session 1",
    workspacePath,
    localRepositoryKey: null,
    repositoryName: null,
    defaultCharacterId: "character-1",
    lifecycleStatus: "active",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    executionState: "not_started",
    stateChangedAt: 1,
  };
}

function readValue() {
  return {
    session: {
      id: "session-1",
      title: "Session 1",
      providerId: "codex",
      workspacePath,
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: 2,
      allowedAdditionalDirectoriesState: "inline",
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 2,
      lifecycleStatus: "active",
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    },
    execution: { state: "not_started" },
  };
}

function failure(error: unknown, persistence: unknown) {
  return { overallStatus: "failure", error, persistence };
}

function oneJsonObject(stdout: string): Readonly<Record<string, unknown>> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  const parsed: unknown = JSON.parse(stdout);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Readonly<Record<string, unknown>>;
}
