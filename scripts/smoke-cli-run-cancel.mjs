import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectRuntimeEndpoint } from "../dist/main/runtime-host/runtime-endpoint.js";
import {
  deriveRuntimeRequestId,
  encodeRuntimeIpcEnvelope,
  RUNTIME_IPC_PROTOCOL_VERSION,
  snapshotRuntimeOperationPayload,
} from "../dist/main/runtime-host/runtime-ipc-contract.js";
import { RuntimeIpcJsonlDecoder } from "../dist/main/runtime-host/runtime-ipc-jsonl.js";
import { resolveRuntimeOwnerIdentity } from "../dist/main/runtime-host/runtime-owner-identity.js";
import { cleanupControlledRuntimeHost, startControlledRuntimeHost } from "./runtime-host-smoke-support.mjs";

const root = process.cwd();
const cliEntry = path.join(root, "dist", "cli", "entry.js");
const fakeModule = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-run-cancel-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const interruptReleaseFile = path.join(tempDirectory, "release-interrupt");
const crashMarker = "CRASH_PROVIDER_AFTER_ACCEPTANCE";
const holdMarker = "HOLD_ACTIVE_TURN_FOR_CANCEL";
const naturalCompletionMarker = "CANCEL_NATURAL_COMPLETION_RACE";
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: crashMarker,
  WITHMATE_FAKE_CODEX_HOLD_MARKER: holdMarker,
  WITHMATE_FAKE_CODEX_INTERRUPT_NATURAL_COMPLETION_MARKER: naturalCompletionMarker,
  WITHMATE_FAKE_CODEX_INTERRUPT_RELEASE_FILE: interruptReleaseFile,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const sandboxJson = JSON.stringify({ mode: "read-only", networkAccess: false });
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const keys = {
  sessionCancel: "018f1f4e-7f0a-7000-8000-000000000901",
  sessionDisconnect: "018f1f4e-7f0a-7000-8000-000000000902",
  sessionRace: "018f1f4e-7f0a-7000-8000-000000000903",
  sessionTerminal: "018f1f4e-7f0a-7000-8000-000000000904",
  runCancel: "018f1f4e-7f0a-7000-8000-000000000911",
  runDisconnect: "018f1f4e-7f0a-7000-8000-000000000912",
  runRace: "018f1f4e-7f0a-7000-8000-000000000913",
  runTerminal: "018f1f4e-7f0a-7000-8000-000000000914",
  cancel: "018f1f4e-7f0a-7000-8000-000000000921",
  disconnect: "018f1f4e-7f0a-7000-8000-000000000922",
  race: "018f1f4e-7f0a-7000-8000-000000000923",
  terminal: "018f1f4e-7f0a-7000-8000-000000000924",
};

fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(fakeCwd, { recursive: true });
fs.writeFileSync(
  fakeWrapperPath,
  [
    "import(process.env.WITHMATE_FAKE_CODEX_MODULE).catch((error) => {",
    "  console.error(error);",
    "  process.exitCode = 70;",
    "});",
    "",
  ].join("\n"),
  "utf8",
);
fs.writeFileSync(fakeUserAgentPath, "codex-cli/0.145.0", "utf8");

let runtimeHost;
try {
  runtimeHost = await startControlledRuntimeHost(appDataRoot, 15_000, {
    cwd: fakeCwd,
    environment,
  });

  const cancelSession = createSession("Run cancel smoke", keys.sessionCancel);
  const cancelPrompt = `cancel-me:${holdMarker}`;
  const cancelRun = startHeldRun(cancelSession, keys.runCancel, cancelPrompt);
  await waitForActive(cancelSession, cancelRun);
  assert.equal(countLog(readLog(), "process.started"), 1);

  fs.rmSync(interruptReleaseFile, { force: true });
  const freshCancelResponse = cancelRunResponse(cancelSession, cancelRun, keys.cancel);
  assert.equal(freshCancelResponse.persistence.replayed, false);
  const freshCancel = freshCancelResponse.value;
  assert.equal(freshCancel.phase, "canceling");
  assert.equal(typeof freshCancel.cancellation.requestedAt, "number");
  assert.equal(Object.hasOwn(freshCancel.cancellation, "acknowledgedAt"), false);
  await waitForInterrupts(1);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 1);

  const cancelReplay = cancelRunWithKey(cancelSession, cancelRun, keys.cancel);
  assert.deepEqual(cancelReplay, freshCancel);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 1);

  releaseInterrupt();
  const canceled = await waitForTerminal(cancelSession, cancelRun);
  assert.equal(canceled.phase, "canceled");
  assert.equal(canceled.cancellation.requestedAt, freshCancel.cancellation.requestedAt);
  assert.equal(canceled.cancellation.requestedAt <= canceled.cancellation.acknowledgedAt, true);
  assert.equal(canceled.cancellation.acknowledgedAt <= canceled.terminalAt, true);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 1);
  assert.equal(countAssistantMessages(cancelSession), 0);

  const terminalReplay = cancelRunWithKey(cancelSession, cancelRun, keys.cancel);
  assert.deepEqual(terminalReplay, canceled);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 1);

  const disconnectSession = createSession("Run cancel disconnect smoke", keys.sessionDisconnect);
  const disconnectPrompt = `disconnect-after-admission:${holdMarker}`;
  const disconnectRun = startHeldRun(disconnectSession, keys.runDisconnect, disconnectPrompt);
  await waitForActive(disconnectSession, disconnectRun);
  fs.rmSync(interruptReleaseFile, { force: true });
  await writeCancelAndDisconnect(disconnectSession, disconnectRun, keys.disconnect, 2);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 2);
  releaseInterrupt();
  const disconnectedCanceled = await waitForTerminal(disconnectSession, disconnectRun);
  assert.equal(disconnectedCanceled.phase, "canceled");
  assert.equal(countAssistantMessages(disconnectSession), 0);
  const disconnectReplay = cancelRunWithKey(disconnectSession, disconnectRun, keys.disconnect);
  assert.deepEqual(disconnectReplay, disconnectedCanceled);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 2);

  const raceSession = createSession("Run cancel natural completion race", keys.sessionRace);
  const racePrompt = `complete-naturally:${holdMarker}:${naturalCompletionMarker}`;
  const raceRun = startHeldRun(raceSession, keys.runRace, racePrompt);
  await waitForActive(raceSession, raceRun);
  fs.rmSync(interruptReleaseFile, { force: true });
  const raceAdmission = cancelRunWithKey(raceSession, raceRun, keys.race);
  assert.equal(raceAdmission.phase, "canceling");
  await waitForInterrupts(3);
  releaseInterrupt();
  const completedRace = await waitForTerminal(raceSession, raceRun);
  assert.equal(completedRace.phase, "completed");
  assert.deepEqual(completedRace.cancellation, { requestedAt: raceAdmission.cancellation.requestedAt });
  assert.equal(countAssistantMessages(raceSession), 1);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 3);

  const terminalSession = createSession("Run terminal cancel no-op", keys.sessionTerminal);
  const terminalPrompt = "complete-before-cancel";
  const terminalRun = startRun(terminalSession, keys.runTerminal, terminalPrompt);
  const completedBeforeCancel = await waitForTerminal(terminalSession, terminalRun);
  assert.equal(completedBeforeCancel.phase, "completed");
  const callsBeforeTerminalCancel = countLog(readLog(), "turn.interrupt_requested");
  const terminalCancel = cancelRunWithKey(terminalSession, terminalRun, keys.terminal);
  assert.deepEqual(terminalCancel, completedBeforeCancel);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), callsBeforeTerminalCancel);
  assert.equal(countAssistantMessages(terminalSession), 1);

  const logText = JSON.stringify(readLog());
  for (const privatePath of [appDataRoot, workspacePath, fakeCwd]) {
    assert.equal(logText.includes(privatePath), false);
  }

  const shutdown = await runtimeHost.stop();
  assert.equal(shutdown.checkpoint, "completed");
  runtimeHost = undefined;
} finally {
  await cleanupControlledRuntimeHost(runtimeHost, async () => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
}

function createSession(title, idempotencyKey) {
  return runJson(
    [
      "session",
      "create",
      "--title",
      title,
      "--workspace",
      workspacePath,
      "--idempotency-key",
      idempotencyKey,
      "--provider",
      "codex",
      "--default-character",
      "character-1",
      "--max-concurrent-child-runs",
      "1",
    ],
    0,
  ).applicationResponse.value.sessionId;
}

function startHeldRun(sessionId, idempotencyKey, prompt) {
  const value = runJson(startArgs(sessionId, idempotencyKey, prompt), 0).applicationResponse.value;
  assert.equal(value.phase, "queued");
  return value.runId;
}

function startRun(sessionId, idempotencyKey, prompt) {
  return startHeldRun(sessionId, idempotencyKey, prompt);
}

function startArgs(sessionId, idempotencyKey, prompt) {
  return [
    "run",
    "start",
    "--session-id",
    sessionId,
    "--idempotency-key",
    idempotencyKey,
    "--content-blocks-json",
    JSON.stringify([{ type: "text", text: prompt }]),
    "--provider-settings-json",
    providerSettingsJson(sandboxJson),
  ];
}

function providerSettingsJson(sandboxJson) {
  return JSON.stringify({
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    settings: {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalPolicy: "never",
      sandbox: JSON.parse(sandboxJson),
    },
  });
}

function cancelRunWithKey(sessionId, runId, idempotencyKey) {
  return cancelRunResponse(sessionId, runId, idempotencyKey).value;
}

function cancelRunResponse(sessionId, runId, idempotencyKey) {
  return runJson(
    ["run", "cancel", "--session-id", sessionId, "--run-id", runId, "--idempotency-key", idempotencyKey],
    0,
  ).applicationResponse;
}

async function waitForActive(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runStatus(sessionId, runId);
    if (status.phase === "active") return status;
    if (terminalPhases.has(status.phase)) throw new Error(`Run ${runId} became terminal before it was active.`);
    await delay(25);
  }
  throw new Error(`Run ${runId} did not become active.`);
}

async function waitForTerminal(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runStatus(sessionId, runId);
    if (terminalPhases.has(status.phase)) return status;
    await delay(25);
  }
  throw new Error(`Run ${runId} did not become terminal.`);
}

function runStatus(sessionId, runId) {
  return runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse.value;
}

function countAssistantMessages(sessionId) {
  return runJson(
    ["session", "messages", "--session-id", sessionId, "--limit", "50"],
    0,
  ).applicationResponse.value.items.filter((message) => message.role === "assistant").length;
}

async function writeCancelAndDisconnect(sessionId, runId, idempotencyKey, expectedInterruptCount) {
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: appDataRoot });
  const connection = await connectRuntimeEndpoint(identity, { timeoutMs: 5_000 });
  const clientId = randomUUID();
  let closed = false;
  try {
    await connection.write(
      Buffer.from(
        encodeRuntimeIpcEnvelope({
          protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
          kind: "handshake_request",
          clientId,
        }),
      ),
    );
    const handshake = await readEnvelope(connection);
    assert.equal(handshake.kind, "handshake_response");
    const requestSequence = 1;
    const operation = "run.cancel";
    await connection.write(
      Buffer.from(
        encodeRuntimeIpcEnvelope({
          protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
          kind: "request",
          hostGenerationId: handshake.hostGenerationId,
          clientId,
          requestId: deriveRuntimeRequestId(clientId, requestSequence),
          requestSequence,
          operation,
          payload: snapshotRuntimeOperationPayload(operation, { sessionId, runId, idempotencyKey }),
        }),
      ),
    );
    await waitForInterrupts(expectedInterruptCount);
    await connection.close();
    closed = true;
  } finally {
    if (!closed) await connection.close();
  }
}

async function readEnvelope(connection) {
  const decoder = new RuntimeIpcJsonlDecoder();
  while (true) {
    const chunk = await connection.read();
    if (chunk === null) throw new Error("Runtime endpoint closed before the handshake response.");
    let envelope;
    decoder.push(chunk, (value) => {
      envelope ??= value;
    });
    if (envelope !== undefined) return envelope;
  }
}

async function waitForInterrupts(expectedCount, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countLog(readLog(), "turn.interrupt_requested") === expectedCount) return;
    await delay(25);
  }
  const observedEvents = readLog().map((entry) => entry.event);
  throw new Error(
    `Fake Codex did not observe ${expectedCount} interrupt request(s); observed events: ${JSON.stringify(observedEvents)}.`,
  );
}

function releaseInterrupt() {
  fs.writeFileSync(interruptReleaseFile, "release\n", "utf8");
}

function readLog() {
  if (!fs.existsSync(fakeLogPath)) return [];
  return fs
    .readFileSync(fakeLogPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function countLog(entries, event) {
  return entries.filter((entry) => entry.event === event).length;
}

function runJson(args, expectedStatus) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `${args.join(" ")} failed to spawn`);
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.slice(0, -1).includes("\n"), false);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed;
}

function isolatedEnvironment(appRoot, additions) {
  return {
    ...process.env,
    ...(process.platform === "win32"
      ? { APPDATA: appRoot }
      : process.platform === "darwin"
        ? { HOME: appRoot }
        : { XDG_CONFIG_HOME: appRoot }),
    ...additions,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
