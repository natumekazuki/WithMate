import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliRunCancelValue,
  type CliRunStatusValue,
  type CliSessionRunItem,
  type CliValidatedRunCommand,
} from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { projectCliRunOperationOutput } from "../src/cli/run-output.js";

const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000701";
const startCommand = {
  identity: { namespace: "run", operation: "start" },
  sessionId: "session-1",
  idempotencyKey,
  contentBlocks: [{ type: "text", text: "hello" }],
  execution: {
    model: "gpt-test",
    reasoningEffort: "medium",
    sandbox: { mode: "workspace-write", networkAccess: false },
  },
} as const satisfies CliValidatedRunCommand;
const retryCommand = {
  identity: { namespace: "run", operation: "retry" },
  sessionId: "session-1",
  retryOfRunId: "run-source",
  idempotencyKey,
  executionOverrides: { reasoningEffort: "high" },
} as const satisfies CliValidatedRunCommand;
const sendInputCommand = {
  identity: { namespace: "run", operation: "send-input" },
  sessionId: "session-1",
  runId: "run-1",
  idempotencyKey,
  contentBlocks: [{ type: "text", text: "continue" }],
} as const satisfies CliValidatedRunCommand;
const cancelCommand = {
  identity: { namespace: "run", operation: "cancel" },
  sessionId: "session-1",
  runId: "run-1",
  idempotencyKey,
} as const satisfies CliValidatedRunCommand;
const statusCommand = {
  identity: { namespace: "run", operation: "status" },
  sessionId: "session-1",
  runId: "run-1",
} as const satisfies CliValidatedRunCommand;
const eventsCommand = {
  identity: { namespace: "run", operation: "events" },
  sessionId: "session-1",
  runId: "run-1",
  limit: 2,
} as const satisfies CliValidatedRunCommand;
const followCommand = {
  identity: { namespace: "run", operation: "follow" },
  sessionId: "session-1",
  runId: "run-1",
  limit: 2,
  waitMs: 10_000,
  pollMs: 250,
} as const satisfies CliValidatedRunCommand;

const cliOwnedStatusContract: CliRunStatusValue = {
  sessionId: "session-1",
  runId: "run-1",
  phase: "failed",
  liveActivity: null,
  createdAt: 1,
  updatedAt: 2,
  terminalAt: 2,
  failure: {
    origin: "provider",
    summary: "redacted",
    // @ts-expect-error Provider metadata is not part of the CLI-owned Run schema.
    providerErrorCode: "private",
  },
};
void cliOwnedStatusContract;

// @ts-expect-error canceled Run status cannot expose a request without its acknowledgement
const invalidCanceledStatusCancellation: CliRunStatusValue = {
  sessionId: "session-1",
  runId: "run-1",
  phase: "canceled",
  liveActivity: null,
  createdAt: 1,
  updatedAt: 2,
  terminalAt: 2,
  cancellation: { requestedAt: 1 },
};
// @ts-expect-error canceled Run history cannot expose a request without its acknowledgement
const invalidCanceledHistoryCancellation: CliSessionRunItem = {
  runId: "run-1",
  ordinal: 1,
  initiatingMessageId: "message-1",
  phase: "canceled",
  createdAt: 1,
  updatedAt: 2,
  terminalAt: 2,
  cancellation: { requestedAt: 1 },
};
// @ts-expect-error canceled Run cancel result cannot expose a request without its acknowledgement
const invalidCanceledCancelResult: CliRunCancelValue = {
  sessionId: "session-1",
  runId: "run-1",
  phase: "canceled",
  liveActivity: null,
  createdAt: 1,
  updatedAt: 2,
  terminalAt: 2,
  cancellation: { requestedAt: 1 },
};
void invalidCanceledStatusCancellation;
void invalidCanceledHistoryCancellation;
void invalidCanceledCancelResult;

test("Run help and validated commands are runtime-free parser results", () => {
  assert.deepEqual(parseCliArgv(["run"]), { kind: "help", topic: { kind: "run" } });
  assert.deepEqual(parseCliArgv(["run", "events", "--help"]), {
    kind: "help",
    topic: { kind: "operation", command: { namespace: "run", operation: "events" } },
  });
  assert.match(helpText({ kind: "root" }), /withmate run --help/u);
  assert.match(
    helpText({ kind: "run" }),
    /start[\s\S]*retry[\s\S]*send-input[\s\S]*cancel[\s\S]*status[\s\S]*events[\s\S]*follow/u,
  );
  assert.match(helpText({ kind: "operation", command: startCommand.identity }), /content-blocks-json/u);
  assert.match(helpText({ kind: "operation", command: retryCommand.identity }), /inherited from the source Run/u);
  const inputHelp = helpText({ kind: "operation", command: sendInputCommand.identity });
  assert.match(inputHelp, /same idempotency key returns its current durable outcome/u);
  assert.match(inputHelp, /does not cancel an admitted delivery/u);
  assert.match(inputHelp, /new idempotency key can duplicate/u);
  const cancelHelp = helpText({ kind: "operation", command: cancelCommand.identity });
  assert.match(cancelHelp, /same idempotency key returns its current durable outcome/u);
  assert.match(cancelHelp, /terminal target is a successful no-op/u);
  assert.match(cancelHelp, /SIGINT[\s\S]*neither undo a durable/u);

  assert.deepEqual(
    parseCliArgv([
      "run",
      "start",
      "--session-id",
      "session-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      JSON.stringify(startCommand.contentBlocks),
      "--model",
      "gpt-test",
      "--reasoning-effort",
      "medium",
      "--sandbox-json",
      JSON.stringify(startCommand.execution.sandbox),
    ]),
    { kind: "command", command: startCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "retry",
      "--session-id",
      "session-1",
      "--retry-of-run-id",
      "run-source",
      "--idempotency-key",
      idempotencyKey,
      "--reasoning-effort",
      "high",
    ]),
    { kind: "command", command: retryCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "send-input",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      JSON.stringify(sendInputCommand.contentBlocks),
    ]),
    { kind: "command", command: sendInputCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "cancel",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--idempotency-key",
      idempotencyKey,
      "--timeout-ms",
      "5000",
    ]),
    { kind: "command", command: { ...cancelCommand, timeoutMs: 5000 } },
  );

  assert.deepEqual(
    parseCliArgv(["run", "status", "--session-id", "session-1", "--run-id", "run-1", "--timeout-ms", "5000"]),
    { kind: "command", command: { ...statusCommand, timeoutMs: 5000 } },
  );
  assert.deepEqual(
    parseCliArgv(["run", "events", "--session-id", "session-1", "--run-id", "run-1", "--cursor", "opaque"]),
    { kind: "command", command: { ...eventsCommand, cursor: "opaque", limit: 100 } },
  );
  assert.deepEqual(parseCliArgv(["run", "follow", "--session-id", "session-1", "--run-id", "run-1"]), {
    kind: "command",
    command: { ...followCommand, limit: 100 },
  });
  assert.deepEqual(
    parseCliArgv([
      "run",
      "follow",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--limit",
      "200",
      "--wait-ms",
      "0",
      "--poll-ms",
      "25",
    ]),
    { kind: "command", command: { ...followCommand, limit: 200, waitMs: 0, pollMs: 25 } },
  );
});

test("Run parser rejects missing, duplicate, unknown, unbounded, and invalid mutation inputs", () => {
  const cases = [
    ["run", "status", "--session-id", "session-1"],
    ["run", "status", "--session-id", "session-1", "--run-id", "run-1", "--run-id", "run-2"],
    ["run", "events", "--session-id", "session-1", "--run-id", "run-1", "--workspace", "workspace"],
    ["run", "events", "--session-id", "session-1", "--run-id", "run-1", "--limit", "0"],
    ["run", "events", "--session-id", "session-1", "--run-id", "run-1", "--limit", "201"],
    ["run", "follow", "--session-id", "session-1", "--run-id", "run-1", "--wait-ms", "30001"],
    ["run", "follow", "--session-id", "session-1", "--run-id", "run-1", "--poll-ms", "24"],
    ["run", "follow", "--session-id", "session-1", "--run-id", "run-1", "--poll-ms", "5001"],
    ["run", "start"],
    ["run", "retry"],
    ["run", "send-input"],
    ["run", "cancel"],
    ["run", "cancel", "--session-id", "session-1", "--run-id", "run-1", "--idempotency-key", "not-a-uuid"],
    [
      "run",
      "cancel",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      "[]",
    ],
    [
      "run",
      "cancel",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--run-id",
      "run-2",
      "--idempotency-key",
      idempotencyKey,
    ],
    [
      "run",
      "send-input",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      "[]",
      "--model",
      "not-owned-by-input",
    ],
    [
      "run",
      "start",
      "--session-id",
      "session-1",
      "--idempotency-key",
      "not-a-uuid",
      "--content-blocks-json",
      "[]",
      "--model",
      "gpt-test",
      "--reasoning-effort",
      "medium",
      "--sandbox-json",
      '{"mode":"danger-full-access"}',
    ],
    [
      "run",
      "retry",
      "--session-id",
      "session-1",
      "--retry-of-run-id",
      "run-source",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      "[]",
    ],
    [
      "run",
      "start",
      "--session-id",
      "session-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      '[{"type":"image","type":"text","text":"hello"}]',
      "--model",
      "gpt-test",
      "--reasoning-effort",
      "medium",
      "--sandbox-json",
      '{"mode":"danger-full-access"}',
    ],
    [
      "run",
      "start",
      "--session-id",
      "session-1",
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      '[{"type":"text","text":"hello"}]',
      "--model",
      "gpt-test",
      "--reasoning-effort",
      "medium",
      "--sandbox-json",
      '{"mode":"read-only","mode":"danger-full-access"}',
    ],
  ] as const;
  for (const argv of cases) {
    const parsed = parseCliArgv(argv);
    assert.equal(parsed.kind, "usage_failure", argv.join(" "));
    if (parsed.kind === "usage_failure") assert.equal(parsed.exitCode, CLI_EXIT_CODES.usageInvalid);
  }
});

test("Run content mutations accept the exact inline JSON byte limit and reject one byte beyond it", () => {
  const emptyJsonBytes = Buffer.byteLength(JSON.stringify([{ type: "text", text: "" }]));
  const exactText = "a".repeat(64 * 1024 - emptyJsonBytes);
  const argv = (contentBlocksJson: string) => [
    "run",
    "start",
    "--session-id",
    "session-1",
    "--idempotency-key",
    idempotencyKey,
    "--content-blocks-json",
    contentBlocksJson,
    "--model",
    "gpt-test",
    "--reasoning-effort",
    "medium",
    "--sandbox-json",
    '{"mode":"danger-full-access"}',
  ];
  assert.equal(parseCliArgv(argv(JSON.stringify([{ type: "text", text: exactText }]))).kind, "command");
  assert.equal(parseCliArgv(argv(JSON.stringify([{ type: "text", text: `${exactText}a` }]))).kind, "usage_failure");
  const inputArgv = (contentBlocksJson: string) => [
    "run",
    "send-input",
    "--session-id",
    "session-1",
    "--run-id",
    "run-1",
    "--idempotency-key",
    idempotencyKey,
    "--content-blocks-json",
    contentBlocksJson,
  ];
  assert.equal(parseCliArgv(inputArgv(JSON.stringify([{ type: "text", text: exactText }]))).kind, "command");
  assert.equal(
    parseCliArgv(inputArgv(JSON.stringify([{ type: "text", text: `${exactText}a` }]))).kind,
    "usage_failure",
  );
});

test("Run mutation output exposes only durable public admission identity", () => {
  const start = projectCliRunOperationOutput(startCommand, {
    overallStatus: "success",
    value: { sessionId: "session-1", runId: "run-new", phase: "queued" },
    persistence: { status: "committed", effect: "none", replayed: false },
  });
  assert.equal(start.ok, true);
  if (!start.ok) assert.fail("start projection failed");
  assert.equal(start.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(start.output.applicationResponse, {
    overallStatus: "success",
    value: { sessionId: "session-1", runId: "run-new", phase: "queued" },
    persistence: { status: "committed", effect: "none", replayed: false },
  });
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
  for (const command of [startCommand, retryCommand]) {
    for (const phase of phases) {
      const value = {
        sessionId: "session-1",
        runId: "run-replay",
        ...(command.identity.operation === "retry" ? { retryOfRunId: "run-source" } : {}),
        phase,
      };
      assert.equal(
        projectCliRunOperationOutput(command, {
          overallStatus: "success",
          value,
          persistence: { status: "committed", effect: "none", replayed: true },
        }).ok,
        true,
      );
      if (phase !== "queued") {
        assert.equal(
          projectCliRunOperationOutput(command, {
            overallStatus: "success",
            value,
            persistence: { status: "committed", effect: "none", replayed: false },
          }).ok,
          false,
        );
      }
    }
  }

  const leaked = projectCliRunOperationOutput(startCommand, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      runId: "run-new",
      phase: "queued",
      attemptId: "attempt-private",
    },
    persistence: { status: "committed", effect: "none", replayed: false },
  });
  assert.equal(leaked.ok, false);
  if (!leaked.ok) assert.equal(leaked.output.error.code, "malformed_application_response");

  const capacity = projectCliRunOperationOutput(startCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "capacity_exceeded",
      message: "Provider capacity was reached.",
      retryable: true,
      details: { scope: "provider", current: 4, limit: 4 },
    },
    persistence: { status: "rejected", effect: "none" },
  });
  assert.equal(capacity.ok, true);
  if (!capacity.ok) assert.fail("capacity projection failed");
  assert.equal(JSON.stringify(capacity.output).includes("providerId"), false);

  const capacityLeak = projectCliRunOperationOutput(startCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "capacity_exceeded",
      message: "Provider capacity was reached.",
      retryable: true,
      details: { scope: "provider", providerId: "provider-private", current: 4, limit: 4 },
    },
    persistence: { status: "rejected", effect: "none" },
  });
  assert.equal(capacityLeak.ok, false);
});

test("Run input output preserves delivery states and rejects non-public fields", () => {
  const states = [
    { deliveryState: "pending" },
    { deliveryState: "accepted" },
    { deliveryState: "rejected", resolutionCode: "provider_rejected" },
    { deliveryState: "rejected", resolutionCode: "delivery_not_sent" },
    { deliveryState: "ambiguous", resolutionCode: "transport_unknown" },
    { deliveryState: "ambiguous", resolutionCode: "process_unknown" },
    { deliveryState: "aborted", resolutionCode: "run_terminal_not_sent" },
  ] as const;
  for (const state of states) {
    const projected = projectCliRunOperationOutput(sendInputCommand, {
      overallStatus: "success",
      value: {
        sessionId: "session-1",
        runId: "run-1",
        messageId: "message-1",
        ...state,
      },
      persistence: { status: "committed", effect: "none", replayed: true },
    });
    assert.equal(projected.ok, true);
    if (!projected.ok) assert.fail("Run input projection failed");
    const applicationResponse = projected.output.applicationResponse;
    if (applicationResponse.overallStatus !== "success") assert.fail("Expected a successful Run input response.");
    assert.deepEqual(applicationResponse.value, {
      sessionId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      ...state,
    });
  }
  for (const privateFields of [{ attemptId: "attempt-private" }, { providerError: "provider-private" }]) {
    assert.equal(
      projectCliRunOperationOutput(sendInputCommand, {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-1",
          deliveryState: "accepted",
          ...privateFields,
        },
        persistence: { status: "committed", effect: "none", replayed: true },
      }).ok,
      false,
    );
  }
  for (const value of [
    {
      sessionId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      deliveryState: "pending",
      resolutionCode: "process_unknown",
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      deliveryState: "rejected",
      resolutionCode: "raw_provider_error",
    },
    {
      sessionId: "session-other",
      runId: "run-1",
      messageId: "message-1",
      deliveryState: "accepted",
    },
  ]) {
    assert.equal(
      projectCliRunOperationOutput(sendInputCommand, {
        overallStatus: "success",
        value,
        persistence: { status: "committed", effect: "none", replayed: true },
      }).ok,
      false,
    );
  }
  const capacity = projectCliRunOperationOutput(sendInputCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "capacity_exceeded",
      message: "Run input capacity was reached.",
      retryable: true,
      details: { scope: "run", runId: "run-1", current: 64, limit: 64 },
    },
    persistence: { status: "rejected", effect: "none" },
  });
  assert.equal(capacity.ok, true);
  for (const error of [
    {
      kind: "domain",
      code: "lifecycle_conflict",
      message: "The active Run is not owned by this runtime.",
      retryable: true,
    },
    {
      kind: "domain",
      code: "capacity_exceeded",
      message: "Run input capacity was reached.",
      retryable: true,
      details: { scope: "run", runId: "run-1", current: 1, limit: 1 },
    },
  ] as const) {
    const projected = projectCliRunOperationOutput(sendInputCommand, {
      overallStatus: "failure",
      error,
      persistence: { status: "not_attempted", effect: "none" },
    });
    assert.equal(projected.ok, true);
    if (!projected.ok) assert.fail("preflight domain failure projection failed");
    assert.deepEqual(projected.output.applicationResponse, {
      overallStatus: "failure",
      error,
      persistence: { status: "not_attempted", effect: "none" },
    });
  }
  assert.equal(
    projectCliRunOperationOutput(sendInputCommand, {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: "capacity_exceeded",
        message: "Run input capacity was reached.",
        retryable: true,
        details: { scope: "run", runId: "run-private", current: 64, limit: 64 },
      },
      persistence: { status: "rejected", effect: "none" },
    }).ok,
    false,
  );
  assert.equal(
    projectCliRunOperationOutput(startCommand, {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: "capacity_exceeded",
        message: "Unexpected Run input capacity.",
        retryable: true,
        details: { scope: "run", runId: "run-private", current: 64, limit: 64 },
      },
      persistence: { status: "rejected", effect: "none" },
    }).ok,
    false,
  );
  for (const code of ["cursor_invalid", "destination_invalid"] as const) {
    assert.equal(
      projectCliRunOperationOutput(sendInputCommand, {
        overallStatus: "failure",
        error: {
          kind: "domain",
          code,
          message: "This domain failure is not owned by Run input.",
          retryable: false,
        },
        persistence: { status: "not_attempted", effect: "none" },
      }).ok,
      false,
    );
  }
  for (const persistence of [
    { status: "not_attempted", effect: "none" },
    { status: "rejected", effect: "none" },
  ] as const) {
    assert.equal(
      projectCliRunOperationOutput(sendInputCommand, {
        overallStatus: "failure",
        error: {
          kind: "domain",
          code: "lifecycle_conflict",
          message: "The active Run is not owned by this runtime.",
          retryable: true,
          details: { internalOwner: "hidden" },
        },
        persistence,
      }).ok,
      false,
    );
  }
});

test("Run cancel output accepts only durable canceling or terminal timestamp tuples", () => {
  const outcomes = [
    {
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      cancellation: { requestedAt: 2 },
    },
    {
      phase: "completed",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      cancellation: { requestedAt: 2 },
    },
    {
      phase: "failed",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      failure: { origin: "provider" },
      cancellation: { requestedAt: 2 },
    },
    {
      phase: "interrupted",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      failure: { origin: "transport" },
      cancellation: { requestedAt: 2 },
    },
    {
      phase: "canceled",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      cancellation: { requestedAt: 2, acknowledgedAt: 3 },
    },
    {
      phase: "canceled",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
    },
  ] as const;
  for (const [index, outcome] of outcomes.entries()) {
    const projected = projectCliRunOperationOutput(cancelCommand, {
      overallStatus: "success",
      value: { sessionId: "session-1", runId: "run-1", ...outcome },
      persistence: { status: "committed", effect: "none", replayed: index !== 0 },
    });
    assert.equal(projected.ok, true, outcome.phase);
  }

  const invalidValues = [
    activeStatus(),
    { ...activeStatus(), phase: "queued" },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      cancellation: { requestedAt: 2, acknowledgedAt: 2 },
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "completed",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      cancellation: { requestedAt: 2, acknowledgedAt: 3 },
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceled",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      cancellation: { requestedAt: 2 },
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceled",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 3,
      terminalAt: 3,
      cancellation: { requestedAt: 3, acknowledgedAt: 2 },
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceled",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 4,
      terminalAt: 3,
      cancellation: { requestedAt: 2, acknowledgedAt: 4 },
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      cancellation: { requestedAt: 2, ownerToken: "private" },
    },
    {
      sessionId: "session-2",
      runId: "run-1",
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      cancellation: { requestedAt: 2 },
    },
  ];
  for (const value of invalidValues) {
    assert.equal(
      projectCliRunOperationOutput(cancelCommand, {
        overallStatus: "success",
        value,
        persistence: { status: "committed", effect: "none", replayed: false },
      }).ok,
      false,
    );
  }

  assert.equal(
    projectCliRunOperationOutput(cancelCommand, {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: "lifecycle_conflict",
        message: "Run cannot be canceled.",
        retryable: false,
      },
      persistence: { status: "rejected", effect: "none" },
    }).ok,
    true,
  );
  for (const code of ["capacity_exceeded", "cursor_invalid"] as const) {
    assert.equal(
      projectCliRunOperationOutput(cancelCommand, {
        overallStatus: "failure",
        error: { kind: "domain", code, message: "not a cancel error", retryable: false },
        persistence: { status: "rejected", effect: "none" },
      }).ok,
      false,
    );
  }
});

test("Run status output uses a strict phase allowlist and preserves schema v1", () => {
  const summary = "x".repeat(4_096);
  const projected = projectCliRunOperationOutput(statusCommand, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      phase: "failed",
      liveActivity: null,
      createdAt: 1,
      startedAt: 2,
      updatedAt: 3,
      terminalAt: 3,
      failure: { origin: "provider", summary },
    },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(projected.ok, true);
  if (!projected.ok) assert.fail("expected projected output");
  assert.equal(projected.output.schemaVersion, CLI_SCHEMA_VERSION);
  assert.equal(projected.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(projected.output.applicationResponse, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      phase: "failed",
      liveActivity: null,
      createdAt: 1,
      startedAt: 2,
      updatedAt: 3,
      terminalAt: 3,
      failure: { origin: "provider", summary },
    },
    persistence: { status: "read", effect: "none" },
  });

  for (const value of [
    { ...activeStatus(), executionSnapshot: "hidden" },
    {
      sessionId: "session-1",
      runId: "run-1",
      phase: "failed",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      failure: { origin: "provider", providerErrorCode: "hidden" },
    },
  ]) {
    assert.equal(
      projectCliRunOperationOutput(statusCommand, {
        overallStatus: "success",
        value,
        persistence: { status: "read", effect: "none" },
      }).ok,
      false,
    );
  }
});

test("Run event output preserves omissions, opaque continuation, order, and unknown kinds", () => {
  const projected = projectCliRunOperationOutput(eventsCommand, {
    overallStatus: "partial_success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      items: [{ ordinal: 2, kind: "unknown", summary: "", createdAt: 3, internalId: "hidden" }],
      nextCursor: "opaque-next",
      internalOrdinal: 2,
    },
    issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 }],
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(projected.ok, true);
  if (!projected.ok) assert.fail("expected projected output");
  assert.equal(projected.exitCode, CLI_EXIT_CODES.partialSuccess);
  assert.deepEqual(projected.output.applicationResponse, {
    overallStatus: "partial_success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      items: [{ ordinal: 2, kind: "unknown", createdAt: 3 }],
      nextCursor: "opaque-next",
    },
    issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 }],
    persistence: { status: "read", effect: "none" },
  });
});

test("Run event and follow output reject stalled or skipped opaque cursors", () => {
  const eventsFromCursor = { ...eventsCommand, cursor: "opaque" } as const satisfies CliValidatedRunCommand;
  const followFromCursor = { ...followCommand, cursor: "opaque" } as const satisfies CliValidatedRunCommand;
  const malformed = [
    projectCliRunOperationOutput(eventsFromCursor, {
      overallStatus: "success",
      value: {
        sessionId: "session-1",
        runId: "run-1",
        items: [event(1)],
        nextCursor: "opaque",
      },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(eventsFromCursor, {
      overallStatus: "success",
      value: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque-next" },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followFromCursor, {
      overallStatus: "success",
      value: {
        reason: "events",
        status: activeStatus(),
        events: {
          sessionId: "session-1",
          runId: "run-1",
          items: [event(1)],
          nextCursor: "opaque",
        },
      },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followFromCursor, {
      overallStatus: "success",
      value: {
        reason: "deadline",
        status: activeStatus(),
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque-next" },
      },
      persistence: { status: "read", effect: "none" },
    }),
  ];

  for (const result of malformed) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.output.error.code, "malformed_application_response");
  }
});

test("Run event and follow output count omission issues as cursor progress", () => {
  const eventsFromCursor = { ...eventsCommand, cursor: "opaque" } as const satisfies CliValidatedRunCommand;
  const followFromCursor = { ...followCommand, cursor: "opaque" } as const satisfies CliValidatedRunCommand;
  const issue = { kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 } as const;
  const projected = [
    projectCliRunOperationOutput(eventsFromCursor, {
      overallStatus: "partial_success",
      value: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque-next" },
      issues: [issue],
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followFromCursor, {
      overallStatus: "partial_success",
      value: {
        reason: "events",
        status: activeStatus(),
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque-next" },
      },
      issues: [issue],
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(eventsCommand, {
      overallStatus: "success",
      value: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "v1.zero" },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(eventsFromCursor, {
      overallStatus: "success",
      value: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followFromCursor, {
      overallStatus: "success",
      value: {
        reason: "deadline",
        status: activeStatus(),
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" },
      },
      persistence: { status: "read", effect: "none" },
    }),
  ];

  for (const result of projected) assert.equal(result.ok, true);
});

test("Run output rejects mismatched scope, malformed phases, order, and invalid follow closure", () => {
  const malformed = [
    projectCliRunOperationOutput(statusCommand, {
      overallStatus: "success",
      value: activeStatus({ sessionId: "session-2" }),
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(statusCommand, {
      overallStatus: "success",
      value: { ...activeStatus(), phase: "future" },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(eventsCommand, {
      overallStatus: "success",
      value: {
        sessionId: "session-1",
        runId: "run-1",
        items: [event(2), event(1)],
        nextCursor: "opaque",
      },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followCommand, {
      overallStatus: "success",
      value: {
        reason: "terminal",
        status: activeStatus(),
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" },
      },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followCommand, {
      overallStatus: "success",
      value: {
        reason: "events",
        status: activeStatus(),
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" },
      },
      persistence: { status: "read", effect: "none" },
    }),
    projectCliRunOperationOutput(followCommand, {
      overallStatus: "success",
      value: {
        reason: "deadline",
        status: {
          sessionId: "session-1",
          runId: "run-1",
          phase: "completed",
          liveActivity: null,
          createdAt: 1,
          updatedAt: 2,
          terminalAt: 2,
        },
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" },
      },
      persistence: { status: "read", effect: "none" },
    }),
  ];
  for (const result of malformed) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.output.error.code, "malformed_application_response");
  }
});

function activeStatus(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    phase: "active",
    liveActivity: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function event(ordinal: number) {
  return { ordinal, kind: "unknown", createdAt: ordinal };
}
