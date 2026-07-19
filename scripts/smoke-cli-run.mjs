import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { PersistenceWorkerClient } from "../dist/main/persistence-worker-client.js";
import { RepositoryReadClient } from "../dist/main/repository-read-client.js";
import { RepositoryWriteClient } from "../dist/main/repository-write-client.js";

const root = process.cwd();
const entryPath = path.join(root, "dist", "cli", "entry.js");
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-cli-run-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const environment = isolatedEnvironment(appDataRoot);
const databasePath = expectedDatabasePath(appDataRoot);
const sessionCreateKey = "018f1f4e-7f0a-7000-8000-000000000501";
const runAdmitKey = "018f1f4e-7f0a-7000-8000-000000000502";
const runId = "run-smoke-1";
const attemptId = "attempt-run-smoke-1";
const outputItemId = "output-run-smoke-1";
const binaryOutputItemId = "output-run-smoke-binary-1";
const outputSource = '{ "escaped": "\\u3042", "number": 1.0 }\n';
const outputBytes = new TextEncoder().encode(outputSource);
const binaryOutputBytes = Uint8Array.from([0, 1, 2, 127, 128, 255, 10]);
const binaryOutputSha256 = createHash("sha256").update(binaryOutputBytes).digest("hex");
const exportPath = path.join(tempDirectory, "exported-output.bin");
const timedOutExportPath = path.join(tempDirectory, "timed-out-output.bin");

fs.mkdirSync(workspacePath, { recursive: true });

try {
  const runHelp = invoke(["run", "--help"], environment);
  assert.equal(runHelp.status, 0);
  assert.match(runHelp.stdout, /^Usage: withmate run/u);
  const invalid = invoke(["run", "status", "--session-id", "missing-run-id"], environment);
  assert.equal(invalid.status, 20);
  assert.equal(parseJsonOutput(invalid).kind, "usage_failure");
  assert.equal(fs.existsSync(path.dirname(databasePath)), false, "Run help or parse failure started persistence");

  const created = runJson(
    [
      "session",
      "create",
      "--title",
      "Run smoke Session",
      "--workspace",
      workspacePath,
      "--idempotency-key",
      sessionCreateKey,
      "--provider",
      "codex",
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "1",
    ],
    environment,
    0,
  );
  const sessionId = created.applicationResponse.value.sessionId;
  const worker = new PersistenceWorkerClient({ databasePath, legacyDatabasePaths: [] });
  await worker.start();
  try {
    const reads = new RepositoryReadClient(worker);
    const writes = new RepositoryWriteClient(worker);
    const session = await reads.sessionGet({ sessionId });
    const workspaceKey = session.session.workspaceKey;
    const admission = await writes.admitNormalRun({
      sessionId,
      workspaceKey,
      idempotencyKey: runAdmitKey,
      message: { id: "message-run-smoke-1", contentBlocks: [{ type: "text", text: "observe me" }] },
      run: {
        id: runId,
        executionSnapshot: {
          providerId: "codex",
          model: "smoke-model",
          reasoning: { effort: "medium" },
          approval: { mode: "on-request" },
          sandbox: { mode: "workspace-write" },
          workspace: { key: workspaceKey },
          character: null,
        },
      },
      attemptId,
      bindingIntent: { kind: "create", bindingId: "binding-run-smoke-1", persistenceMode: "persistent" },
      dispatch: { providerRequest: { prompt: "observe me" }, providerIdempotencyKey: null },
    });
    assert.equal(admission.ok, true);
    const binding = await writes.resolveProviderBinding({
      sessionId,
      workspaceKey,
      runId,
      attemptId,
      bindingId: "binding-run-smoke-1",
      resolution: {
        kind: "active",
        externalConversationId: "conversation-run-smoke-1",
        ephemeralOwnerToken: null,
      },
    });
    assert.equal(binding.ok, true);
    const dispatch = await writes.beginRunDispatch({
      sessionId,
      workspaceKey,
      runId,
      attemptId,
      bindingId: "binding-run-smoke-1",
      providerRequest: { prompt: "observe me" },
      ephemeralOwnerToken: null,
    });
    assert.equal(dispatch.ok, true);
    const dispatchResolution = await writes.resolveRunDispatch({
      sessionId,
      workspaceKey,
      runId,
      attemptId,
      bindingId: "binding-run-smoke-1",
      ephemeralOwnerToken: null,
      outcome: { kind: "accepted", externalExecutionId: "execution-run-smoke-1" },
    });
    assert.equal(dispatchResolution.ok, true);
    const appended = await writes.appendRunOutput({
      sessionId,
      workspaceKey,
      runId,
      item: {
        id: outputItemId,
        category: "diagnostic",
        kind: "trace",
        providerItemId: "provider-output-must-not-leak",
        summary: "smoke output",
        completionState: "complete",
        payload: {
          state: "stored",
          originalByteLength: outputBytes.byteLength,
          redactionState: "not_required",
          payloadFormat: "json",
          mediaType: "application/json",
          content: outputBytes,
        },
      },
    });
    assert.equal(appended.ok, true);
    const binaryAppended = await writes.appendRunOutput({
      sessionId,
      workspaceKey,
      runId,
      item: {
        id: binaryOutputItemId,
        category: "diagnostic",
        kind: "artifact",
        providerItemId: "provider-binary-output-must-not-leak",
        summary: "smoke binary output",
        completionState: "complete",
        payload: {
          state: "stored",
          originalByteLength: binaryOutputBytes.byteLength,
          redactionState: "not_required",
          payloadFormat: "binary",
          mediaType: "application/octet-stream",
          content: binaryOutputBytes,
        },
      },
    });
    assert.equal(binaryAppended.ok, true);
    const terminal = await writes.completeRun({
      sessionId,
      workspaceKey,
      runId,
      attemptId,
      terminalEvent: { id: "event-run-smoke-terminal", dedupeKey: "run-smoke-terminal" },
      preDispatchResolution: { kind: "not_applicable" },
      outcome: {
        kind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: "must-not-leak",
        errorSummary: "Provider dispatch was not started.",
      },
      outputs: [],
      childResult: null,
    });
    assert.equal(terminal.ok, true);
  } finally {
    const shutdown = await worker.shutdown();
    assert.equal(shutdown.checkpoint, "completed");
  }

  const status = runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], environment, 0);
  assert.equal(status.applicationResponse.value.phase, "interrupted");
  assert.equal(status.applicationResponse.value.failure.origin, "transport");
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);

  const events = runJson(
    ["run", "events", "--session-id", sessionId, "--run-id", runId, "--limit", "10"],
    environment,
    0,
  );
  assert.deepEqual(
    events.applicationResponse.value.items.map((event) => event.kind),
    ["run_terminal"],
  );
  const cursor = events.applicationResponse.value.nextCursor;
  assert.equal(typeof cursor, "string");
  const tail = runJson(
    ["run", "events", "--session-id", sessionId, "--run-id", runId, "--cursor", cursor],
    environment,
    0,
  );
  assert.deepEqual(tail.applicationResponse.value.items, []);
  assert.equal(tail.applicationResponse.value.nextCursor, cursor);

  const follow = runJson(
    ["run", "follow", "--session-id", sessionId, "--run-id", runId, "--wait-ms", "100", "--poll-ms", "25"],
    environment,
    0,
  );
  assert.equal(follow.applicationResponse.value.reason, "terminal");
  assert.equal(follow.applicationResponse.value.status.phase, "interrupted");
  assert.deepEqual(
    follow.applicationResponse.value.events.items.map((event) => event.kind),
    ["run_terminal"],
  );

  const outputCounts = runJson(["run", "output-counts", "--session-id", sessionId, "--run-id", runId], environment, 0);
  assert.equal(outputCounts.applicationResponse.value.totalCount, 2);
  assert.equal(outputCounts.applicationResponse.value.byCategory.diagnostic, 2);

  const outputs = runJson(
    ["run", "outputs", "--session-id", sessionId, "--run-id", runId, "--category", "diagnostic"],
    environment,
    0,
  );
  assert.equal(outputs.applicationResponse.value.items.length, 2);
  assert.equal(outputs.applicationResponse.value.items[0].id, outputItemId);
  assert.equal(outputs.applicationResponse.value.items[0].availability.kind, "stored");
  assert.equal(JSON.stringify(outputs).includes("provider-output-must-not-leak"), false);
  assert.equal(JSON.stringify(outputs).includes("storedPayloadId"), false);

  const preview = runJson(
    ["run", "output-preview", "--session-id", sessionId, "--run-id", runId, "--output-item-id", outputItemId],
    environment,
    0,
  );
  assert.equal(preview.applicationResponse.value.format, "json");
  assert.equal(preview.applicationResponse.value.preview, outputSource);
  assert.equal(preview.applicationResponse.value.truncated, false);

  const chunkMaxBytes = 7;
  const chunks = [];
  let chunkOffset = 0;
  for (;;) {
    const chunk = runJson(
      [
        "run",
        "output-chunk",
        "--session-id",
        sessionId,
        "--run-id",
        runId,
        "--output-item-id",
        outputItemId,
        "--offset",
        String(chunkOffset),
        "--max-bytes",
        String(chunkMaxBytes),
      ],
      environment,
      0,
    );
    const value = chunk.applicationResponse.value;
    assert.equal(value.offset, chunkOffset);
    assert.equal(value.chunk.encoding, "base64");
    const decoded = Buffer.from(value.chunk.data, "base64");
    assert.equal(decoded.byteLength, value.chunk.byteLength);
    chunks.push(decoded);
    if (value.eof) break;
    assert.equal(value.nextOffset, chunkOffset + decoded.byteLength);
    chunkOffset = value.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(outputBytes));

  const binaryPreview = runJson(
    ["run", "output-preview", "--session-id", sessionId, "--run-id", runId, "--output-item-id", binaryOutputItemId],
    environment,
    0,
  );
  assert.equal(binaryPreview.applicationResponse.value.format, "binary");
  assert.equal(binaryPreview.applicationResponse.value.storedByteLength, binaryOutputBytes.byteLength);
  assert.equal(binaryPreview.applicationResponse.value.contentSha256, binaryOutputSha256);
  assert.equal("preview" in binaryPreview.applicationResponse.value, false);

  runJson(
    [
      "run",
      "output-export",
      "--session-id",
      sessionId,
      "--run-id",
      runId,
      "--output-item-id",
      binaryOutputItemId,
      "--destination",
      timedOutExportPath,
      "--timeout-ms",
      "1",
    ],
    environment,
    40,
  );
  assert.equal(fs.existsSync(timedOutExportPath), false);
  assert.deepEqual(
    fs.readdirSync(tempDirectory).filter((entry) => entry.includes(".withmate-output-")),
    [],
  );

  const exported = runJson(
    [
      "run",
      "output-export",
      "--session-id",
      sessionId,
      "--run-id",
      runId,
      "--output-item-id",
      binaryOutputItemId,
      "--destination",
      exportPath,
    ],
    environment,
    0,
  );
  assert.equal(exported.applicationResponse.publication.status, "published");
  assert.equal(exported.applicationResponse.value.storedByteLength, binaryOutputBytes.byteLength);
  assert.equal(exported.applicationResponse.value.contentSha256, binaryOutputSha256);
  assert.deepEqual(fs.readFileSync(exportPath), Buffer.from(binaryOutputBytes));
  assert.equal(JSON.stringify(exported).includes(exportPath), false);
  const existingDestination = runJson(
    [
      "run",
      "output-export",
      "--session-id",
      sessionId,
      "--run-id",
      runId,
      "--output-item-id",
      binaryOutputItemId,
      "--destination",
      exportPath,
    ],
    environment,
    22,
  );
  assert.equal(existingDestination.applicationResponse.error.code, "destination_exists");
  assert.deepEqual(fs.readFileSync(exportPath), Buffer.from(binaryOutputBytes));
  assert.deepEqual(
    fs.readdirSync(tempDirectory).filter((entry) => entry.includes(".withmate-output-")),
    [],
  );

  const missing = runJson(["run", "status", "--session-id", sessionId, "--run-id", "missing-run"], environment, 22);
  assert.equal(missing.applicationResponse.error.code, "not_found");

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(fs.existsSync(`${databasePath}${suffix}`), false, `SQLite sidecar remained after Run CLI: ${suffix}`);
  }

  console.log(
    JSON.stringify({
      commands: [
        "status",
        "events",
        "follow",
        "output-counts",
        "outputs",
        "output-preview",
        "output-chunk",
        "output-export",
      ],
      parseRuntimeIsolation: "verified",
      terminalDrain: "verified",
      providerMetadataProjection: "verified",
      runOutputControlPlane: "verified",
      exportNoClobber: "verified",
      sqliteSidecars: "none",
    }),
  );
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function runJson(args, childEnvironment, expectedStatus) {
  const result = invoke(args, childEnvironment);
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return parseJsonOutput(result);
}

function invoke(args, childEnvironment) {
  const result = spawnSync(process.execPath, [entryPath, ...args], {
    cwd: root,
    env: childEnvironment,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `${args.join(" ")} failed to spawn`);
  assert.notEqual(result.status, null, `${args.join(" ")} did not exit`);
  return result;
}

function parseJsonOutput(result) {
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.slice(0, -1).includes("\n"), false);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed;
}

function isolatedEnvironment(appRoot) {
  return {
    ...process.env,
    ...(process.platform === "win32"
      ? { APPDATA: appRoot }
      : process.platform === "darwin"
        ? { HOME: appRoot }
        : { XDG_CONFIG_HOME: appRoot }),
  };
}

function expectedDatabasePath(appRoot) {
  const dataRoot = process.platform === "darwin" ? path.join(appRoot, "Library", "Application Support") : appRoot;
  return path.join(dataRoot, "WithMate", "withmate.sqlite3");
}
