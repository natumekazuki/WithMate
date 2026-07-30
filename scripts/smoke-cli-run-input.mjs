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
import { decodeRuntimeWireValue } from "../dist/main/runtime-host/runtime-ipc-value.js";
import { resolveRuntimeOwnerIdentity } from "../dist/main/runtime-host/runtime-owner-identity.js";
import { cleanupControlledRuntimeHost, startControlledRuntimeHost } from "./runtime-host-smoke-support.mjs";

const root = process.cwd();
const cliEntry = path.join(root, "dist", "cli", "entry.js");
const fakeModule = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-run-input-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const steerReleaseFile = path.join(tempDirectory, "release-steer");
const crashMarker = "CRASH_PROVIDER_AFTER_ACCEPTANCE";
const holdMarker = "HOLD_ACTIVE_TURN_FOR_INPUT";
const steerHoldMarker = "STEER_HOLD_RESPONSE";
const rejectMarker = "STEER_REJECT";
const steerCrashMarker = "STEER_PROCESS_CRASH";
const terminalMarker = "STEER_TERMINAL_RACE";
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: crashMarker,
  WITHMATE_FAKE_CODEX_HOLD_MARKER: holdMarker,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_STEER_CRASH_MARKER: steerCrashMarker,
  WITHMATE_FAKE_CODEX_STEER_HOLD_MARKER: steerHoldMarker,
  WITHMATE_FAKE_CODEX_STEER_REJECT_MARKER: rejectMarker,
  WITHMATE_FAKE_CODEX_STEER_RELEASE_FILE: steerReleaseFile,
  WITHMATE_FAKE_CODEX_STEER_TERMINAL_MARKER: terminalMarker,
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const sandboxJson = JSON.stringify({ mode: "read-only", networkAccess: false });
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const keys = {
  sessionA: "018f1f4e-7f0a-7000-8000-000000000801",
  sessionB: "018f1f4e-7f0a-7000-8000-000000000802",
  runA: "018f1f4e-7f0a-7000-8000-000000000811",
  runB: "018f1f4e-7f0a-7000-8000-000000000812",
  accepted: "018f1f4e-7f0a-7000-8000-000000000821",
  rejected: "018f1f4e-7f0a-7000-8000-000000000822",
  disconnected: "018f1f4e-7f0a-7000-8000-000000000823",
  terminalRace: "018f1f4e-7f0a-7000-8000-000000000824",
  ambiguous: "018f1f4e-7f0a-7000-8000-000000000825",
  terminalFollower: "018f1f4e-7f0a-7000-8000-000000000826",
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

  const sessionA = createSession("Run input smoke A", keys.sessionA);
  const runA = startHeldRun(sessionA, keys.runA, `run-a:${holdMarker}`);
  await waitForActive(sessionA, runA);

  const acceptedPrompt = "supplemental-accepted";
  const acceptedAdmission = sendInput(sessionA, runA, keys.accepted, acceptedPrompt);
  assert.equal(acceptedAdmission.deliveryState, "pending");
  const accepted = await waitForDelivery(sessionA, runA, keys.accepted, acceptedPrompt);
  assert.equal(accepted.deliveryState, "accepted");
  assert.equal(accepted.messageId, acceptedAdmission.messageId);
  assert.equal(countLog(readLog(), "turn.steered", acceptedPrompt), 1);
  const acceptedReplay = sendInput(sessionA, runA, keys.accepted, acceptedPrompt);
  assert.deepEqual(acceptedReplay, accepted);
  assert.equal(countLog(readLog(), "turn.steered", acceptedPrompt), 1);
  assertTimelineContainsOnce(sessionA, acceptedPrompt);

  const rejectedPrompt = `supplemental:${rejectMarker}`;
  const rejectedAdmission = sendInput(sessionA, runA, keys.rejected, rejectedPrompt);
  assert.equal(rejectedAdmission.deliveryState, "pending");
  const rejected = await waitForDelivery(sessionA, runA, keys.rejected, rejectedPrompt);
  assert.deepEqual(
    { deliveryState: rejected.deliveryState, resolutionCode: rejected.resolutionCode },
    { deliveryState: "rejected", resolutionCode: "provider_rejected" },
  );
  assert.equal(rejected.messageId, rejectedAdmission.messageId);
  assert.equal(countLog(readLog(), "turn.steered", rejectedPrompt), 1);

  const disconnectedPrompt = `supplemental-client-disconnect:${steerHoldMarker}`;
  await writeSendInputAndDisconnect(sessionA, runA, keys.disconnected, disconnectedPrompt);
  const disconnected = await waitForDelivery(sessionA, runA, keys.disconnected, disconnectedPrompt);
  assert.equal(disconnected.deliveryState, "accepted");
  assert.equal(countLog(readLog(), "turn.steered", disconnectedPrompt), 1);
  assertTimelineContainsOnce(sessionA, disconnectedPrompt);
  assert.equal(
    runJson(["session", "read", "--session-id", sessionA], 0).applicationResponse.value.session.id,
    sessionA,
  );

  fs.rmSync(steerReleaseFile, { force: true });
  const terminalPrompt = `supplemental:${steerHoldMarker}:${terminalMarker}`;
  const terminalFollowerPrompt = "supplemental-terminal-follower";
  const [terminalAdmission, terminalFollowerAdmission] = await sendInputsConcurrently(sessionA, runA, [
    { idempotencyKey: keys.terminalRace, prompt: terminalPrompt },
    { idempotencyKey: keys.terminalFollower, prompt: terminalFollowerPrompt },
  ]);
  assert.equal(terminalAdmission.deliveryState, "pending");
  assert.equal(terminalFollowerAdmission.deliveryState, "pending");
  await waitForLog(
    (entries) =>
      countLog(entries, "turn.steered", terminalPrompt) === 1 &&
      countLog(entries, "turn.steer_waiting", terminalPrompt) === 1,
  );
  assert.equal(countLog(readLog(), "turn.steered", terminalFollowerPrompt), 0);
  fs.writeFileSync(steerReleaseFile, "release\n", "utf8");
  await waitForLog((entries) => countLog(entries, "turn.steer_released", terminalPrompt) === 1);
  const terminalDelivery = await waitForDelivery(sessionA, runA, keys.terminalRace, terminalPrompt);
  assert.equal(terminalDelivery.deliveryState, "accepted");
  assert.equal(terminalDelivery.messageId, terminalAdmission.messageId);
  assert.equal(countLog(readLog(), "turn.steered", terminalPrompt), 1);
  const terminalStatus = await waitForTerminal(sessionA, runA);
  assert.equal(terminalStatus.phase, "completed");
  const terminalFollower = await waitForDelivery(sessionA, runA, keys.terminalFollower, terminalFollowerPrompt);
  assert.deepEqual(
    {
      deliveryState: terminalFollower.deliveryState,
      resolutionCode: terminalFollower.resolutionCode,
    },
    { deliveryState: "aborted", resolutionCode: "run_terminal_not_sent" },
  );
  assert.equal(terminalFollower.messageId, terminalFollowerAdmission.messageId);
  assert.equal(countLog(readLog(), "turn.steered", terminalFollowerPrompt), 0);
  const terminalReplay = sendInput(sessionA, runA, keys.terminalRace, terminalPrompt);
  assert.deepEqual(terminalReplay, terminalDelivery);
  const terminalFollowerReplay = sendInput(sessionA, runA, keys.terminalFollower, terminalFollowerPrompt);
  assert.deepEqual(terminalFollowerReplay, terminalFollower);
  assert.equal(countLog(readLog(), "turn.steered", terminalPrompt), 1);
  assertTimelineContainsOnce(sessionA, terminalFollowerPrompt);

  const sessionB = createSession("Run input smoke B", keys.sessionB);
  const runB = startHeldRun(sessionB, keys.runB, `run-b:${holdMarker}`);
  await waitForActive(sessionB, runB);
  assert.equal(countLog(readLog(), "process.started"), 1);
  const ambiguousPrompt = `supplemental:${steerCrashMarker}`;
  const ambiguousAdmission = sendInput(sessionB, runB, keys.ambiguous, ambiguousPrompt);
  assert.equal(ambiguousAdmission.deliveryState, "pending");
  await waitForLog((entries) => countLog(entries, "process.crashing") >= 1);
  const ambiguousStatus = await waitForTerminal(sessionB, runB);
  assert.equal(ambiguousStatus.phase, "interrupted");
  const ambiguous = await waitForDelivery(sessionB, runB, keys.ambiguous, ambiguousPrompt);
  assert.equal(ambiguous.deliveryState, "ambiguous");
  assert.equal(["transport_unknown", "process_unknown"].includes(ambiguous.resolutionCode), true);
  assert.equal(ambiguous.messageId, ambiguousAdmission.messageId);
  assert.equal(countLog(readLog(), "turn.steered", ambiguousPrompt), 1);

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
  const result = runJson(
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
  );
  return result.applicationResponse.value.sessionId;
}

function startHeldRun(sessionId, idempotencyKey, prompt) {
  const admission = runJson(
    [
      "run",
      "start",
      "--session-id",
      sessionId,
      "--idempotency-key",
      idempotencyKey,
      "--content-blocks-json",
      JSON.stringify([{ type: "text", text: prompt }]),
      "--model",
      "gpt-5.4",
      "--reasoning-effort",
      "medium",
      "--sandbox-json",
      sandboxJson,
    ],
    0,
  ).applicationResponse.value;
  assert.equal(admission.phase, "queued");
  return admission.runId;
}

function sendInput(sessionId, runId, idempotencyKey, prompt) {
  const value = runJson(sendInputArgs(sessionId, runId, idempotencyKey, prompt), 0).applicationResponse.value;
  assertPublicDelivery(value, sessionId, runId);
  return value;
}

function sendInputArgs(sessionId, runId, idempotencyKey, prompt) {
  return [
    "run",
    "send-input",
    "--session-id",
    sessionId,
    "--run-id",
    runId,
    "--idempotency-key",
    idempotencyKey,
    "--content-blocks-json",
    JSON.stringify([{ type: "text", text: prompt }]),
  ];
}

async function waitForDelivery(sessionId, runId, idempotencyKey, prompt, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = sendInput(sessionId, runId, idempotencyKey, prompt);
    if (value.deliveryState !== "pending") return value;
    await delay(25);
  }
  throw new Error(`Run input ${idempotencyKey} did not settle.`);
}

async function waitForTerminal(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse
      .value;
    if (terminalPhases.has(status.phase)) return status;
    await delay(25);
  }
  throw new Error(`Run ${runId} did not become terminal.`);
}

async function waitForActive(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse
      .value;
    if (status.phase === "active") return status;
    if (terminalPhases.has(status.phase)) throw new Error(`Run ${runId} became terminal before it was active.`);
    await delay(25);
  }
  throw new Error(`Run ${runId} did not become active.`);
}

function assertPublicDelivery(value, sessionId, runId) {
  assert.equal(value.sessionId, sessionId);
  assert.equal(value.runId, runId);
  assert.equal(typeof value.messageId, "string");
  assert.equal(["pending", "accepted", "rejected", "ambiguous", "aborted"].includes(value.deliveryState), true);
  const serialized = JSON.stringify(value);
  for (const privateToken of [
    "attemptId",
    "bindingId",
    "providerId",
    "generationId",
    "ownerToken",
    "fake-thread",
    "fake-turn",
  ]) {
    assert.equal(serialized.includes(privateToken), false);
  }
}

function assertTimelineContainsOnce(sessionId, prompt) {
  const messages = runJson(["session", "messages", "--session-id", sessionId, "--limit", "50"], 0).applicationResponse
    .value.items;
  assert.equal(JSON.stringify(messages).split(prompt).length - 1, 1);
}

async function writeSendInputAndDisconnect(sessionId, runId, idempotencyKey, prompt) {
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: appDataRoot });
  const connection = await connectRuntimeEndpoint(identity, { timeoutMs: 5_000 });
  const clientId = randomUUID();
  let closed = false;
  let requestWritten = false;
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
    const operation = "run.send_input";
    const payload = snapshotRuntimeOperationPayload(operation, {
      sessionId,
      runId,
      idempotencyKey,
      contentBlocks: [{ type: "text", text: prompt }],
    });
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
          payload,
        }),
      ),
    );
    requestWritten = true;
    await waitForLog(
      (entries) =>
        countLog(entries, "turn.steered", prompt) === 1 && countLog(entries, "turn.steer_waiting", prompt) === 1,
    );
    assert.equal(fs.existsSync(steerReleaseFile), false);
    await connection.close();
    closed = true;
    fs.writeFileSync(steerReleaseFile, "release\n", "utf8");
    await waitForLog((entries) => countLog(entries, "turn.steer_released", prompt) === 1);
  } finally {
    if (!closed) await connection.close();
    if (requestWritten && !fs.existsSync(steerReleaseFile)) {
      fs.writeFileSync(steerReleaseFile, "release\n", "utf8");
    }
  }
}

async function sendInputsConcurrently(sessionId, runId, inputs) {
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: appDataRoot });
  const connection = await connectRuntimeEndpoint(identity, { timeoutMs: 5_000 });
  const clientId = randomUUID();
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
    const operation = "run.send_input";
    const requests = inputs.map((input, index) => {
      const requestSequence = index + 1;
      return {
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "request",
        hostGenerationId: handshake.hostGenerationId,
        clientId,
        requestId: deriveRuntimeRequestId(clientId, requestSequence),
        requestSequence,
        operation,
        payload: snapshotRuntimeOperationPayload(operation, {
          sessionId,
          runId,
          idempotencyKey: input.idempotencyKey,
          contentBlocks: [{ type: "text", text: input.prompt }],
        }),
      };
    });
    await connection.write(Buffer.from(requests.map((request) => encodeRuntimeIpcEnvelope(request)).join("")));
    const responses = await readEnvelopes(connection, requests.length);
    return responses
      .sort((left, right) => left.requestSequence - right.requestSequence)
      .map((response) => {
        assert.equal(response.kind, "response");
        assert.equal(response.outcome, "success");
        assert.equal(response.operation, operation);
        assert.equal(response.clientId, clientId);
        assert.equal(response.hostGenerationId, handshake.hostGenerationId);
        const applicationResponse = decodeRuntimeWireValue(response.value);
        assert.equal(applicationResponse.overallStatus, "success");
        assertPublicDelivery(applicationResponse.value, sessionId, runId);
        return applicationResponse.value;
      });
  } finally {
    await connection.close();
  }
}

async function readEnvelope(connection) {
  return (await readEnvelopes(connection, 1))[0];
}

async function readEnvelopes(connection, count) {
  const decoder = new RuntimeIpcJsonlDecoder();
  const envelopes = [];
  while (true) {
    const chunk = await connection.read();
    if (chunk === null) throw new Error("Runtime endpoint closed before the handshake response.");
    decoder.push(chunk, (envelope) => envelopes.push(envelope));
    if (envelopes.length >= count) return envelopes;
  }
}

async function waitForLog(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = readLog();
    if (predicate(entries)) return entries;
    await delay(25);
  }
  throw new Error("Fake Codex process observation timed out.");
}

function readLog() {
  if (!fs.existsSync(fakeLogPath)) return [];
  return fs
    .readFileSync(fakeLogPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function countLog(entries, event, prompt) {
  return entries.filter((entry) => entry.event === event && (prompt === undefined || entry.prompt === prompt)).length;
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
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\nstderr: ${result.stderr}`);
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
