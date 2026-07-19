import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliRunStatusValue,
  type CliValidatedRunCommand,
} from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { projectCliRunOperationOutput } from "../src/cli/run-output.js";

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

test("Run help and validated commands are runtime-free parser results", () => {
  assert.deepEqual(parseCliArgv(["run"]), { kind: "help", topic: { kind: "run" } });
  assert.deepEqual(parseCliArgv(["run", "events", "--help"]), {
    kind: "help",
    topic: { kind: "operation", command: { namespace: "run", operation: "events" } },
  });
  assert.match(helpText({ kind: "root" }), /withmate run --help/u);
  assert.match(helpText({ kind: "run" }), /status[\s\S]*events[\s\S]*follow/u);
  assert.doesNotMatch(helpText({ kind: "run" }), /\bstart\b|\bretry\b|\bcancel\b/u);

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

test("Run parser rejects missing, duplicate, unknown, unbounded, and mutation inputs", () => {
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
    ["run", "cancel"],
  ] as const;
  for (const argv of cases) {
    const parsed = parseCliArgv(argv);
    assert.equal(parsed.kind, "usage_failure", argv.join(" "));
    if (parsed.kind === "usage_failure") assert.equal(parsed.exitCode, CLI_EXIT_CODES.usageInvalid);
  }
});

test("Run status output uses a phase-specific allowlist and preserves schema v1", () => {
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
      failure: { origin: "provider", summary, providerErrorCode: "hidden" },
      executionSnapshot: "hidden",
      version: 4,
    },
    persistence: { status: "read", effect: "none", workerId: "hidden" },
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
