import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
} from "../../src/session-external-runtime-contract.js";
import {
  createSessionRuntimeAdvertisedInputSchema,
  createSessionRuntimeInputSchema,
  parseSessionRuntimeResultEnvelope,
} from "../../src/session-external-runtime-schema.js";
import {
  SESSION_TRANSCRIPT_FOLDER_DEFAULT_MAX_BYTES,
  SESSION_TRANSCRIPT_INLINE_DEFAULT_MAX_BYTES,
} from "../../src/session-transcript.js";
import { projectTerminalFailureNotification } from "../../src/session-terminal-failure-notification.js";

const turn = {
  provider: "codex",
  userMessage: "hello",
  model: "gpt-5.4",
  reasoningEffort: "high",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  attachments: [],
};

test("RUNTIME-CATALOG-01: runtime.catalog accepts only an explicit empty input", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "runtime.catalog",
    input: {},
  });
  assert.deepEqual(parsed.input, {});
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "runtime.catalog",
      input: { revision: 4 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.revision",
  );
});

// @test-value v2
// kind = "contract"
// claim = "budget公開操作はUTC正規化timestampとroot共有storageを二重配分しないstrictな子配分、およびroot管理dimensionを明示するstrict responseだけを受理する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#公開操作候補" }
// fault = "空limitや変更なし、childとpolicy併用、timezoneなしtimestamp、子へのstorage数値、spoof field、または不正responseを受理・広告する"
// observable = "canonical parserとruntime schemaの受理結果、およびadvertised JSON SchemaのminProperties・anyOf・not構造"
// observation_boundary = "public-boundary"
// scope = "Session runtime resource budget request contract"
// lifecycle = "permanent"
// @end-test-value
test("RESOURCE-BUDGET-PUBLIC-01: budget requestをstrictに検証する", () => {
  const get = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.get",
    input: { sessionId: "root-session" },
  });
  assert.deepEqual(get.input, { sessionId: "root-session" });

  const configure = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-session",
      expectedRevision: 1,
      retryPerExecutionLimit: 2,
      idempotencyKey: "budget-configure-retry-limit-1",
    },
  });
  assert.deepEqual(configure.input, {
    sessionId: "root-session",
    accountId: "root-session",
    expectedRevision: 1,
    retryPerExecutionLimit: 2,
    idempotencyKey: "budget-configure-retry-limit-1",
  });

  const childHardLimits = {
    concurrentTurns: 1,
    queuedTurns: 10,
    totalTurns: 100,
    retries: 10,
    sessions: 5,
    workItems: 20,
    delegations: 20,
    storageBytes: 0,
  };
  const childAllocation = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-account",
      expectedRevision: 2,
      childAllocation: {
        accountId: "child-account",
        childSessionId: "child-session",
        hardLimits: childHardLimits,
        softLimits: { totalTurns: 80 },
        expiresAt: "2026-10-01T00:00:00.000Z",
      },
      idempotencyKey: "budget-child-allocation-1",
    },
  });
  assert.deepEqual(childAllocation.input.childAllocation, {
    accountId: "child-account",
    childSessionId: "child-session",
    hardLimits: childHardLimits,
    softLimits: { totalTurns: 80 },
    expiresAt: "2026-10-01T00:00:00.000Z",
  });
  const normalizedTimestamp = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-account",
      expectedRevision: 2,
      deadlineAt: "2026-10-01T09:00:00+09:00",
      idempotencyKey: "budget-deadline-offset",
    },
  });
  assert.equal(normalizedTimestamp.input.deadlineAt, "2026-10-01T00:00:00.000Z");
  const configureInputSchema = createSessionRuntimeInputSchema("budget.configure");
  assert.equal(configureInputSchema.safeParse(childAllocation.input).success, true);
  const configureBase = {
    sessionId: "root-session",
    accountId: "root-account",
    expectedRevision: 2,
    idempotencyKey: "budget-configure-schema-parity",
  };
  for (const invalidInput of [
    configureBase,
    { ...configureBase, hardLimits: {} },
    { ...configureBase, softLimits: {} },
    { ...configureBase, hardLimits: undefined },
    { ...childAllocation.input, softLimits: { totalTurns: 90 } },
    {
      ...childAllocation.input,
      childAllocation: {
        ...childAllocation.input.childAllocation,
        softLimits: { storageBytes: 0 },
      },
    },
    {
      ...childAllocation.input,
      childAllocation: {
        ...childAllocation.input.childAllocation,
        softLimits: { storageBytes: 1 },
      },
    },
  ]) {
    assert.equal(configureInputSchema.safeParse(invalidInput).success, false);
    assert.throws(() => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "budget.configure",
      input: invalidInput,
    }));
  }
  assert.equal(configureInputSchema.safeParse({
    ...childAllocation.input,
    childAllocation: {
      ...childAllocation.input.childAllocation,
      softLimits: { storageBytes: null },
    },
  }).success, true);
  assert.equal(configureInputSchema.safeParse({
    sessionId: "root-session",
    accountId: "root-account",
    expectedRevision: 2,
    deadlineAt: "2026-10-01T09:00:00",
    idempotencyKey: "budget-deadline-without-timezone",
  }).success, false);
  assert.equal(configureInputSchema.safeParse({
    ...childAllocation.input,
    childAllocation: {
      accountId: "child-account",
      childSessionId: "child-session",
      hardLimits: {
        concurrentTurns: 1,
        queuedTurns: 10,
        totalTurns: 100,
        retries: 10,
        sessions: 5,
        workItems: 20,
        delegations: 20,
      },
    },
  }).success, false);
  const advertisedConfigureSchema = z.toJSONSchema(
    createSessionRuntimeAdvertisedInputSchema("budget.configure"),
  ) as Record<string, any>;
  assert.equal(advertisedConfigureSchema.properties.hardLimits.minProperties, 1);
  assert.equal(advertisedConfigureSchema.properties.softLimits.minProperties, 1);
  assert.equal(advertisedConfigureSchema.properties.childAllocation.properties.softLimits.minProperties, 1);
  assert.deepEqual(
    advertisedConfigureSchema.properties.childAllocation.properties.softLimits.properties.storageBytes,
    { type: "null" },
  );
  assert.deepEqual(advertisedConfigureSchema.anyOf, [
    {
      required: ["childAllocation"],
      not: {
        anyOf: ["hardLimits", "softLimits", "deadlineAt", "expiresAt", "revoked", "retryPerExecutionLimit"]
          .map((field) => ({ required: [field] })),
      },
    },
    {
      not: { required: ["childAllocation"] },
      anyOf: ["hardLimits", "softLimits", "deadlineAt", "expiresAt", "revoked", "retryPerExecutionLimit"]
        .map((field) => ({ required: [field] })),
    },
  ]);
  assert.equal(configureInputSchema.safeParse({
    ...childAllocation.input,
    childAllocation: {
      ...childAllocation.input.childAllocation,
      hardLimits: { ...childHardLimits, storageBytes: 1024 },
    },
  }).success, false);
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      ...childAllocation.input,
      childAllocation: {
        ...childAllocation.input.childAllocation,
        hardLimits: { ...childHardLimits, storageBytes: 1024 },
      },
    },
  }), /childAllocation\.hardLimits\.storageBytes must be 0/);
  assert.equal(configureInputSchema.safeParse({
    ...childAllocation.input,
    childAllocation: {
      ...childAllocation.input.childAllocation,
      authorityGrantId: "spoofed",
    },
  }).success, false);
  for (const spoofedField of ["ownerSessionId", "amounts", "authorityGrantId"] as const) {
    assert.throws(() => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "budget.configure",
      input: {
        sessionId: "root-session",
        accountId: "root-account",
        expectedRevision: 2,
        childAllocation: {
          accountId: "child-account",
          childSessionId: "child-session",
          hardLimits: childHardLimits,
          [spoofedField]: "spoofed",
        },
        idempotencyKey: `budget-child-spoof-${spoofedField}`,
      },
    }), new RegExp(`childAllocation contains unexpected fields: ${spoofedField}`));
  }
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-account",
      expectedRevision: 2,
      softLimits: { totalTurns: 900 },
      childAllocation: {
        accountId: "child-account",
        childSessionId: "child-session",
        hardLimits: childHardLimits,
      },
      idempotencyKey: "budget-child-policy-combination",
    },
  }), /childAllocation cannot be combined with account policy changes/);

  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.list",
    input: { sessionId: "root-session", limit: 501 },
  }), /limit must be at most 500/);
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-session",
      expectedRevision: 1,
      idempotencyKey: "budget-configure-1",
      unexpected: true,
    },
  }), /unexpected fields: unexpected/);
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-session",
      expectedRevision: 1,
      idempotencyKey: "budget-configure-1",
    },
  }), /must contain a change/);
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "budget.configure",
    input: {
      sessionId: "root-session",
      accountId: "root-session",
      expectedRevision: 1,
      retryPerExecutionLimit: -1,
      idempotencyKey: "budget-configure-retry-limit-invalid",
    },
  }), /retryPerExecutionLimit must be a non-negative safe integer/);

  const dimension = {
    hardLimit: 10,
    softLimit: null,
    committed: 1,
    reserved: 0,
    allocatedToChildren: 0,
    available: 9,
    softLimitExceeded: false,
    measurement: "known",
    unknownSince: null,
  };
  const dimensions = Object.fromEntries([
    "concurrentTurns", "queuedTurns", "totalTurns", "retries",
    "sessions", "workItems", "delegations", "storageBytes",
  ].map((key) => [key, dimension]));
  const result = {
    contractRevision: 1,
    accountId: "root-session",
    accountKind: "root",
    rootSessionId: "root-session",
    ownerSessionId: "root-session",
    appliesToSessionId: "child-session",
    allocationSource: "root_shared",
    rootManagedDimensions: ["storageBytes"],
    parentAccountId: null,
    authorityGrantId: null,
    authorityGrantRevision: null,
    expiresAt: null,
    revokedAt: null,
    deadlineAt: "2026-10-01T00:00:00.000Z",
    retryPerExecutionLimit: 3,
    revision: 2,
    dimensions,
    alerts: [],
    meteredUsage: [],
    meteredUsageTruncated: true,
    meteredUsageSummary: {
      knownTokens: 123,
      knownProviderUsage: 4,
      monetaryCostByCurrency: { USD: 1.25 },
      unknownRecords: { tokens: 1, monetary_cost: 2, provider_usage: 3 },
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const parsedResult = parseSessionRuntimeResultEnvelope("budget.get", {
    schemaVersion: "withmate-session-result-v2",
    operation: "budget.get",
    result,
  });
  assert.equal(parsedResult.result.allocationSource, "root_shared");
  assert.deepEqual(parsedResult.result.rootManagedDimensions, ["storageBytes"]);
  assert.equal(parsedResult.result.dimensions.storageBytes.measurement, "known");
  assert.equal(parsedResult.result.meteredUsageTruncated, true);
  assert.deepEqual(parsedResult.result.meteredUsageSummary.unknownRecords,
    { tokens: 1, monetary_cost: 2, provider_usage: 3 });
  const missingRootManagedDimensions: Record<string, unknown> = { ...result };
  delete missingRootManagedDimensions.rootManagedDimensions;
  assert.throws(() => parseSessionRuntimeResultEnvelope("budget.get", {
    schemaVersion: "withmate-session-result-v2",
    operation: "budget.get",
    result: missingRootManagedDimensions,
  }));
  assert.throws(() => parseSessionRuntimeResultEnvelope("budget.get", {
    schemaVersion: "withmate-session-result-v2",
    operation: "budget.get",
    result: { ...result, privateState: "hidden" },
  }));
});

test("SESSION-SELF-01: session.selfはcaller指定のSession targetを受け付けない", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.self",
    input: {},
  });
  assert.deepEqual(parsed.input, {});
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.self",
      input: { sessionId: "forged-session" },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.sessionId",
  );
});

test("EXT-TRANSCRIPT-13: transcript.export normalizes inline and SessionFolder destinations", () => {
  const inline = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "transcript.export",
    input: { sessionId: " session-1 ", format: "json", maxBytes: 1024, destination: { kind: "inline" } },
  });
  assert.deepEqual(inline.input, {
    sessionId: "session-1",
    format: "json",
    maxBytes: 1024,
    destination: { kind: "inline" },
  });
  const folder = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "transcript.export",
    input: {
      sessionId: "session-1",
      format: "markdown",
      maxBytes: 2048,
      destination: { kind: "session_folder", relativePath: "exports/transcript.md", replace: false, idempotencyKey: "export-1" },
    },
  });
  assert.deepEqual(folder.input, {
    sessionId: "session-1",
    format: "markdown",
    maxBytes: 2048,
    destination: { kind: "session_folder", relativePath: "exports/transcript.md", replace: false, idempotencyKey: "export-1" },
  });

  const inlineDefault = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "transcript.export",
    input: { sessionId: "session-1", format: "json", destination: { kind: "inline" } },
  });
  assert.equal(inlineDefault.input.maxBytes, SESSION_TRANSCRIPT_INLINE_DEFAULT_MAX_BYTES);
  const folderDefault = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "transcript.export",
    input: {
      sessionId: "session-1",
      format: "markdown",
      destination: { kind: "session_folder", relativePath: "exports/transcript.md", idempotencyKey: "export-2" },
    },
  });
  assert.equal(folderDefault.input.maxBytes, SESSION_TRANSCRIPT_FOLDER_DEFAULT_MAX_BYTES);
});

// @test-value v1
// kind = "contract"
// claim = "session createとrenameはcurrent revisionを明示するstrict inputへ正規化される"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
// failure_mode = "revision未指定のmutationがlost update検出を迂回する、または未知fieldがstorageへ到達する"
// scope = "Session Runtime session mutation parser"
// lifecycle = "permanent"
// @end-test-value
test("SESSION-CRUD-SCHEMA-01: session CRUD uses strict normalized inputs", () => {
  const create = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.create",
    input: {
      expectedContainerRevision: 3,
      title: "Review session",
      sessionRole: "task-coordinator",
      provider: "codex",
      catalogRevision: 4,
      workspace: { kind: "session_folder" },
      idempotencyKey: "create-key-1",
    },
  });
  assert.deepEqual(create.input, {
    expectedContainerRevision: 3,
    title: "Review session",
    sessionRole: "task-coordinator",
    provider: "codex",
    catalogRevision: 4,
    workspace: { kind: "session_folder" },
    idempotencyKey: "create-key-1",
  });
  const rename = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.rename",
    input: {
      expectedRevision: 7,
      sessionId: "session-1",
      title: "Renamed",
      idempotencyKey: "rename-key-1",
    },
  });
  assert.deepEqual(rename.input, {
    expectedRevision: 7,
    sessionId: "session-1",
    title: "Renamed",
    idempotencyKey: "rename-key-1",
  });

  const list = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.list",
    input: {},
  });
  assert.deepEqual(list.input, { limit: 50 });

  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.create",
      input: {
        expectedContainerRevision: 3,
        title: "Review session",
        sessionRole: "task-coordinator",
        provider: "codex",
        catalogRevision: 4,
        workspace: { kind: "session_folder", path: "must-not-pass" },
        idempotencyKey: "create-key-1",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "workspace.path",
  );
  for (const forbiddenField of [
    "actorSessionId",
    "parentSessionId",
    "rootSessionId",
    "delegationDepth",
    "characterId",
  ]) {
    assert.throws(
      () => parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation: "session.create",
        input: {
          title: "Review session",
          sessionRole: "executor",
          provider: "codex",
          catalogRevision: 4,
          workspace: { kind: "session_folder" },
          idempotencyKey: "create-key-1",
          [forbiddenField]: "forged",
        },
      }),
      (error) => error instanceof SessionRuntimeValidationError
        && error.details.field === `input.${forbiddenField}`,
    );
  }
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.rename",
      input: { sessionId: "session-1", title: "Renamed", idempotencyKey: "key-1", provider: "codex" },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.provider",
  );
});

// @test-value v1
// kind = "contract"
// claim = "work.createはtarget Sessionのcurrent revisionをexpectedContainerRevisionとして要求し保持する"
// oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
// failure_mode = "revisionなしのWork Item createがstale target Sessionへ書き込む"
// scope = "Session Runtime work.create input parser"
// lifecycle = "permanent"
// @end-test-value
test("WORK-CREATE-REVISION: work.create uses the target Session revision", () => {
  const input = {
    expectedContainerRevision: 4,
    targetSessionId: "session-target",
    goal: "Implement the change",
    scope: "target module",
    completionCriteria: "tests pass",
    authority: "workspace edits",
    sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
    idempotencyKey: "work-create-revision",
  };
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "work.create",
    input,
  });
  assert.deepEqual(parsed.input, input);
  assert.throws(() => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "work.create",
    input: { ...input, expectedContainerRevision: undefined },
  }), (error) => error instanceof SessionRuntimeValidationError
    && error.details.field === "expectedContainerRevision");
});

test("SF-ADAPTER-01: Session file operations normalize shared public inputs", () => {
  const list = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.files.list",
    input: { sessionId: " session-1 " },
  });
  assert.deepEqual(list.input, { sessionId: "session-1", limit: 50 });

  const read = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.files.read_text",
    input: { sessionId: "session-1", relativePath: " notes/brief.md " },
  });
  assert.deepEqual(read.input, {
    sessionId: "session-1",
    relativePath: "notes/brief.md",
    maxBytes: SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  });

  const write = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.files.write_text",
    input: {
      sessionId: "session-1",
      relativePath: "notes/brief.md",
      content: "hello",
      idempotencyKey: "write-1",
    },
  });
  assert.deepEqual(write.input, {
    sessionId: "session-1",
    relativePath: "notes/brief.md",
    content: "hello",
    maxBytes: SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
    replace: false,
    idempotencyKey: "write-1",
  });
});

test("SF-LIMIT-01: Session file text inputs reject byte limit violations without truncation", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.files.write_text",
      input: {
        sessionId: "session-1",
        relativePath: "brief.md",
        content: "éé",
        maxBytes: 3,
        idempotencyKey: "write-1",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError
      && error.code === "CONTENT_TOO_LARGE"
      && error.details.actualBytes === 4,
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.files.read_text",
      input: { sessionId: "session-1", relativePath: "brief.md", maxBytes: 8 * 1024 * 1024 + 1 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.code === "LIMIT_EXCEEDED",
  );
});

test("TURN-OPTIONS-SCHEMA-01: turn.options accepts only an explicit Session identifier", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.options",
    input: { sessionId: " session-1 " },
  });
  assert.deepEqual(parsed.input, { sessionId: "session-1" });

  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.options",
      input: { sessionId: "session-1", catalogRevision: 4 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.catalogRevision",
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.options",
      input: { sessionId: "   " },
    }),
    SessionRuntimeValidationError,
  );
});

// @test-value v1
// kind = "contract"
// claim = "turn.runはtarget Sessionのcurrent revisionをexpectedContainerRevisionとして要求し保持する"
// oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
// failure_mode = "revisionなしのexecution createがstale target Sessionへ書き込む"
// scope = "Session Runtime turn.run input parser"
// lifecycle = "permanent"
// @end-test-value
test("Session runtime validator accepts an explicit deferred turn.run contract", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.run",
    input: {
      expectedContainerRevision: 3,
      sessionId: "session-1",
      catalogRevision: 4,
      idempotencyKey: "key-1",
      responseMode: "deferred",
      turn,
    },
  });
  assert.deepEqual(parsed.input, {
    expectedContainerRevision: 3,
    sessionId: "session-1",
    catalogRevision: 4,
    idempotencyKey: "key-1",
    responseMode: "deferred",
    turn,
  });
});

// @test-value v1
// kind = "contract"
// claim = "turn.enqueueはtarget Session revisionを保持したままprovider固有fieldをexact unionとして検証する"
// oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
// failure_mode = "container revisionの追加でprovider discriminator検証が迂回される"
// scope = "Session Runtime provider-specific enqueue parser"
// lifecycle = "permanent"
// @end-test-value
test("EXT-PROVIDER-02: provider固有Turn fieldをexact unionとして検証する", () => {
  const copilotTurn = {
    provider: "copilot",
    userMessage: "hello",
    model: "claude-sonnet",
    reasoningEffort: "high",
    approvalMode: "on-request",
    customAgentName: "reviewer",
    attachments: [],
  };
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.enqueue",
    input: { expectedContainerRevision: 3, sessionId: "session-1", catalogRevision: 4, idempotencyKey: "key-2", turn: copilotTurn },
  });
  assert.deepEqual((parsed.input as { turn: unknown }).turn, copilotTurn);

  for (const invalidTurn of [
    { ...turn, customAgentName: "reviewer" },
    { ...copilotTurn, codexSandboxMode: "workspace-write" },
    { ...copilotTurn, provider: "unknown" },
  ]) {
    assert.throws(
      () => parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation: "turn.enqueue",
        input: { expectedContainerRevision: 3, sessionId: "session-1", catalogRevision: 4, idempotencyKey: "key-3", turn: invalidTurn },
      }),
      SessionRuntimeValidationError,
    );
  }
});

// @test-value v1
// kind = "security"
// claim = "revision付きturn.enqueueでもattachment path、上限、identity unionをcanonical validatorで拒否する"
// oracle = { type = "contract", ref = "EXT-ATTACH-10/AUTONOMY-MUTATION-05" }
// failure_mode = "container revision追加後にattachment validationが欠落fieldで短絡し不正pathを検証しない"
// scope = "Session Runtime enqueue attachment parser"
// lifecycle = "permanent"
// @end-test-value
test("EXT-ATTACH-10: Turn attachmentsは必須array・最大32・portable relative path・一意kindを要求する", () => {
  const parse = (attachments: unknown) => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.enqueue",
    input: {
      expectedContainerRevision: 3,
      sessionId: "session-1",
      catalogRevision: 4,
      idempotencyKey: "attachment-key",
      turn: { ...turn, attachments },
    },
  });
  assert.deepEqual(
    ((parse([{ kind: "image", relativePath: "images/example.png" }]).input as any).turn.attachments),
    [{ kind: "image", relativePath: "images/example.png" }],
  );
  for (const attachments of [
    undefined,
    Array.from({ length: 33 }, (_, index) => ({ kind: "file", relativePath: `file-${index}.txt` })),
    [{ kind: "file", relativePath: "/absolute.txt" }],
    [{ kind: "file", relativePath: "../outside.txt" }],
    [{ kind: "file", relativePath: "." }],
    [{ kind: "file", relativePath: "same.txt" }, { kind: "image", relativePath: "SAME.TXT" }],
    [{ kind: "unknown", relativePath: "file.txt" }],
  ]) {
    assert.throws(() => parse(attachments), SessionRuntimeValidationError);
  }
});

// @test-value v1
// kind = "security"
// claim = "revision付きTurn parserは未知のauthority fieldとenqueue固有でないresponse modeを副作用前に拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
// failure_mode = "revision追加によりexact input検証が緩みcaller指定authorityまたはrun専用fieldをenqueueへ通す"
// scope = "Session Runtime strict Turn input parser"
// lifecycle = "permanent"
// @end-test-value
test("Session runtime validator rejects unknown fields and enqueue response mode", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.run",
      input: {
        expectedContainerRevision: 3,
        sessionId: "session-1",
        catalogRevision: 4,
        idempotencyKey: "key-1",
        responseMode: "deferred",
        turn,
        apiSecret: "must-not-pass",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.apiSecret",
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.enqueue",
      input: {
        expectedContainerRevision: 3,
        sessionId: "session-1",
        catalogRevision: 4,
        idempotencyKey: "key-1",
        responseMode: "wait",
        turn,
      },
    }),
    SessionRuntimeValidationError,
  );
  for (const [field, value] of [
    ["sessionRole", "overall-coordinator"],
    ["rootSessionId", "spoofed-root"],
    ["parentSessionId", "spoofed-parent"],
    ["delegationDepth", 0],
  ] as const) {
    assert.throws(
      () => parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation: "turn.run",
        input: {
          expectedContainerRevision: 3,
          sessionId: "session-1",
          catalogRevision: 4,
          idempotencyKey: `spoof-${field}`,
          responseMode: "deferred",
          turn,
          [field]: value,
        },
      }),
      (error) => error instanceof SessionRuntimeValidationError && error.details.field === `input.${field}`,
    );
  }
});

// @test-value v1
// kind = "contract"
// claim = "run/enqueueはtarget revisionを含む同じstrict通知inputとrevision付きpublic execution projectionを使う"
// oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05/TN-PROJ-06" }
// failure_mode = "operation間でcontainer revisionかexecution revisionが欠落し通知付きTurnの公開契約が分岐する"
// scope = "Session Runtime Turn input and execution projection"
// lifecycle = "permanent"
// @end-test-value
test("TN-AUTH-01/TN-PROJ-06: run/enqueueは同じstrict通知inputとpublic state projectionを使う", () => {
  for (const operation of ["turn.run", "turn.enqueue"] as const) {
    const input = {
      expectedContainerRevision: 3,
      sessionId: "source-session",
      catalogRevision: 4,
      idempotencyKey: `${operation}-key`,
      ...(operation === "turn.run" ? { responseMode: "deferred" as const } : {}),
      terminalFailureNotification: { targetSessionId: "target-session" },
      turn,
    };
    const parsed = parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation,
      input,
    });
    assert.deepEqual((parsed.input as any).terminalFailureNotification, { targetSessionId: "target-session" });
    assert.throws(() => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation,
      input: { ...input, terminalFailureNotification: { targetSessionId: "target-session", characterId: "spoof" } },
    }), SessionRuntimeValidationError);
  }

  const execution = {
    id: "execution-1",
    revision: 2,
    sessionId: "source-session",
    operation: "turn.run" as const,
    state: "failed" as const,
    result: null,
    errorCode: "PROVIDER_FAILURE",
    reason: "session_runtime_failed",
    createdAt: "2026-08-18T00:00:00.000Z",
    admittedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:01:00.000Z",
    updatedAt: "2026-08-18T00:01:00.000Z",
  };
  assert.equal(projectTerminalFailureNotification({
    execution,
    targetSessionId: "target-session",
    delivery: null,
  })?.state, "pending");
  assert.deepEqual(projectTerminalFailureNotification({
    execution,
    targetSessionId: "target-session",
    delivery: {
      state: "enqueued",
      notificationExecutionId: "notification-execution",
      errorCode: null,
      updatedAt: "2026-08-18T00:01:02.000Z",
    },
  }), {
    targetSessionId: "target-session",
    state: "enqueued",
    notificationExecutionId: "notification-execution",
    errorCode: null,
    updatedAt: "2026-08-18T00:01:02.000Z",
  });
});

test("Session runtime list limit is rejected instead of clamped", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.list",
      input: { sessionId: "session-1", limit: 501 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.code === "LIMIT_EXCEEDED",
  );
});

test("AGG-QUERY-05: aggregation list limit超過はLIMIT_EXCEEDEDで拒否する", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "work.aggregation.list",
      input: { parentWorkItemId: "work-parent", limit: 201 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.code === "LIMIT_EXCEEDED",
  );
});

// @test-value v1
// kind = "contract"
// claim = "turn.cancelはtarget executionのcurrent revisionとcaller-owned idempotency keyを要求し保持する"
// oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
// failure_mode = "revisionなしのcancelがstale executionを変更するか、retry identityを失う"
// scope = "Session Runtime turn.cancel input parser"
// lifecycle = "permanent"
// @end-test-value
test("ID-02: turn.cancel requires revision and an idempotency key", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.cancel",
      input: { sessionId: "session-1", executionId: "execution-1", idempotencyKey: "cancel-key-missing-revision" },
    }),
    (error) => error instanceof SessionRuntimeValidationError
      && error.details.field === "expectedRevision",
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.cancel",
      input: { sessionId: "session-1", executionId: "execution-1", expectedRevision: 2 },
    }),
    (error) => error instanceof SessionRuntimeValidationError
      && error.details.field === "idempotencyKey",
  );
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.cancel",
    input: {
      sessionId: "session-1",
      executionId: "execution-1",
      expectedRevision: 2,
      idempotencyKey: "cancel-key-1",
    },
  });
  assert.deepEqual(parsed.input, {
    sessionId: "session-1",
    executionId: "execution-1",
    expectedRevision: 2,
    idempotencyKey: "cancel-key-1",
  });
});

// @test-value v1
// kind = "contract"
// claim = "interaction responseはexpected revisionとresponse kind別exact unionを必須にする"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/09-agent-visible-interactions.md" }
// failure_mode = "stale interaction responseがlost updateを起こす、またはkind外fieldをprovider responseへ渡す"
// scope = "Session Runtime interaction parser"
// lifecycle = "permanent"
// @end-test-value
test("EXT-INTERACTION-11: interaction operationsはfilter bindingとexact response unionを検証する", () => {
  const listed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "interaction.list",
    input: { sessionId: "session-1", executionId: "execution-1", kind: "elicitation", state: "pending" },
  });
  assert.deepEqual(listed.input, {
    sessionId: "session-1", executionId: "execution-1", kind: "elicitation", state: "pending", limit: 50,
  });
  const accepted = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "interaction.respond",
    input: {
      expectedRevision: 2,
      sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
      response: { kind: "elicitation", action: "accept", content: { count: 2, tags: ["a"] } },
      idempotencyKey: "respond-1", responseMode: "wait", waitTimeoutMs: 500,
    },
  });
  assert.equal((accepted.input as any).expectedRevision, 2);
  assert.equal((accepted.input as any).response.action, "accept");
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "interaction.respond",
      input: {
        sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
        response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1", responseMode: "deferred",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "expectedRevision",
  );
  for (const response of [
    { kind: "elicitation", action: "accept" },
    { kind: "elicitation", action: "decline", content: {} },
    { kind: "approval", decision: "approve", content: {} },
  ]) {
    assert.throws(() => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "interaction.respond",
      input: {
        expectedRevision: 2,
        sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
        response, idempotencyKey: "respond-1", responseMode: "deferred",
      },
    }), SessionRuntimeValidationError);
  }
});

// @test-value v1
// kind = "contract"
// claim = "revision付きpublic execution projectionは8 MiBを超えるassistant textをstable resource identity付きで拒否する"
// oracle = { type = "contract", ref = "docs/design/session-external-runtime.md" }
// failure_mode = "execution revision追加後にresponse byte上限を迂回するか、limit errorからsession/execution identityを失う"
// scope = "Session Runtime public execution projection limit"
// lifecycle = "permanent"
// @end-test-value
test("RL-01: public execution projection rejects inline assistant text over 8 MiB", () => {
  assert.throws(
    () => projectSessionExecution({
      id: "execution-1",
      sessionId: "session-1",
      revision: 2,
      operation: "turn.run",
      state: "completed",
      result: { assistantText: "a".repeat(SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES + 1) },
      errorCode: "",
      reason: "",
      createdAt: "2026-08-11T00:00:00.000Z",
      admittedAt: "2026-08-11T00:00:00.000Z",
      completedAt: "2026-08-11T00:00:01.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
    }),
    (error) => error instanceof SessionRuntimeValidationError
      && error.code === "CONTENT_TOO_LARGE"
      && error.details.sessionId === "session-1"
      && error.details.executionId === "execution-1",
  );
});

// @test-value v1
// kind = "security"
// claim = "revision付きenqueueでもprivate attachment identityをwire inputとpublic execution projectionの双方から除外する"
// oracle = { type = "contract", ref = "docs/design/session-external-runtime.md" }
// failure_mode = "container revision追加時にprivate filesystem identityを受理または公開してSession境界を漏らす"
// scope = "Session Runtime attachment ingress and public projection"
// lifecycle = "permanent"
// @end-test-value
test("EXT-ATTACH-10: admitted attachment identityは公開投影から除外しwire ingressはstrictのまま維持する", () => {
  const attachmentWithIdentity = {
    kind: "file",
    relativePath: "brief.md",
    identity: {
      rootDevice: 1,
      rootInode: 2,
      device: 3,
      inode: 4,
      canonicalRelativePath: "brief.md",
    },
  };
  const request = {
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.enqueue",
    input: {
      expectedContainerRevision: 3,
      sessionId: "session-1",
      catalogRevision: 4,
      idempotencyKey: "attachment-identity",
      turn: { ...turn, attachments: [attachmentWithIdentity] },
    },
  };
  assert.throws(() => parseSessionRuntimeRequestEnvelope(request), SessionRuntimeValidationError);

  const projected = projectSessionExecution({
    id: "execution-attachment",
    sessionId: "session-1",
    revision: 2,
    operation: "turn.enqueue",
    state: "running",
    result: null,
    errorCode: "",
    reason: "",
    createdAt: "2026-08-11T00:00:00.000Z",
    admittedAt: "2026-08-11T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-11T00:00:00.000Z",
  }, { request: request.input });

  assert.deepEqual(projected.attachments, [{ kind: "file", relativePath: "brief.md" }]);
  assert.equal(projected.revision, 2);
  assert.equal(projected.effectiveTurn?.provider, "codex");
});

// @test-value v1
// kind = "contract"
// claim = "GUI enqueueのpublic execution projectionもstorage由来revisionとeffective turnを保持する"
// oracle = { type = "contract", ref = "docs/design/session-external-runtime.md" }
// failure_mode = "外部mutationだけrevisionを公開しGUI enqueueのexecution projectionが競合制御に使えない"
// scope = "Session Runtime GUI execution projection"
// lifecycle = "permanent"
// @end-test-value
test("GUI-QUEUE-01: GUI enqueueも外部execution投影でeffective turnを維持する", () => {
  const projected = projectSessionExecution({
    id: "execution-gui",
    sessionId: "session-1",
    revision: 1,
    operation: "turn.enqueue",
    state: "queued",
    result: null,
    errorCode: "",
    reason: "",
    createdAt: "2026-08-16T00:00:00.000Z",
    admittedAt: "2026-08-16T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-16T00:00:00.000Z",
  }, {
    request: {
      source: "gui",
      turn: {
        userMessage: "queued from GUI",
        model: "gpt-5.4",
        reasoningEffort: "high",
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write",
        attachments: [],
      },
    },
  });

  assert.equal(projected.effectiveTurn?.provider, "codex");
  assert.equal(projected.revision, 1);
  assert.equal(projected.effectiveTurn?.sandboxMode, "workspace-write");
  assert.deepEqual(projected.attachments, []);
});
