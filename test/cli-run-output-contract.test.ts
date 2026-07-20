import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CLI_EXIT_CODES,
  type CliRunOutputPayloadUnavailableError,
  type CliValidatedRunCommand,
} from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { projectCliRunOperationOutput } from "../src/cli/run-output.js";

const countsCommand = scopeCommand("output-counts");
const outputsCommand = {
  ...scopeCommand("outputs"),
  category: "operation",
  cursor: "opaque",
  limit: 2,
} as const satisfies CliValidatedRunCommand;
const previewCommand = {
  ...scopeCommand("output-preview"),
  outputItemId: "output-1",
  maxBytes: 65_536,
} as const satisfies CliValidatedRunCommand;
const chunkCommand = {
  ...scopeCommand("output-chunk"),
  outputItemId: "output-1",
  offset: 2,
  maxBytes: 262_144,
} as const satisfies CliValidatedRunCommand;
const destination = path.resolve("export.bin");
const exportCommand = {
  ...scopeCommand("output-export"),
  outputItemId: "output-1",
  destination,
} as const satisfies CliValidatedRunCommand;

// @ts-expect-error only a pending payload is retryable
const invalidCliPermanentPayloadRetry: CliRunOutputPayloadUnavailableError = {
  kind: "domain",
  code: "payload_unavailable",
  message: "Run output payload is unavailable.",
  retryable: true,
  details: { reason: "no_payload" },
};

// @ts-expect-error a pending payload must remain retryable
const invalidCliPendingPayloadRetry: CliRunOutputPayloadUnavailableError = {
  kind: "domain",
  code: "payload_unavailable",
  message: "Run output payload is unavailable.",
  retryable: false,
  details: { reason: "pending" },
};

void invalidCliPermanentPayloadRetry;
void invalidCliPendingPayloadRetry;

test("Run output parser and help expose bounded commands without accepting unsafe destinations", () => {
  assert.match(
    helpText({ kind: "run" }),
    /output-counts[\s\S]*outputs[\s\S]*output-preview[\s\S]*output-chunk[\s\S]*output-export/u,
  );
  assert.match(helpText({ kind: "operation", command: exportCommand.identity }), /never overwritten/u);
  assert.deepEqual(parseCliArgv(["run", "output-counts", "--session-id", "session-1", "--run-id", "run-1"]), {
    kind: "command",
    command: countsCommand,
  });
  assert.deepEqual(
    parseCliArgv([
      "run",
      "outputs",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--category",
      "operation",
      "--cursor",
      "opaque",
      "--limit",
      "2",
    ]),
    { kind: "command", command: outputsCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "output-preview",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "output-1",
    ]),
    { kind: "command", command: previewCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "output-chunk",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "output-1",
      "--offset",
      "2",
      "--max-bytes",
      "262144",
    ]),
    { kind: "command", command: chunkCommand },
  );
  assert.deepEqual(
    parseCliArgv([
      "run",
      "output-export",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "output-1",
      "--destination",
      destination,
    ]),
    { kind: "command", command: exportCommand },
  );

  for (const argv of [
    ["run", "outputs", "--session-id", "session-1", "--run-id", "run-1", "--category", "private"],
    [
      "run",
      "output-preview",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "x",
      "--max-bytes",
      "65537",
    ],
    [
      "run",
      "output-chunk",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "x",
      "--offset",
      "-1",
    ],
    [
      "run",
      "output-export",
      "--session-id",
      "session-1",
      "--run-id",
      "run-1",
      "--output-item-id",
      "x",
      "--destination",
      "relative.bin",
    ],
  ]) {
    assert.equal(parseCliArgv(argv).kind, "usage_failure", argv.join(" "));
  }
});

test("counts and output pages use strict CLI-owned projections without payload identifiers", () => {
  const counts = projectCliRunOperationOutput(
    countsCommand,
    success({
      sessionId: "session-1",
      runId: "run-1",
      totalCount: 1,
      partialCount: 0,
      byCategory: {
        assistant_detail: 0,
        operation: 1,
        interaction: 0,
        telemetry: 0,
        diagnostic: 0,
        provider_metadata: 0,
      },
      workspaceKey: "hidden",
    }),
  );
  assert.equal(counts.ok, true);
  if (!counts.ok) assert.fail("counts projection failed");
  assert.equal(JSON.stringify(counts.output).includes("workspaceKey"), false);

  const page = projectCliRunOperationOutput(outputsCommand, {
    overallStatus: "partial_success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      items: [
        {
          id: "output-1",
          ordinal: 2,
          category: "operation",
          kind: "command",
          summary: "summary",
          completionState: "complete",
          availability: { kind: "stored", originalByteLength: 10, redaction: "applied", storedPayloadId: "hidden" },
          createdAt: 3,
          providerItemId: "hidden",
        },
      ],
      nextCursor: "opaque-next",
    },
    issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 }],
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(page.ok, true);
  if (!page.ok) assert.fail("page projection failed");
  assert.equal(page.exitCode, CLI_EXIT_CODES.partialSuccess);
  assert.equal(JSON.stringify(page.output).includes("storedPayloadId"), false);
  assert.equal(JSON.stringify(page.output).includes("providerItemId"), false);
});

test("preview and chunk preserve bounded source semantics and encode chunk bytes once", () => {
  const source = '{ "escaped": "\\u3042", "number": 1.0 }\n';
  const preview = projectCliRunOperationOutput(
    previewCommand,
    success({
      ...storedMetadata(),
      format: "json",
      preview: source,
      storedByteLength: Buffer.byteLength(source),
      previewByteLength: Buffer.byteLength(source),
      truncated: false,
      bytes: "hidden",
    }),
  );
  assert.equal(preview.ok, true);
  if (!preview.ok) assert.fail("preview projection failed");
  assert.equal(JSON.stringify(preview.output).includes("\\u3042"), true);
  assert.equal(JSON.stringify(preview.output).includes('"bytes"'), false);

  const bytes = Uint8Array.from(Buffer.from("llo", "utf8")).buffer;
  const chunk = projectCliRunOperationOutput(
    chunkCommand,
    success({
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      format: "text",
      offset: 2,
      totalBytes: 5,
      byteLength: 3,
      bytes,
      eof: true,
    }),
  );
  assert.equal(chunk.ok, true);
  if (!chunk.ok) assert.fail("chunk projection failed");
  assert.deepEqual(chunk.output.applicationResponse, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      format: "text",
      offset: 2,
      totalBytes: 5,
      chunk: { encoding: "base64", byteLength: 3, data: Buffer.from("llo").toString("base64") },
      eof: true,
    },
    persistence: { status: "read", effect: "none" },
  });

  const malformed = projectCliRunOperationOutput(
    chunkCommand,
    success({
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      format: "text",
      offset: 2,
      totalBytes: 5,
      byteLength: 4,
      bytes,
      eof: true,
    }),
  );
  assert.equal(malformed.ok, false);
});

test("export projects publication timing without destination paths or OS errors", () => {
  const published = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "success",
    value: { ...storedMetadata(), format: "binary", internalPath: destination },
    publication: { status: "published" },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(published.ok, true);
  if (!published.ok) assert.fail("export projection failed");
  assert.equal(JSON.stringify(published.output).includes(destination), false);
  assert.equal(JSON.stringify(published.output).includes("mediaType"), false);

  const unknown = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
      rawOsError: "hidden",
    },
    publication: { status: "unknown", reconciliation: "inspect_destination_before_retry", path: destination },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(unknown.ok, true);
  if (!unknown.ok) assert.fail("unknown export projection failed");
  assert.equal(unknown.exitCode, CLI_EXIT_CODES.runtimeFailure);
  assert.equal(JSON.stringify(unknown.output).includes(destination), false);

  const existing = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "destination_exists",
      message: "Export destination already exists.",
      retryable: false,
    },
    publication: { status: "not_published", temporaryCleanup: "complete" },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(existing.ok, true);
  if (!existing.ok) assert.fail("existing destination projection failed");
  assert.equal(existing.exitCode, CLI_EXIT_CODES.domainRejected);

  const contradictory = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "destination_exists",
      message: "Export destination already exists.",
      retryable: false,
    },
    publication: { status: "published" },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(contradictory.ok, false);

  const payloadUnavailableAfterRead = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "payload_unavailable",
      message: "Run output payload is unavailable.",
      retryable: false,
      details: { reason: "no_payload" },
    },
    publication: { status: "not_published", temporaryCleanup: "complete" },
    persistence: { status: "read", effect: "none" },
  });
  assert.equal(payloadUnavailableAfterRead.ok, false);

  const destinationExistsBeforeRead = projectCliRunOperationOutput(exportCommand, {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "destination_exists",
      message: "Export destination already exists.",
      retryable: false,
    },
    publication: { status: "not_published", temporaryCleanup: "complete" },
    persistence: { status: "rejected", effect: "none" },
  });
  assert.equal(destinationExistsBeforeRead.ok, false);
});

test("payload availability and binary chunk failures retain bounded typed details", () => {
  const unavailable = projectCliRunOperationOutput(
    previewCommand,
    failure({
      kind: "domain",
      code: "payload_unavailable",
      message: "Run output payload is unavailable.",
      retryable: true,
      details: { reason: "pending", internal: "hidden" },
    }),
  );
  assert.equal(unavailable.ok, true);
  if (!unavailable.ok) assert.fail("unavailable projection failed");
  assert.deepEqual(
    unavailable.output.applicationResponse,
    failure({
      kind: "domain",
      code: "payload_unavailable",
      message: "Run output payload is unavailable.",
      retryable: true,
      details: { reason: "pending" },
    }),
  );

  for (const error of [
    {
      kind: "domain",
      code: "payload_unavailable",
      message: "Run output payload is unavailable.",
      retryable: true,
      details: { reason: "no_payload" },
    },
    {
      kind: "domain",
      code: "payload_unavailable",
      message: "Run output payload is unavailable.",
      retryable: false,
      details: { reason: "pending" },
    },
  ] as const) {
    assert.equal(projectCliRunOperationOutput(previewCommand, failure(error)).ok, false);
  }

  const unsupported = projectCliRunOperationOutput(
    chunkCommand,
    failure({
      kind: "domain",
      code: "payload_format_unsupported",
      message: "Binary Run output payloads must be exported.",
      retryable: false,
      details: { format: "binary", supportedAction: "export", private: "hidden" },
    }),
  );
  assert.equal(unsupported.ok, true);
});

function scopeCommand<
  TOperation extends "output-counts" | "outputs" | "output-preview" | "output-chunk" | "output-export",
>(operation: TOperation) {
  return { identity: { namespace: "run", operation }, sessionId: "session-1", runId: "run-1" } as const;
}

function storedMetadata() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    mediaType: "application/octet-stream",
    storedByteLength: 42,
    contentSha256: "a".repeat(64),
  };
}

function success<TValue>(value: TValue) {
  return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
}

function failure<TError>(error: TError) {
  return { overallStatus: "failure", error, persistence: { status: "rejected", effect: "none" } } as const;
}
