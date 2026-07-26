import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeIpcClient, RuntimeIpcClientError } from "../dist/main/runtime-host/runtime-ipc-client.js";
import { RuntimeEndpointUnavailableError } from "../dist/main/runtime-host/runtime-endpoint.js";
import { spawnDetachedRuntimeHost } from "../dist/main/runtime-host/runtime-host-bootstrap.js";
import { acquireRuntimeOwnerClaim } from "../dist/main/runtime-host/runtime-owner-claim.js";
import { resolveRuntimeOwnerIdentity } from "../dist/main/runtime-host/runtime-owner-identity.js";
import { cleanupControlledRuntimeHost, startControlledRuntimeHost } from "./runtime-host-smoke-support.mjs";

const root = process.cwd();
const cliEntry = path.join(root, "dist", "cli", "entry.js");
const runtimeApplicationArtifact = path.join(root, "dist", "main", "runtime-application.js");
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-runtime-host-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const applicationDirectory = path.join(appDataRoot, "WithMate");
const workspacePath = path.join(tempDirectory, "workspace");
const environment = isolatedEnvironment(appDataRoot);
const databasePath = path.join(applicationDirectory, "withmate.sqlite3");
const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000701";
const detachedProcesses = [];
const cliProcesses = new Set();
let controlledHost;

fs.mkdirSync(workspacePath, { recursive: true });

try {
  const [help, invalid] = await Promise.all([
    invokeCli(["--help"], environment),
    invokeCli(["session", "read"], environment),
  ]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: withmate/u);
  assert.equal(invalid.status, 20);
  assert.equal(parseJsonOutput(invalid).kind, "usage_failure");
  assert.equal(fs.existsSync(applicationDirectory), false, "runtime-free CLI action created an application owner");

  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: appDataRoot });
  await verifyCleanupFailureContracts(identity);
  await verifyControlledSendFailureCleanup();
  await verifyCliTimeoutCleanup(environment);
  const firstStarts = await spawnOwnedDetachedHosts(identity, 2, detachedProcesses);
  const firstClient = await connectWhenReady(identity);
  const firstGeneration = firstClient.hostGenerationId;
  await firstClient.close();
  await waitFor(() => firstStarts.filter((process) => process.isRunning()).length === 1);
  const firstOwner = firstStarts.find((process) => process.isRunning());
  const firstLoser = firstStarts.find((process) => !process.isRunning());
  assert.notEqual(firstOwner, undefined);
  assert.notEqual(firstLoser, undefined);
  assert.deepEqual(await waitForDetachedExit(firstLoser), { code: 0, signal: null });

  const simultaneous = await Promise.all([
    invokeCli(["session", "list", "--limit", "1"], environment),
    invokeCli(["session", "repositories", "--limit", "1"], environment),
  ]);
  for (const result of simultaneous) {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(parseJsonOutput(result).schemaVersion, "withmate-cli-v1");
  }
  const sameHostClient = await RuntimeIpcClient.connect(identity, { timeoutMs: 2_000 });
  assert.equal(sameHostClient.hostGenerationId, firstGeneration);
  await sameHostClient.close();

  const created = await runCliJson(
    [
      "session",
      "create",
      "--title",
      "Runtime Host Smoke",
      "--workspace",
      workspacePath,
      "--idempotency-key",
      idempotencyKey,
      "--provider",
      "codex",
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "0",
    ],
    environment,
  );
  assert.equal(created.kind, "operation");
  const sessionId = created.applicationResponse.value.sessionId;
  const readBeforeCrash = await runCliJson(["session", "read", "--session-id", sessionId], environment);
  assert.equal(readBeforeCrash.applicationResponse.value.session.title, "Runtime Host Smoke");

  firstOwner.terminate("SIGKILL");
  await waitForDetachedExit(firstOwner);
  await waitForEndpointAbsence(identity);

  const replacement = await spawnDetachedRuntimeHost(identity);
  detachedProcesses.push(replacement);
  const replacementClient = await connectWhenReady(identity);
  const replacementGeneration = replacementClient.hostGenerationId;
  await replacementClient.close();
  assert.notEqual(replacementGeneration, firstGeneration);
  const readAfterCrash = await runCliJson(["session", "read", "--session-id", sessionId], environment);
  assert.equal(readAfterCrash.applicationResponse.value.session.id, sessionId);

  replacement.terminate("SIGKILL");
  await waitForDetachedExit(replacement);
  await waitForEndpointAbsence(identity);

  controlledHost = await startControlledRuntimeHost(appDataRoot);
  assert.notEqual(controlledHost.generationId, replacementGeneration);
  const readBeforeGracefulStop = await runCliJson(["session", "read", "--session-id", sessionId], environment);
  assert.equal(readBeforeGracefulStop.applicationResponse.value.session.id, sessionId);
  assert.deepEqual(await controlledHost.stop(), { checkpoint: "completed" });
  controlledHost = undefined;
  await waitForEndpointAbsence(identity);

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(
      fs.existsSync(`${databasePath}${suffix}`),
      false,
      `SQLite sidecar remained after graceful runtime host shutdown: ${suffix}`,
    );
  }
  const replacementClaim = await acquireRuntimeOwnerClaim(identity);
  assert.equal(replacementClaim.status, "acquired");
  if (replacementClaim.status === "acquired") await replacementClaim.release();

  const runtimeApplicationSource = fs.readFileSync(runtimeApplicationArtifact, "utf8");
  assert.doesNotMatch(runtimeApplicationSource, /providers[\\/]codex/u);
  assert.equal(identity.endpoint.platform, process.platform === "win32" ? "win32" : "unix");

  console.log(
    JSON.stringify({
      platform: process.platform,
      concurrentOwnerStart: "single-owner",
      simultaneousCli: "shared-host",
      reconnectGeneration: "replaced",
      persistedSessionAfterCrash: "verified",
      gracefulCheckpoint: "completed",
      sqliteSidecars: "none",
      detachedStdio: "ignored",
      providerStartup: "absent",
      partialSpawnCleanup: "verified",
      cleanupFailureSurface: "verified",
      controlledSendFailureCleanup: "verified",
      cliTimeoutCleanup: "verified",
    }),
  );
} finally {
  await cleanupOwnedRuntimeHosts(controlledHost, detachedProcesses, cliProcesses, tempDirectory);
}

async function spawnOwnedDetachedHosts(identity, count, ownedProcesses, spawnHost = spawnDetachedRuntimeHost) {
  const starts = await Promise.allSettled(Array.from({ length: count }, () => spawnHost(identity)));
  const started = [];
  const failures = [];
  for (const start of starts) {
    if (start.status === "fulfilled") {
      started.push(start.value);
      ownedProcesses.push(start.value);
    } else {
      failures.push(start.reason);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "One or more detached runtime hosts failed to spawn.");
  return started;
}

async function verifyCleanupFailureContracts(identity) {
  const partialSpawnDirectory = path.join(tempDirectory, "partial-spawn-cleanup");
  fs.mkdirSync(partialSpawnDirectory);
  const syntheticProcess = {
    pid: -1,
    exited: Promise.resolve({ code: 1, signal: null }),
    isRunning: () => false,
    terminate: () => false,
  };
  const ownedProcesses = [];
  let spawnAttempt = 0;
  await assert.rejects(
    spawnOwnedDetachedHosts(identity, 2, ownedProcesses, async () => {
      spawnAttempt += 1;
      if (spawnAttempt === 1) return syntheticProcess;
      throw new Error("synthetic spawn failure");
    }),
    AggregateError,
  );
  assert.deepEqual(ownedProcesses, [syntheticProcess]);
  await cleanupOwnedRuntimeHosts(undefined, ownedProcesses, new Set(), partialSpawnDirectory);
  assert.equal(fs.existsSync(partialSpawnDirectory), false);

  const controlledCleanupDirectory = path.join(tempDirectory, "controlled-cleanup-failure");
  fs.mkdirSync(controlledCleanupDirectory);
  let controlledRunning = true;
  let forcedTerminationCalls = 0;
  await assert.rejects(
    cleanupControlledRuntimeHost(
      {
        isRunning: () => controlledRunning,
        async stop() {
          throw new Error("synthetic graceful cleanup failure");
        },
        async terminate() {
          forcedTerminationCalls += 1;
          controlledRunning = false;
        },
      },
      () => fs.rmSync(controlledCleanupDirectory, { recursive: true, force: true }),
    ),
    AggregateError,
  );
  assert.equal(forcedTerminationCalls, 1);
  assert.equal(fs.existsSync(controlledCleanupDirectory), false);
}

async function verifyCliTimeoutCleanup(childEnvironment) {
  await assert.rejects(
    invokeNode(["--input-type=module", "--eval", "setInterval(() => undefined, 1_000)"], childEnvironment, 25),
    /timed out/u,
  );
  assert.equal(cliProcesses.size, 0);
}

async function verifyControlledSendFailureCleanup() {
  const applicationDataRoot = path.join(tempDirectory, "controlled-send-failure");
  let host;
  try {
    host = await startControlledRuntimeHost(applicationDataRoot, 10_000, {
      async sendMessage() {
        throw new Error("synthetic controlled IPC send failure");
      },
    });
    await assert.rejects(host.stop(), /synthetic controlled IPC send failure/u);
    assert.equal(host.isRunning(), false);
  } finally {
    await cleanupControlledRuntimeHost(host, () =>
      fs.rmSync(applicationDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    );
  }
}

async function cleanupOwnedRuntimeHosts(runtimeHost, ownedProcesses, ownedCliProcesses, directory) {
  const failures = [];
  if (runtimeHost?.isRunning()) {
    try {
      await runtimeHost.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (runtimeHost?.isRunning()) {
    failures.push(new Error("Controlled runtime host remained alive after cleanup."));
  }
  for (const ownedProcess of ownedProcesses) {
    if (!ownedProcess.isRunning()) continue;
    try {
      ownedProcess.terminate("SIGKILL");
    } catch (error) {
      failures.push(error);
    }
  }
  const exits = await Promise.allSettled(ownedProcesses.map((process) => waitForDetachedExit(process)));
  for (const exit of exits) {
    if (exit.status === "rejected") failures.push(exit.reason);
  }
  const liveProcesses = ownedProcesses.filter((process) => process.isRunning());
  if (liveProcesses.length > 0) {
    failures.push(
      new Error(
        `Detached runtime hosts remained alive after cleanup: ${liveProcesses.map((process) => process.pid).join(", ")}`,
      ),
    );
  }
  for (const child of ownedCliProcesses) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      failures.push(error);
    }
  }
  const cliExits = await Promise.allSettled([...ownedCliProcesses].map((child) => waitForCliExit(child)));
  for (const exit of cliExits) {
    if (exit.status === "rejected") failures.push(exit.reason);
  }
  const liveCliProcesses = [...ownedCliProcesses].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  if (liveCliProcesses.length > 0) {
    failures.push(new Error("CLI child processes remained alive after cleanup."));
  }
  if (liveProcesses.length === 0 && liveCliProcesses.length === 0 && !runtimeHost?.isRunning()) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (failures.length > 0) throw new AggregateError(failures, "Runtime host smoke cleanup failed.");
}

async function invokeCli(args, childEnvironment) {
  return await invokeNode([cliEntry, ...args], childEnvironment, 20_000);
}

async function invokeNode(args, childEnvironment, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    cliProcesses.add(child);
    const stdout = [];
    const stderr = [];
    let timeoutError;
    let cleanupTimer;
    const timer = setTimeout(() => {
      timeoutError = new Error(`CLI process timed out: ${args.join(" ")}`);
      try {
        child.kill("SIGKILL");
      } catch (error) {
        timeoutError = new AggregateError([timeoutError, error], "CLI process timeout cleanup failed.");
      }
      cleanupTimer = setTimeout(
        () =>
          reject(
            new AggregateError(
              [timeoutError, new Error("CLI process remained alive after forced termination.")],
              "CLI process timeout cleanup failed.",
            ),
          ),
        10_000,
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      if (child.pid === undefined) cliProcesses.delete(child);
      reject(
        timeoutError === undefined
          ? error
          : new AggregateError([timeoutError, error], "CLI process timeout cleanup failed."),
      );
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      cliProcesses.delete(child);
      if (timeoutError !== undefined) {
        reject(timeoutError);
      } else {
        resolve({
          status: code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });
  });
}

async function runCliJson(args, childEnvironment, expectedStatus = 0) {
  const result = await invokeCli(args, childEnvironment);
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return parseJsonOutput(result);
}

async function connectWhenReady(identity, timeoutMs = 10_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    if (Date.now() >= deadlineAt) throw new Error("Runtime host readiness timed out.");
    try {
      return await RuntimeIpcClient.connect(identity, {
        timeoutMs: Math.max(1, Math.min(250, deadlineAt - Date.now())),
      });
    } catch (error) {
      if (!isReadinessFailure(error) || Date.now() >= deadlineAt) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForEndpointAbsence(identity, timeoutMs = 10_000) {
  await waitFor(async () => {
    try {
      const client = await RuntimeIpcClient.connect(identity, { timeoutMs: 100 });
      await client.close();
      return false;
    } catch (error) {
      return error instanceof RuntimeEndpointUnavailableError && error.reason === "absent";
    }
  }, timeoutMs);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadlineAt) throw new Error("Runtime host smoke condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForDetachedExit(detachedProcess, timeoutMs = 10_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    const settlement = await Promise.race([
      detachedProcess.exited.then((value) => ({ status: "exited", value })),
      new Promise((resolve) => setTimeout(() => resolve({ status: "waiting" }), 10)),
    ]);
    if (settlement.status === "exited") return settlement.value;
    if (Date.now() >= deadlineAt) throw new Error(`Detached runtime host ${detachedProcess.pid} did not exit.`);
  }
}

async function waitForCliExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("CLI child process exit timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isReadinessFailure(error) {
  return (
    (error instanceof RuntimeEndpointUnavailableError &&
      (error.reason === "absent" || error.reason === "busy" || error.reason === "timeout")) ||
    (error instanceof RuntimeIpcClientError && (error.code === "request_timeout" || error.code === "connection_closed"))
  );
}

function parseJsonOutput(result) {
  assert.equal(result.signal, null);
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
