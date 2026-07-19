import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
    const terminal = await writes.completeRun({
      sessionId,
      workspaceKey,
      runId,
      attemptId,
      terminalEvent: { id: "event-run-smoke-terminal", dedupeKey: "run-smoke-terminal" },
      preDispatchResolution: { kind: "binding_creation_not_sent" },
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

  const missing = runJson(["run", "status", "--session-id", sessionId, "--run-id", "missing-run"], environment, 22);
  assert.equal(missing.applicationResponse.error.code, "not_found");

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(fs.existsSync(`${databasePath}${suffix}`), false, `SQLite sidecar remained after Run CLI: ${suffix}`);
  }

  console.log(
    JSON.stringify({
      commands: ["status", "events", "follow"],
      parseRuntimeIsolation: "verified",
      terminalDrain: "verified",
      providerMetadataProjection: "verified",
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
