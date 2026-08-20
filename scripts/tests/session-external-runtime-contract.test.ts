import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
} from "../../src/session-external-runtime-contract.js";
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

test("SESSION-CRUD-SCHEMA-01: session CRUD uses strict normalized inputs", () => {
  const create = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "session.create",
    input: {
      title: "Review session",
      provider: "codex",
      catalogRevision: 4,
      workspace: { kind: "session_folder" },
      idempotencyKey: "create-key-1",
    },
  });
  assert.deepEqual(create.input, {
    title: "Review session",
    provider: "codex",
    catalogRevision: 4,
    workspace: { kind: "session_folder" },
    idempotencyKey: "create-key-1",
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
        title: "Review session",
        provider: "codex",
        catalogRevision: 4,
        workspace: { kind: "session_folder", path: "must-not-pass" },
        idempotencyKey: "create-key-1",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "workspace.path",
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "session.rename",
      input: { sessionId: "session-1", title: "Renamed", idempotencyKey: "key-1", provider: "codex" },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.provider",
  );
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

test("Session runtime validator accepts an explicit deferred turn.run contract", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.run",
    input: {
      sessionId: "session-1",
      catalogRevision: 4,
      idempotencyKey: "key-1",
      responseMode: "deferred",
      turn,
    },
  });
  assert.deepEqual(parsed.input, {
    sessionId: "session-1",
    catalogRevision: 4,
    idempotencyKey: "key-1",
    responseMode: "deferred",
    turn,
  });
});

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
    input: { sessionId: "session-1", catalogRevision: 4, idempotencyKey: "key-2", turn: copilotTurn },
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
        input: { sessionId: "session-1", catalogRevision: 4, idempotencyKey: "key-3", turn: invalidTurn },
      }),
      SessionRuntimeValidationError,
    );
  }
});

test("EXT-ATTACH-10: Turn attachmentsは必須array・最大32・portable relative path・一意kindを要求する", () => {
  const parse = (attachments: unknown) => parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.enqueue",
    input: {
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

test("Session runtime validator rejects unknown fields and enqueue response mode", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.run",
      input: {
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
        sessionId: "session-1",
        catalogRevision: 4,
        idempotencyKey: "key-1",
        responseMode: "wait",
        turn,
      },
    }),
    SessionRuntimeValidationError,
  );
});

test("TN-AUTH-01/TN-PROJ-06: run/enqueueは同じstrict通知inputとpublic state projectionを使う", () => {
  for (const operation of ["turn.run", "turn.enqueue"] as const) {
    const input = {
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

test("ID-02: turn.cancel requires an idempotency key", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.cancel",
      input: { sessionId: "session-1", executionId: "execution-1" },
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
      idempotencyKey: "cancel-key-1",
    },
  });
  assert.deepEqual(parsed.input, {
    sessionId: "session-1",
    executionId: "execution-1",
    idempotencyKey: "cancel-key-1",
  });
});

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
      sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
      response: { kind: "elicitation", action: "accept", content: { count: 2, tags: ["a"] } },
      idempotencyKey: "respond-1", responseMode: "wait", waitTimeoutMs: 500,
    },
  });
  assert.equal((accepted.input as any).response.action, "accept");
  for (const response of [
    { kind: "elicitation", action: "accept" },
    { kind: "elicitation", action: "decline", content: {} },
    { kind: "approval", decision: "approve", content: {} },
  ]) {
    assert.throws(() => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "interaction.respond",
      input: {
        sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
        response, idempotencyKey: "respond-1", responseMode: "deferred",
      },
    }), SessionRuntimeValidationError);
  }
});

test("RL-01: public execution projection rejects inline assistant text over 8 MiB", () => {
  assert.throws(
    () => projectSessionExecution({
      id: "execution-1",
      sessionId: "session-1",
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
  assert.equal(projected.effectiveTurn?.provider, "codex");
});

test("GUI-QUEUE-01: GUI enqueueも外部execution投影でeffective turnを維持する", () => {
  const projected = projectSessionExecution({
    id: "execution-gui",
    sessionId: "session-1",
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
  assert.equal(projected.effectiveTurn?.sandboxMode, "workspace-write");
  assert.deepEqual(projected.attachments, []);
});
