import assert from "node:assert/strict";
import test from "node:test";

import { projectCliOperationOutput, serializeCliStructuredOutput } from "../src/cli/application-response.js";
import { CLI_EXIT_CODES, CLI_SESSION_RUN_LIMITS, type CliValidatedSessionCommand } from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { dispatchCliSessionCommand } from "../src/cli/session-dispatch.js";
import type {
  ApplicationSessionMessageOperations,
  ApplicationSessionOperations,
  ApplicationSessionRunOperations,
} from "../src/main/index.js";

type Authorization = Readonly<{ principal: "local-user" }>;
type SessionRunOperations = ApplicationSessionRunOperations<Authorization>;

const authorization: Authorization = { principal: "local-user" };

test("Session Run parser accepts the complete grammar and Repository-derived boundaries", () => {
  assert.deepEqual(
    parseCliArgv([
      "session",
      "runs",
      "--session-id",
      "session-1",
      "--cursor",
      "opaque-1",
      "--limit",
      "100",
      "--timeout-ms",
      "5000",
    ]),
    {
      kind: "command",
      command: {
        identity: { namespace: "session", operation: "runs" },
        sessionId: "session-1",
        cursor: "opaque-1",
        limit: 100,
        timeoutMs: 5000,
      },
    },
  );
  assert.deepEqual(parseCliArgv(["session", "runs", "--session-id", "session-1"]), {
    kind: "command",
    command: {
      identity: { namespace: "session", operation: "runs" },
      sessionId: "session-1",
      limit: CLI_SESSION_RUN_LIMITS.runsDefaultItems,
    },
  });
  for (const limit of ["1", "50", "100"]) {
    const parsed = parseCliArgv(["session", "runs", "--session-id", "session-1", "--limit", limit]);
    assert.equal(parsed.kind, "command");
  }
  assert.match(
    helpText({ kind: "operation", command: { namespace: "session", operation: "runs" } }),
    /^Usage: withmate session runs/u,
  );
  assert.match(helpText({ kind: "session" }), /runs\s+Read a bounded persisted Run history page/u);
});

test("Session Run parser rejects missing, duplicate, unknown, and out-of-range options", () => {
  const invalid = [
    ["session", "runs"],
    ["session", "runs", "--session-id", "session-1", "--limit", "0"],
    ["session", "runs", "--session-id", "session-1", "--limit", "101"],
    ["session", "runs", "--session-id", "session-1", "--timeout-ms", "0"],
    ["session", "runs", "--session-id", "session-1", "--cursor", "x".repeat(2_049)],
    ["session", "runs", "--session-id", "session-1", "--session-id", "session-2"],
    ["session", "runs", "--session-id", "session-1", "--unknown", "x"],
  ];
  for (const argv of invalid) {
    const parsed = parseCliArgv(argv);
    assert.equal(parsed.kind, "usage_failure");
    if (parsed.kind === "usage_failure") assert.equal(parsed.exitCode, CLI_EXIT_CODES.usageInvalid);
  }
});

test("Session Run dispatch sends the exact Application request and emits one strict JSON object", async () => {
  const calls: unknown[] = [];
  const operations: SessionRunOperations = {
    async runs(request, options) {
      calls.push({ request, options });
      return success({ sessionId: "session-1", items: runItems(), nextCursor: "cursor-2" }) as never;
    },
  };
  const command = parsedCommand([
    "session",
    "runs",
    "--session-id",
    "session-1",
    "--cursor",
    "cursor-1",
    "--limit",
    "50",
    "--timeout-ms",
    "5000",
  ]);
  const result = await dispatchCliSessionCommand(command, dependencies(operations));
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(calls, [
    {
      request: {
        context: { authorization },
        sessionId: "session-1",
        cursor: "cursor-1",
        limit: 50,
      },
      options: { timeoutMs: 5000 },
    },
  ]);
  if (!result.ok) return;
  const line = serializeCliStructuredOutput(result.output);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  const output = JSON.parse(line) as Readonly<Record<string, unknown>>;
  const applicationResponse = output.applicationResponse as Readonly<Record<string, unknown>>;
  const value = applicationResponse.value as Readonly<Record<string, unknown>>;
  const items = value.items as readonly Readonly<Record<string, unknown>>[];
  assert.deepEqual(
    items.map((item) => item.phase),
    ["queued", "starting", "active", "canceling", "finalizing", "completed", "failed", "interrupted", "canceled"],
  );
  assert.equal(JSON.stringify(output).includes("liveActivity"), false);
  assert.equal(JSON.stringify(output).includes("workspace"), false);
});

test("Session Run projection rejects every forbidden field and invalid phase tuple as runtime failure", () => {
  const command = parsedCommand(["session", "runs", "--session-id", "session-1"]);
  const invalid = [
    { ...success(runPage()), unexpected: true },
    {
      ...success(runPage()),
      persistence: { status: "read", effect: "none", workspaceKey: "secret" },
    },
    success({ ...runPage(), workspaceKey: "secret" }),
    success(runPage([{ ...runItem(), version: 1 }])),
    success(runPage([{ ...runItem(), liveActivity: null }])),
    success(runPage([runItem({ phase: "active", terminalAt: undefined, finalAssistantMessageId: "message-2" })])),
    success(runPage([runItem({ phase: "completed", cancellation: { requestedAt: 1 } })])),
    success(runPage([runItem({ phase: "failed", failure: undefined })])),
    success(runPage([runItem({ phase: "active", terminalAt: undefined, failure: { origin: "provider" } })])),
    success(runPage([runItem({ runId: "run-2", ordinal: 2 }), runItem({ ordinal: 1 })])),
    success({ ...runPage([]), nextCursor: "cursor" }),
    success({ ...runPage(), nextCursor: "cursor-1" }),
    success(runPage([{ ...runItem({ phase: "failed" }), failure: { origin: "provider", raw: true } }])),
    success(runPage([{ ...runItem({ phase: "canceled" }), cancellation: { requestedAt: 1, raw: true } }])),
    {
      overallStatus: "failure",
      error: { kind: "domain", code: "not_found", message: "missing", retryable: false, workspaceKey: "secret" },
      persistence: { status: "rejected", effect: "none" },
    },
    {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: "capacity_exceeded",
        message: "not a Run history error",
        retryable: true,
        details: { scope: "application", current: 1, limit: 1 },
      },
      persistence: { status: "rejected", effect: "none" },
    },
  ];
  for (const response of invalid) {
    const projection = projectCliOperationOutput(
      { ...command, cursor: "cursor-1" } as CliValidatedSessionCommand,
      response,
    );
    assert.equal(projection.ok, false);
    assert.equal(projection.exitCode, CLI_EXIT_CODES.runtimeFailure);
    assert.equal(projection.output.kind, "runtime_failure");
    if (projection.output.kind === "runtime_failure") {
      assert.equal(projection.output.error.code, "malformed_application_response");
    }
  }
});

test("Session Run partial success requires exact ordinal omissions within the command limit", () => {
  const command = parsedCommand(["session", "runs", "--session-id", "session-1", "--limit", "2"]);
  const valid = projectCliOperationOutput(command, {
    overallStatus: "partial_success",
    value: runPage([runItem({ runId: "run-2", ordinal: 2 })], "cursor-2"),
    issues: [omission(1)],
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.exitCode, CLI_EXIT_CODES.partialSuccess);

  const omissionOnly = projectCliOperationOutput(command, {
    overallStatus: "partial_success",
    value: runPage([], "cursor-1"),
    issues: [omission(1)],
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(omissionOnly.ok, true);
  assert.equal(omissionOnly.exitCode, CLI_EXIT_CODES.partialSuccess);

  const invalid = [
    [runItem({ runId: "run-1", ordinal: 1 }), omission(1)],
    [runItem({ runId: "run-2", ordinal: 2 }), { ...omission(1), raw: true }],
    [runItem({ runId: "run-2", ordinal: 2 }), { ...omission(1), ordinal: undefined }],
    [runItem({ runId: "run-2", ordinal: 2 }), omission(1), omission(3)],
  ];
  for (const [item, ...issues] of invalid) {
    const projection = projectCliOperationOutput(command, {
      overallStatus: "partial_success",
      value: runPage([item], "cursor-2"),
      issues,
      persistence: { status: "read", effect: "none" },
    });
    assert.equal(projection.ok, false);
  }
});

test("Session Run failures preserve the existing access, domain, timeout, and cancel exit mapping", () => {
  const command = parsedCommand(["session", "runs", "--session-id", "session-1"]);
  const cases = [
    [failure("access", "forbidden", "not_attempted", false), CLI_EXIT_CODES.accessRejected],
    [failure("domain", "not_found", "rejected", false), CLI_EXIT_CODES.domainRejected],
    [failure("operation", "operation_timeout", "not_attempted", true), CLI_EXIT_CODES.timeout],
    [failure("operation", "operation_canceled", "not_attempted", false), CLI_EXIT_CODES.canceled],
  ] as const;
  for (const [response, exitCode] of cases) {
    const projection = projectCliOperationOutput(command, response);
    assert.equal(projection.ok, true);
    assert.equal(projection.exitCode, exitCode);
  }
});

function parsedCommand(argv: readonly string[]): CliValidatedSessionCommand {
  const parsed = parseCliArgv(argv);
  assert.equal(parsed.kind, "command");
  if (parsed.kind !== "command" || parsed.command.identity.namespace !== "session") assert.fail("expected command");
  return parsed.command as CliValidatedSessionCommand;
}

function dependencies(sessionRunOperations: SessionRunOperations) {
  return {
    operations: unsupportedSessionOperations(),
    messageOperations: unsupportedMessageOperations(),
    sessionRunOperations,
    authorization,
  } as const;
}

function unsupportedSessionOperations(): ApplicationSessionOperations<Authorization> {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected Session operation");
  };
  return {
    create: unsupported,
    updateTitle: unsupported,
    list: unsupported,
    listLocalRepositories: unsupported,
    read: unsupported,
    readDirectoriesChunk: unsupported,
    archive: unsupported,
    unarchive: unsupported,
    close: unsupported,
    delete: unsupported,
  };
}

function unsupportedMessageOperations(): ApplicationSessionMessageOperations<Authorization> {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected Message operation");
  };
  return { messages: unsupported, messageContentChunk: unsupported };
}

function success(value: unknown) {
  return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
}

function runPage(items: readonly unknown[] = [runItem()], nextCursor?: string) {
  return { sessionId: "session-1", items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function runItem(overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.fromEntries(
    Object.entries({
      runId: "run-1",
      ordinal: 1,
      initiatingMessageId: "message-1",
      phase: "completed",
      createdAt: 1,
      startedAt: 2,
      terminalAt: 3,
      updatedAt: 3,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
}

function runItems() {
  return [
    runItem({ runId: "run-1", ordinal: 1, phase: "queued", startedAt: undefined, terminalAt: undefined }),
    runItem({ runId: "run-2", ordinal: 2, phase: "starting", terminalAt: undefined }),
    runItem({ runId: "run-3", ordinal: 3, phase: "active", terminalAt: undefined }),
    runItem({
      runId: "run-4",
      ordinal: 4,
      phase: "canceling",
      terminalAt: undefined,
      cancellation: { requestedAt: 4 },
    }),
    runItem({ runId: "run-5", ordinal: 5, phase: "finalizing", terminalAt: undefined }),
    runItem({ runId: "run-6", ordinal: 6, finalAssistantMessageId: undefined }),
    runItem({ runId: "run-7", ordinal: 7, phase: "failed", failure: { origin: "provider", summary: "failed" } }),
    runItem({ runId: "run-8", ordinal: 8, phase: "interrupted", failure: { origin: "transport" } }),
    runItem({ runId: "run-9", ordinal: 9, phase: "canceled", cancellation: { requestedAt: 8 } }),
  ];
}

function omission(ordinal: number) {
  return {
    kind: "omission",
    code: "response_size_limit",
    message: "Run was omitted because the response size limit was reached.",
    ordinal,
  } as const;
}

function failure(kind: "access" | "domain" | "operation", code: string, status: string, retryable: boolean) {
  return {
    overallStatus: "failure",
    error: { kind, code, message: "failure", retryable },
    persistence: { status, effect: "none" },
  };
}
