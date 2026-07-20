import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const entryPath = path.join(root, "dist", "cli", "entry.js");
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-cli-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const secondWorkspacePath = path.join(tempDirectory, "workspace-2");
const additionalDirectoryParent = path.join(tempDirectory, "allowed-parent");
const nestedRegularFile = path.join(additionalDirectoryParent, "not-a-directory.txt");
const environment = isolatedEnvironment(appDataRoot);
const databasePath = expectedDatabasePath(appDataRoot);
const applicationDirectory = path.dirname(databasePath);
const createKey = "018f1f4e-7f0a-7000-8000-000000000001";
const secondCreateKey = "018f1f4e-7f0a-7000-8000-000000000005";
const unavailableWorkspaceKey = "018f1f4e-7f0a-7000-8000-000000000006";
const invalidAdditionalDirectoryKey = "018f1f4e-7f0a-7000-8000-000000000007";
const archiveKey = "018f1f4e-7f0a-7000-8000-000000000002";
const unarchiveKey = "018f1f4e-7f0a-7000-8000-000000000003";
const closeKey = "018f1f4e-7f0a-7000-8000-000000000004";
const renameKey = "018f1f4e-7f0a-7000-8000-000000000008";
const deleteKey = "018f1f4e-7f0a-7000-8000-000000000009";

fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(secondWorkspacePath, { recursive: true });
fs.mkdirSync(additionalDirectoryParent, { recursive: true });
fs.writeFileSync(nestedRegularFile, "not a directory");

try {
  const help = invoke(["--help"], environment);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: withmate/u);
  const invalid = invoke(["session", "read"], environment);
  assert.equal(invalid.status, 20);
  assert.equal(parseJsonOutput(invalid).kind, "usage_failure");
  const unconfirmedDelete = invoke(
    ["session", "delete", "--session-id", "session-1", "--idempotency-key", deleteKey],
    environment,
  );
  assert.equal(unconfirmedDelete.status, 20);
  assert.equal(parseJsonOutput(unconfirmedDelete).kind, "usage_failure");
  assert.equal(fs.existsSync(applicationDirectory), false, "help or parse failure started application persistence");

  const createArgs = [
    "session",
    "create",
    "--title",
    "Primary Session",
    "--workspace",
    workspacePath,
    "--idempotency-key",
    createKey,
    "--provider",
    "codex",
    "--additional-directory",
    workspacePath,
    "--default-character",
    "character-1",
    "--max-concurrent-child-runs",
    "2",
  ];
  const created = runJson(createArgs, environment, 0);
  const sessionId = created.applicationResponse.value.sessionId;
  assert.equal(typeof sessionId, "string");
  assert.equal(created.applicationResponse.value.title, "Primary Session");
  assert.equal(created.applicationResponse.value.localRepositoryKey, null);
  assert.equal(created.applicationResponse.value.repositoryName, null);
  const replay = runJson(createArgs, environment, 0);
  assert.equal(replay.applicationResponse.persistence.replayed, true);

  const unavailableWorkspace = runJson(
    [
      "session",
      "create",
      "--title",
      "Unavailable Workspace Session",
      "--workspace",
      path.join(tempDirectory, "missing-workspace"),
      "--idempotency-key",
      unavailableWorkspaceKey,
      "--provider",
      "codex",
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "0",
    ],
    environment,
    21,
  );
  assert.equal(unavailableWorkspace.applicationResponse.error.code, "workspace_unavailable");

  const invalidAdditionalDirectory = runJson(
    [
      "session",
      "create",
      "--title",
      "Invalid Directory Session",
      "--workspace",
      workspacePath,
      "--idempotency-key",
      invalidAdditionalDirectoryKey,
      "--provider",
      "codex",
      "--additional-directory",
      additionalDirectoryParent,
      "--additional-directory",
      nestedRegularFile,
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "1",
    ],
    environment,
    21,
  );
  assert.equal(invalidAdditionalDirectory.applicationResponse.error.code, "workspace_invalid");

  const secondCreated = runJson(
    [
      "session",
      "create",
      "--title",
      "Secondary Session",
      "--workspace",
      secondWorkspacePath,
      "--idempotency-key",
      secondCreateKey,
      "--provider",
      "codex",
      "--default-character",
      "character-2",
      "--max-concurrent-child-runs",
      "0",
    ],
    environment,
    0,
  );
  const secondSessionId = secondCreated.applicationResponse.value.sessionId;
  const secondRead = runJson(["session", "read", "--session-id", secondSessionId], environment, 0);
  assert.equal(secondRead.applicationResponse.value.session.title, "Secondary Session");
  assert.equal(secondRead.applicationResponse.value.session.localRepositoryKey, null);
  assert.equal(secondRead.applicationResponse.value.session.repositoryName, null);
  assert.equal(secondRead.applicationResponse.value.session.maxConcurrentChildRuns, 0);

  const allSessions = runJson(["session", "list", "--limit", "10"], environment, 0);
  assert.deepEqual(
    new Set(allSessions.applicationResponse.value.items.map((item) => item.id)),
    new Set([sessionId, secondSessionId]),
  );

  const renamed = runJson(
    [
      "session",
      "rename",
      "--session-id",
      sessionId,
      "--title",
      "Renamed Primary Session",
      "--idempotency-key",
      renameKey,
    ],
    environment,
    0,
  );
  assert.equal(renamed.applicationResponse.value.title, "Renamed Primary Session");
  const searched = runJson(["session", "list", "--query", "renamed primary", "--limit", "10"], environment, 0);
  assert.deepEqual(
    searched.applicationResponse.value.items.map((item) => item.id),
    [sessionId],
  );
  const repositories = runJson(["session", "repositories", "--limit", "10"], environment, 0);
  assert.deepEqual(repositories.applicationResponse.value.items, []);

  const listed = runJson(["session", "list", "--workspace", workspacePath, "--limit", "10"], environment, 0);
  assert.deepEqual(
    listed.applicationResponse.value.items.map((item) => item.id),
    [sessionId],
  );
  const read = runJson(["session", "read", "--session-id", sessionId], environment, 0);
  assert.equal(read.applicationResponse.value.session.id, sessionId);
  assert.equal(read.applicationResponse.value.session.title, "Renamed Primary Session");
  assert.equal(listed.applicationResponse.value.items[0].title, "Renamed Primary Session");
  const chunk = runJson(
    ["session", "directories-chunk", "--session-id", sessionId, "--offset", "0", "--max-bytes", "1024"],
    environment,
    0,
  );
  assert.equal(chunk.applicationResponse.value.chunk.encoding, "base64");

  runJson(["session", "archive", "--session-id", sessionId, "--idempotency-key", archiveKey], environment, 0);
  runJson(["session", "unarchive", "--session-id", sessionId, "--idempotency-key", unarchiveKey], environment, 0);
  runJson(
    [
      "session",
      "close",
      "--session-id",
      sessionId,
      "--idempotency-key",
      closeKey,
      "--expected-lifecycle-status",
      "active",
    ],
    environment,
    0,
  );
  const sessionFilesRoot = path.join(applicationDirectory, "session-files");
  const sessionFilesPath = path.join(sessionFilesRoot, sessionId);
  fs.mkdirSync(path.join(sessionFilesPath, "nested"), { recursive: true });
  fs.writeFileSync(path.join(sessionFilesPath, "nested", "output.txt"), "local session output");
  const deleteArgs = [
    "session",
    "delete",
    "--session-id",
    sessionId,
    "--idempotency-key",
    deleteKey,
    "--confirm-local-only",
  ];
  const deleted = runJson(deleteArgs, environment, 0);
  assert.deepEqual(deleted.applicationResponse.value, {
    sessionId,
    cleanupToken: deleteKey,
    deletedSessionCount: 1,
    localOnly: true,
    cleanupStatus: "completed",
  });
  assert.equal(fs.existsSync(sessionFilesPath), false);
  const deleteReplay = runJson(deleteArgs, environment, 0);
  assert.equal(deleteReplay.applicationResponse.persistence.replayed, true);
  assert.equal(deleteReplay.applicationResponse.value.cleanupStatus, "completed");
  const deletedRead = runJson(["session", "read", "--session-id", sessionId], environment, 22);
  assert.equal(deletedRead.applicationResponse.error.code, "not_found");
  assert.deepEqual(fs.readdirSync(sessionFilesRoot), [], "Session Files cleanup artifacts remained after retry");
  const missing = runJson(["session", "read", "--session-id", "missing-session"], environment, 22);
  assert.equal(missing.applicationResponse.error.code, "not_found");

  assert.equal(fs.existsSync(databasePath), true);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(
      fs.existsSync(`${databasePath}${suffix}`),
      false,
      `SQLite sidecar remained after CLI shutdown: ${suffix}`,
    );
  }

  const failedAppDataRoot = path.join(tempDirectory, "failed-app-data");
  const failedDatabasePath = expectedDatabasePath(failedAppDataRoot);
  fs.mkdirSync(path.dirname(failedDatabasePath), { recursive: true });
  fs.writeFileSync(failedDatabasePath, "not a WithMate SQLite database");
  const bootstrapFailure = invoke(["session", "list"], isolatedEnvironment(failedAppDataRoot));
  assert.equal(bootstrapFailure.status, 50);
  assert.equal(parseJsonOutput(bootstrapFailure).error.code, "bootstrap_failed");

  console.log(
    JSON.stringify({
      commands: [
        "create",
        "rename",
        "list",
        "repositories",
        "read",
        "directories-chunk",
        "archive",
        "unarchive",
        "close",
        "delete",
      ],
      exactRetry: "create-and-delete-replayed",
      appWideList: "verified",
      workspaceRejection: "classified",
      additionalDirectoryValidation: "verified-before-compaction",
      zeroChildRunCapacity: "verified",
      parseRuntimeIsolation: "verified",
      bootstrapFailure: "classified",
      sqliteSidecars: "none",
      sessionFilesCleanupArtifacts: "none",
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
