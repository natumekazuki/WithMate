import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { projectCliOperationOutput, serializeCliStructuredOutput } from "../src/cli/application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliOperationOutput,
  type CliSessionDetail,
  type CliSessionListItem,
  type CliSessionOperation,
  type CliStructuredOutput,
  type CliValidatedCommand,
} from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { WORKSPACE_PATH_MAX_LENGTH } from "../src/shared/workspace-path.js";

const uuid = "018f1f4e-7f0a-7000-8000-000000000001";
const workspacePath = path.resolve("workspace-1");
const otherWorkspacePath = path.resolve("workspace-2");
const additionalDirectory = path.resolve("workspace-shared");
const oversizedWorkspacePath = path.join(path.parse(workspacePath).root, "w".repeat(WORKSPACE_PATH_MAX_LENGTH));
const localRepositoryKey = `local-repository-v1-sha256-${"a".repeat(64)}`;

const commands = {
  create: {
    identity: { namespace: "session", operation: "create" },
    title: "Session title",
    workspacePath,
    idempotencyKey: uuid,
    providerId: "codex",
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
  },
  list: { identity: { namespace: "session", operation: "list" }, limit: 25 },
  rename: {
    identity: { namespace: "session", operation: "rename" },
    sessionId: "session-1",
    title: "Renamed",
    idempotencyKey: uuid,
  },
  repositories: { identity: { namespace: "session", operation: "repositories" }, limit: 25 },
  read: { identity: { namespace: "session", operation: "read" }, sessionId: "session-1" },
  "directories-chunk": {
    identity: { namespace: "session", operation: "directories-chunk" },
    sessionId: "session-1",
    offset: 4,
    maxBytes: 4,
  },
  archive: {
    identity: { namespace: "session", operation: "archive" },
    sessionId: "session-1",
    idempotencyKey: uuid,
  },
  unarchive: {
    identity: { namespace: "session", operation: "unarchive" },
    sessionId: "session-1",
    idempotencyKey: uuid,
  },
  close: {
    identity: { namespace: "session", operation: "close" },
    sessionId: "session-1",
    idempotencyKey: uuid,
    expectedLifecycleStatus: "active",
  },
} as const satisfies Readonly<Record<CliSessionOperation, CliValidatedCommand>>;

const invalidCreatePersistence: CliOperationOutput<"create"> = {
  schemaVersion: CLI_SCHEMA_VERSION,
  kind: "operation",
  command: { namespace: "session", operation: "create" },
  applicationResponse: {
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
    // @ts-expect-error create success cannot report read persistence
    persistence: { status: "read", effect: "none" },
  },
};
const invalidUnknownEffect: CliOperationOutput<"archive"> = {
  schemaVersion: CLI_SCHEMA_VERSION,
  kind: "operation",
  command: { namespace: "session", operation: "archive" },
  applicationResponse: {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: "persistence_unavailable",
      message: "unavailable",
      retryable: true,
      effect: "unknown",
    },
    // @ts-expect-error unknown write effects require exact-request reconciliation
    persistence: { status: "failed", effect: "unknown" },
  },
};
const invalidArchiveLifecycle: CliOperationOutput<"archive"> = {
  schemaVersion: CLI_SCHEMA_VERSION,
  kind: "operation",
  command: { namespace: "session", operation: "archive" },
  applicationResponse: {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      // @ts-expect-error archive success must expose archived lifecycle state
      lifecycleStatus: "active",
      updatedAt: 1,
    },
    persistence: { status: "committed", effect: "none", replayed: false },
  },
};
const invalidUsageOutput: CliStructuredOutput = {
  schemaVersion: CLI_SCHEMA_VERSION,
  kind: "usage_failure",
  command: null,
  error: { kind: "usage", code: "unknown_command", message: "unknown" },
  // @ts-expect-error usage failures cannot contain an Application response
  applicationResponse: {},
};
// @ts-expect-error local repository metadata must be both present or both null
const invalidCliListRepositoryPair: CliSessionListItem = {
  id: "session-1",
  title: "Session title",
  workspacePath,
  localRepositoryKey,
  repositoryName: null,
  defaultCharacterId: "character-1",
  lifecycleStatus: "active",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  stateChangedAt: 1,
  executionState: "not_started",
};
// @ts-expect-error local repository metadata must be both present or both null
const invalidCliDetailRepositoryPair: CliSessionDetail = {
  id: "session-1",
  title: "Session title",
  providerId: "codex",
  workspacePath,
  localRepositoryKey: null,
  repositoryName: "WithMate",
  allowedAdditionalDirectoriesByteLength: 2,
  allowedAdditionalDirectoriesState: "inline",
  defaultCharacterId: "character-1",
  maxConcurrentChildRuns: 2,
  lifecycleStatus: "active",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
};
void invalidCreatePersistence;
void invalidUnknownEffect;
void invalidArchiveLifecycle;
void invalidUsageOutput;
void invalidCliListRepositoryPair;
void invalidCliDetailRepositoryPair;

test("help and version parsing are runtime-free actions", () => {
  assert.deepEqual(parseCliArgv([]), { kind: "help", topic: { kind: "root" } });
  assert.deepEqual(parseCliArgv(["session"]), { kind: "help", topic: { kind: "session" } });
  assert.deepEqual(parseCliArgv(["session", "read", "--help"]), {
    kind: "help",
    topic: { kind: "operation", command: { namespace: "session", operation: "read" } },
  });
  assert.deepEqual(parseCliArgv(["--version"]), { kind: "version" });
  assert.match(helpText({ kind: "root" }), /withmate session --help/u);
  const sessionHelp = helpText({ kind: "session" });
  for (const operation of ["create", "list", "read", "directories-chunk", "archive", "unarchive", "close"]) {
    assert.match(sessionHelp, new RegExp(`\\b${operation}\\b`, "u"));
  }
});

test("create requires caller-owned idempotency and accepts repeatable absolute directories", () => {
  const parsed = parseCliArgv([
    "session",
    "create",
    "--title",
    "  Session title  ",
    "--workspace",
    workspacePath,
    "--idempotency-key",
    uuid,
    "--provider",
    "codex",
    "--additional-directory",
    additionalDirectory,
    "--additional-directory",
    workspacePath,
    "--default-character",
    "character-1",
    "--max-concurrent-child-runs",
    "2",
    "--timeout-ms",
    "5000",
  ]);

  assert.deepEqual(parsed, {
    kind: "command",
    command: {
      identity: { namespace: "session", operation: "create" },
      title: "Session title",
      workspacePath,
      idempotencyKey: uuid,
      providerId: "codex",
      allowedAdditionalDirectories: [additionalDirectory, workspacePath],
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 2,
      timeoutMs: 5000,
    },
  });
});

test("create rejects additional-directory counts above the Application request limit", () => {
  const repeatedDirectories = Array.from({ length: 1_025 }, (_, index) => [
    "--additional-directory",
    path.resolve(`directory-${index}`),
  ]).flat();
  const result = parseCliArgv([
    "session",
    "create",
    "--title",
    "Session title",
    "--workspace",
    workspacePath,
    "--idempotency-key",
    "018f1f4e-7f0a-7000-8000-000000000091",
    "--provider",
    "codex",
    ...repeatedDirectories,
    "--default-character",
    "character-1",
    "--max-concurrent-child-runs",
    "1",
  ]);

  assert.equal(result.kind, "usage_failure");
  assert.equal(result.kind === "usage_failure" && result.output.error.code, "invalid_option_value");
});

test("create accepts zero as the Application child Run capacity", () => {
  const parsed = parseCliArgv([
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
    "0",
  ]);

  assert.deepEqual(parsed, {
    kind: "command",
    command: {
      identity: { namespace: "session", operation: "create" },
      title: "Session title",
      workspacePath,
      idempotencyKey: uuid,
      providerId: "codex",
      allowedAdditionalDirectories: [],
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 0,
    },
  });
  assert.match(helpText({ kind: "operation", command: { namespace: "session", operation: "create" } }), /0\.\.1024/u);
});

test("create requires one bounded non-empty title", () => {
  const requiredOptions = [
    "--workspace",
    workspacePath,
    "--idempotency-key",
    uuid,
    "--provider",
    "codex",
    "--default-character",
    "character-1",
    "--max-concurrent-child-runs",
    "1",
  ];
  const cases = [
    { argv: ["session", "create", ...requiredOptions], code: "missing_option" },
    { argv: ["session", "create", "--title", "   ", ...requiredOptions], code: "invalid_option_value" },
    {
      argv: ["session", "create", "--title", "x".repeat(513), ...requiredOptions],
      code: "invalid_option_value",
    },
    {
      argv: ["session", "create", "--title", "one", "--title", "two", ...requiredOptions],
      code: "duplicate_option",
    },
  ];

  for (const candidate of cases) {
    const result = parseCliArgv(candidate.argv);
    assert.equal(result.kind, "usage_failure");
    assert.equal(result.kind === "usage_failure" && result.output.error.code, candidate.code);
  }
});

test("Workspace is optional for list and absent from direct Session commands", () => {
  assert.deepEqual(parseCliArgv(["session", "list", "--limit", "25"]), {
    kind: "command",
    command: { identity: { namespace: "session", operation: "list" }, limit: 25 },
  });
  assert.deepEqual(parseCliArgv(["session", "list", "--workspace", workspacePath]), {
    kind: "command",
    command: { identity: { namespace: "session", operation: "list" }, workspacePath, limit: 25 },
  });
  assert.deepEqual(parseCliArgv(["session", "read", "--session-id", "session-1"]), {
    kind: "command",
    command: { identity: { namespace: "session", operation: "read" }, sessionId: "session-1" },
  });
  const directWithWorkspace = parseCliArgv([
    "session",
    "read",
    "--session-id",
    "session-1",
    "--workspace",
    workspacePath,
  ]);
  assert.equal(directWithWorkspace.kind, "usage_failure");
  assert.equal(directWithWorkspace.kind === "usage_failure" && directWithWorkspace.output.error.code, "unknown_option");
});

test("all Session operation argv map to validated transport commands", () => {
  assert.equal(
    parseCliArgv(["session", "directories-chunk", "--session-id", "session-1", "--offset", "0", "--max-bytes", "1024"])
      .kind,
    "command",
  );
  for (const operation of ["archive", "unarchive"] as const) {
    assert.deepEqual(parseCliArgv(["session", operation, "--session-id", "session-1", "--idempotency-key", uuid]), {
      kind: "command",
      command: { identity: { namespace: "session", operation }, sessionId: "session-1", idempotencyKey: uuid },
    });
  }
  assert.deepEqual(
    parseCliArgv([
      "session",
      "close",
      "--session-id",
      "session-1",
      "--idempotency-key",
      uuid,
      "--expected-lifecycle-status",
      "archived",
    ]),
    {
      kind: "command",
      command: {
        identity: { namespace: "session", operation: "close" },
        sessionId: "session-1",
        idempotencyKey: uuid,
        expectedLifecycleStatus: "archived",
      },
    },
  );
});

test("invalid argv has one stable usage classification and never falls back to defaults", () => {
  const cases: readonly Readonly<{ argv: readonly string[]; code: string; command: string | null }>[] = [
    { argv: ["other"], code: "unknown_command", command: null },
    { argv: ["session", "other"], code: "unknown_command", command: null },
    { argv: ["session", "list", "--unknown", "value"], code: "unknown_option", command: "list" },
    { argv: ["session", "read", "session-1"], code: "unexpected_argument", command: "read" },
    { argv: ["session", "read", "--session-id"], code: "missing_option", command: "read" },
    { argv: ["session", "read", "--session-id", "a", "--session-id", "b"], code: "duplicate_option", command: "read" },
    { argv: ["session", "read", "--session-id", ""], code: "invalid_option_value", command: "read" },
    {
      argv: ["session", "archive", "--session-id", "s", "--idempotency-key", uuid.toUpperCase()],
      code: "invalid_option_value",
      command: "archive",
    },
    { argv: ["session", "list", "--limit", "0"], code: "invalid_option_value", command: "list" },
    { argv: ["session", "list", "--limit", "01"], code: "invalid_option_value", command: "list" },
    { argv: ["session", "list", "--limit", "Infinity"], code: "invalid_option_value", command: "list" },
    { argv: ["session", "list", "--lifecycle-status", "open"], code: "invalid_option_value", command: "list" },
    { argv: ["session", "list", "--cursor", ""], code: "invalid_option_value", command: "list" },
    {
      argv: ["session", "list", "--workspace", oversizedWorkspacePath],
      code: "invalid_option_value",
      command: "list",
    },
    {
      argv: [
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
        "1025",
      ],
      code: "invalid_option_value",
      command: "create",
    },
    {
      argv: ["session", "read", "--session-id", "s", "--timeout-ms", "0"],
      code: "invalid_option_value",
      command: "read",
    },
    {
      argv: ["session", "directories-chunk", "--session-id", "s", "--offset", "-1", "--max-bytes", "1"],
      code: "invalid_option_value",
      command: "directories-chunk",
    },
    {
      argv: ["session", "directories-chunk", "--session-id", "s", "--offset", "0", "--max-bytes", "262145"],
      code: "invalid_option_value",
      command: "directories-chunk",
    },
    {
      argv: [
        "session",
        "close",
        "--session-id",
        "s",
        "--idempotency-key",
        uuid,
        "--expected-lifecycle-status",
        "closed",
      ],
      code: "invalid_option_value",
      command: "close",
    },
  ];
  for (const candidate of cases) {
    const result = parseCliArgv(candidate.argv);
    assert.equal(result.kind, "usage_failure", candidate.argv.join(" "));
    if (result.kind !== "usage_failure") assert.fail("expected usage failure");
    assert.equal(result.exitCode, CLI_EXIT_CODES.usageInvalid);
    assert.equal(result.output.schemaVersion, CLI_SCHEMA_VERSION);
    assert.equal(result.output.error.code, candidate.code);
    assert.equal(result.output.command?.operation ?? null, candidate.command);
  }
});

test("Application success is explicitly projected without internal fields", () => {
  const result = projectCliOperationOutput(commands.create, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      title: "Session title",
      workspacePath,
      localRepositoryKey: null,
      repositoryName: null,
      lifecycleStatus: "active",
      createdAt: 1,
      internalSecret: "hidden",
    },
    persistence: { status: "committed", effect: "none", replayed: false, workerId: "hidden" },
    internalSecret: "hidden",
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("projection failed");
  assert.equal(result.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(result.output, {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "operation",
    command: { namespace: "session", operation: "create" },
    applicationResponse: {
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
      persistence: { status: "committed", effect: "none", replayed: false },
    },
  });
  assert.equal(serializeCliStructuredOutput(result.output).includes("internalSecret"), false);
});

test("Repository identity metadata is projected only as an atomic valid pair", () => {
  const malformedResponses = [
    {
      command: commands.create,
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          title: "Session title",
          workspacePath,
          localRepositoryKey,
          repositoryName: null,
          lifecycleStatus: "active",
          createdAt: 1,
        },
        persistence: { status: "committed", effect: "none", replayed: false },
      },
    },
    {
      command: commands.list,
      response: {
        overallStatus: "success",
        value: { items: [{ ...listItem(), localRepositoryKey: null, repositoryName: "WithMate" }] },
        persistence: { status: "read", effect: "none" },
      },
    },
    {
      command: commands.read,
      response: {
        overallStatus: "success",
        value: {
          ...readValue("session-1"),
          session: {
            ...readValue("session-1").session,
            localRepositoryKey: "invalid",
            repositoryName: "WithMate",
          },
        },
        persistence: { status: "read", effect: "none" },
      },
    },
  ];

  for (const candidate of malformedResponses) {
    const result = projectCliOperationOutput(candidate.command, candidate.response);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("Session read preserves bounded Application child Run capacity", () => {
  const value = readValue("session-1");
  const result = projectCliOperationOutput(commands.read, {
    overallStatus: "success",
    value: { ...value, session: { ...value.session, maxConcurrentChildRuns: 0 } },
    persistence: { status: "read", effect: "none" },
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("projection failed");
  const output = result.output as CliOperationOutput<"read">;
  assert.equal(output.applicationResponse.overallStatus, "success");
  if (output.applicationResponse.overallStatus !== "success") assert.fail("read failed");
  assert.equal(output.applicationResponse.value.session.maxConcurrentChildRuns, 0);

  const overLimit = projectCliOperationOutput(commands.read, {
    overallStatus: "success",
    value: { ...value, session: { ...value.session, maxConcurrentChildRuns: 1_025 } },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(overLimit.ok, false);
  assert.equal(!overLimit.ok && overLimit.output.error.code, "malformed_application_response");
});

test("Workspace request correlation uses host path identity", () => {
  const equivalentWorkspacePath = process.platform === "win32" ? workspacePath.toUpperCase() : workspacePath;
  const createResult = projectCliOperationOutput(
    { ...commands.create, workspacePath: equivalentWorkspacePath },
    {
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
      persistence: { status: "committed", effect: "none", replayed: true },
    },
  );
  const listResult = projectCliOperationOutput(
    { ...commands.list, workspacePath: equivalentWorkspacePath },
    {
      overallStatus: "success",
      value: { items: [listItem()] },
      persistence: { status: "read", effect: "none" },
    },
  );

  assert.equal(createResult.ok, true);
  assert.equal(listResult.ok, true);
});

test("oversized Workspace paths in Application fulfillments are never projected as success", () => {
  const cases = [
    {
      command: { ...commands.create, workspacePath: oversizedWorkspacePath },
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          title: "Session title",
          workspacePath: oversizedWorkspacePath,
          localRepositoryKey: null,
          repositoryName: null,
          lifecycleStatus: "active",
          createdAt: 1,
        },
        persistence: { status: "committed", effect: "none", replayed: false },
      },
    },
    {
      command: commands.list,
      response: {
        overallStatus: "success",
        value: { items: [{ ...listItem(), workspacePath: oversizedWorkspacePath }] },
        persistence: { status: "read", effect: "none" },
      },
    },
    {
      command: commands.read,
      response: {
        overallStatus: "success",
        value: {
          ...readValue("session-1"),
          session: { ...readValue("session-1").session, workspacePath: oversizedWorkspacePath },
        },
        persistence: { status: "read", effect: "none" },
      },
    },
  ];

  for (const candidate of cases) {
    const result = projectCliOperationOutput(candidate.command as CliValidatedCommand, candidate.response);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("bounded list omissions remain partial success with exit code 10", () => {
  const result = projectCliOperationOutput(commands.list, {
    overallStatus: "partial_success",
    value: { items: [listItem()], nextCursor: "cursor-1" },
    issues: [{ kind: "omission", code: "response_size_limit", message: "omitted" }],
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(result.ok && result.exitCode, CLI_EXIT_CODES.partialSuccess);
  assert.deepEqual(result.ok && result.output.applicationResponse, {
    overallStatus: "partial_success",
    value: { items: [listItem()], nextCursor: "cursor-1" },
    issues: [{ kind: "omission", code: "response_size_limit", message: "omitted" }],
    persistence: { status: "read", effect: "none" },
  });
});

test("directory chunks have a stable base64 representation with explicit byte metadata", () => {
  const bytes = Uint8Array.from([0, 1, 2, 255]).buffer;
  const result = projectCliOperationOutput(commands["directories-chunk"], {
    overallStatus: "success",
    value: { sessionId: "session-1", offset: 4, totalBytes: 8, eof: true, bytes },
    persistence: { status: "read", effect: "none" },
  });
  assert.deepEqual(result.ok && result.output.applicationResponse, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      offset: 4,
      totalBytes: 8,
      eof: true,
      chunk: { encoding: "base64", byteLength: 4, data: "AAEC/w==" },
    },
    persistence: { status: "read", effect: "none" },
  });
});

test("every Application failure family maps to a stable nonzero exit code", () => {
  const failures: readonly Readonly<{ operation: "read" | "archive"; response: unknown; exitCode: number }>[] = [
    {
      operation: "read",
      response: failure(
        { kind: "request", code: "request_invalid", message: "invalid", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.usageInvalid,
    },
    {
      operation: "read",
      response: failure(
        { kind: "access", code: "forbidden", message: "denied", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.accessRejected,
    },
    {
      operation: "read",
      response: failure(
        { kind: "domain", code: "not_found", message: "missing", retryable: false },
        { status: "rejected", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.domainRejected,
    },
    {
      operation: "read",
      response: failure(
        { kind: "persistence", code: "persistence_unavailable", message: "down", retryable: true, effect: "none" },
        { status: "failed", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.persistenceFailedNoEffect,
    },
    {
      operation: "read",
      response: failure(
        { kind: "persistence", code: "persistence_timeout", message: "timeout", retryable: true, effect: "none" },
        { status: "failed", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.timeout,
    },
    {
      operation: "read",
      response: failure(
        { kind: "persistence", code: "persistence_canceled", message: "canceled", retryable: false, effect: "none" },
        { status: "failed", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.canceled,
    },
    {
      operation: "archive",
      response: failure(
        { kind: "persistence", code: "persistence_unavailable", message: "down", retryable: true, effect: "unknown" },
        { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
      ),
      exitCode: CLI_EXIT_CODES.persistenceFailedUnknownEffect,
    },
    {
      operation: "archive",
      response: failure(
        { kind: "persistence", code: "persistence_timeout", message: "timeout", retryable: true, effect: "unknown" },
        { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
      ),
      exitCode: CLI_EXIT_CODES.timeout,
    },
    {
      operation: "archive",
      response: failure(
        { kind: "persistence", code: "persistence_canceled", message: "canceled", retryable: false, effect: "unknown" },
        { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
      ),
      exitCode: CLI_EXIT_CODES.canceled,
    },
    {
      operation: "read",
      response: failure(
        { kind: "operation", code: "operation_timeout", message: "timeout", retryable: true },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.timeout,
    },
    {
      operation: "read",
      response: failure(
        { kind: "operation", code: "operation_canceled", message: "canceled", retryable: false },
        { status: "not_attempted", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.canceled,
    },
    {
      operation: "read",
      response: failure(
        { kind: "application", code: "internal_error", message: "internal", retryable: false },
        { status: "failed", effect: "none" },
      ),
      exitCode: CLI_EXIT_CODES.runtimeFailure,
    },
  ];
  for (const candidate of failures) {
    const result = projectCliOperationOutput(commands[candidate.operation], candidate.response);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, candidate.exitCode);
    assert.deepEqual(result.ok && result.output.applicationResponse, candidate.response);
  }
});

test("write partial success preserves unknown effect and exact-request reconciliation", () => {
  const persistenceIssue = {
    kind: "persistence",
    code: "persistence_timeout",
    message: "commit response was lost",
    retryable: true,
    effect: "unknown",
  } as const;
  const result = projectCliOperationOutput(commands.archive, {
    overallStatus: "partial_success",
    value: { sessionId: "session-1", lifecycleStatus: "archived", updatedAt: 2 },
    issues: [persistenceIssue],
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  });
  assert.equal(result.ok && result.exitCode, CLI_EXIT_CODES.partialSuccess);
  assert.deepEqual(result.ok && result.output.applicationResponse, {
    overallStatus: "partial_success",
    value: { sessionId: "session-1", lifecycleStatus: "archived", updatedAt: 2 },
    issues: [persistenceIssue],
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  });
});

test("transition success is correlated with the requested operation", () => {
  const invalidTransitions = [
    { operation: "archive", lifecycleStatus: "active" },
    { operation: "unarchive", lifecycleStatus: "closed" },
    { operation: "close", lifecycleStatus: "archived" },
  ] as const;
  for (const candidate of invalidTransitions) {
    const result = projectCliOperationOutput(commands[candidate.operation], {
      overallStatus: "success",
      value: { sessionId: "session-1", lifecycleStatus: candidate.lifecycleStatus, updatedAt: 1 },
      persistence: { status: "committed", effect: "none", replayed: false },
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("Application fulfillment is correlated with the validated request scope", () => {
  const successPersistence = { status: "read", effect: "none" } as const;
  const committedPersistence = { status: "committed", effect: "none", replayed: false } as const;
  const cases: readonly Readonly<{ command: CliValidatedCommand; response: unknown }>[] = [
    {
      command: commands.create,
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          title: "Session title",
          workspacePath: otherWorkspacePath,
          localRepositoryKey: null,
          repositoryName: null,
          lifecycleStatus: "active",
          createdAt: 1,
        },
        persistence: committedPersistence,
      },
    },
    {
      command: commands.read,
      response: {
        overallStatus: "success",
        value: readValue("session-2"),
        persistence: successPersistence,
      },
    },
    {
      command: commands["directories-chunk"],
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-2",
          offset: 4,
          totalBytes: 8,
          eof: true,
          bytes: Uint8Array.from([0, 1, 2, 3]).buffer,
        },
        persistence: successPersistence,
      },
    },
    {
      command: commands["directories-chunk"],
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          offset: 3,
          totalBytes: 7,
          eof: true,
          bytes: Uint8Array.from([0, 1, 2, 3]).buffer,
        },
        persistence: successPersistence,
      },
    },
    {
      command: commands["directories-chunk"],
      response: {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          offset: 4,
          totalBytes: 9,
          eof: true,
          bytes: Uint8Array.from([0, 1, 2, 3, 4]).buffer,
        },
        persistence: successPersistence,
      },
    },
    {
      command: commands.archive,
      response: {
        overallStatus: "success",
        value: { sessionId: "session-2", lifecycleStatus: "archived", updatedAt: 2 },
        persistence: committedPersistence,
      },
    },
    {
      command: { ...commands.list, workspacePath, limit: 1 },
      response: {
        overallStatus: "success",
        value: { items: [{ ...listItem(), workspacePath: otherWorkspacePath }] },
        persistence: successPersistence,
      },
    },
    {
      command: { ...commands.list, lifecycleStatus: "archived", limit: 1 },
      response: {
        overallStatus: "success",
        value: { items: [listItem()] },
        persistence: successPersistence,
      },
    },
    {
      command: { ...commands.list, limit: 1 },
      response: {
        overallStatus: "partial_success",
        value: { items: [listItem()] },
        issues: [{ kind: "omission", code: "response_size_limit", message: "omitted" }],
        persistence: successPersistence,
      },
    },
  ];

  for (const candidate of cases) {
    const result = projectCliOperationOutput(candidate.command, candidate.response);
    assert.equal(result.ok, false, candidate.command.identity.operation);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("sparse and oversized response arrays cannot be serialized as valid results", () => {
  const sparseItems = new Array(1);
  const sparseIssues = new Array(1);
  const responses = [
    {
      overallStatus: "success",
      value: { items: sparseItems },
      persistence: { status: "read", effect: "none" },
    },
    {
      overallStatus: "partial_success",
      value: { items: [] },
      issues: sparseIssues,
      persistence: { status: "read", effect: "none" },
    },
    {
      overallStatus: "success",
      value: { items: Array.from({ length: 101 }, () => listItem()) },
      persistence: { status: "read", effect: "none" },
    },
  ];
  for (const response of responses) {
    const result = projectCliOperationOutput(commands.list, response);
    assert.equal(result.ok, false);
  }
});

test("response arrays are snapshotted before their elements are projected", () => {
  const mutatingItems = [listItem(), listItem()];
  Object.defineProperty(mutatingItems, 0, {
    get() {
      delete mutatingItems[1];
      return listItem();
    },
  });
  const omission = { kind: "omission", code: "response_size_limit", message: "omitted" };
  const mutatingIssues = [omission, omission];
  Object.defineProperty(mutatingIssues, 0, {
    get() {
      delete mutatingIssues[1];
      return omission;
    },
  });
  const responses = [
    {
      overallStatus: "success",
      value: { items: mutatingItems },
      persistence: { status: "read", effect: "none" },
    },
    {
      overallStatus: "partial_success",
      value: { items: [] },
      issues: mutatingIssues,
      persistence: { status: "read", effect: "none" },
    },
  ];

  for (const response of responses) {
    const result = projectCliOperationOutput(commands.list, response);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("partial persistence issues validate retryability before projection", () => {
  const result = projectCliOperationOutput(commands.archive, {
    overallStatus: "partial_success",
    value: { sessionId: "session-1", lifecycleStatus: "archived", updatedAt: 2 },
    issues: [
      {
        kind: "persistence",
        code: "persistence_timeout",
        message: "timeout",
        retryable: "yes",
        effect: "unknown",
      },
    ],
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
});

test("malformed Application fulfillment is never projected as success", () => {
  const malformedResponses = [
    {
      overallStatus: "success",
      value: { sessionId: "session-1", lifecycleStatus: "archived", updatedAt: 1 },
      persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
    },
    {
      overallStatus: "failure",
      error: {
        kind: "persistence",
        code: "persistence_unavailable",
        message: "down",
        retryable: true,
        effect: "unknown",
      },
      persistence: { status: "failed", effect: "none" },
    },
    Object.defineProperty({}, "overallStatus", {
      get() {
        throw new Error("getter failure");
      },
    }),
  ];
  for (const response of malformedResponses) {
    const result = projectCliOperationOutput(commands.archive, response);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
    assert.equal(!result.ok && result.output.error.code, "malformed_application_response");
  }
});

test("structured serialization emits exactly one newline-terminated JSON object", () => {
  const result = parseCliArgv(["unknown"]);
  assert.equal(result.kind, "usage_failure");
  if (result.kind !== "usage_failure") assert.fail("expected usage failure");
  const serialized = serializeCliStructuredOutput(result.output);
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.slice(0, -1).includes("\n"), false);
  assert.deepEqual(JSON.parse(serialized), result.output);
});

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

function readValue(sessionId: string) {
  return {
    session: {
      id: sessionId,
      title: `Session ${sessionId}`,
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
