import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-run-start-retry-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const crashMarker = "CRASH_PROVIDER_AFTER_ACCEPTANCE";
const observedUserAgent = "codex-cli/0.146.0";
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: crashMarker,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const sandboxJson = JSON.stringify({ mode: "read-only", networkAccess: false });
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const keys = {
  sessionA: "018f1f4e-7f0a-7000-8000-000000000701",
  sessionB: "018f1f4e-7f0a-7000-8000-000000000702",
  sessionC: "018f1f4e-7f0a-7000-8000-000000000703",
  startA: "018f1f4e-7f0a-7000-8000-000000000711",
  retryA: "018f1f4e-7f0a-7000-8000-000000000712",
  responseLoss: "018f1f4e-7f0a-7000-8000-000000000713",
  simultaneousB: "018f1f4e-7f0a-7000-8000-000000000714",
  simultaneousC: "018f1f4e-7f0a-7000-8000-000000000715",
  providerCrash: "018f1f4e-7f0a-7000-8000-000000000716",
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
fs.writeFileSync(fakeUserAgentPath, observedUserAgent, "utf8");

let runtimeHost;
try {
  runtimeHost = await startFakeRuntimeHost();
  const sessionA = createSession("Process smoke A", keys.sessionA);

  const normalPrompt = "normal-start";
  const normalAdmission = startRun(sessionA, keys.startA, normalPrompt);
  const normalStatus = await waitForTerminal(sessionA, normalAdmission.runId);
  assert.equal(normalStatus.phase, "completed");
  assertSessionReply(sessionA, normalPrompt);
  await waitForLog((entries) => countLog(entries, "turn.completed", normalPrompt) === 1);
  assert.equal(countLog(readLog(), "thread.started"), 1);

  const stdinClosuresBeforeFirstShutdown = countLog(readLog(), "process.stdin_closed");
  const firstShutdown = await runtimeHost.stop();
  assert.equal(firstShutdown.checkpoint, "completed");
  runtimeHost = undefined;
  assert.equal(countLog(readLog(), "process.stdin_closed"), stdinClosuresBeforeFirstShutdown + 1);

  runtimeHost = await startFakeRuntimeHost();
  const replayBefore = providerMutationCount(readLog());
  const providerProcessesBeforeReplay = countLog(readLog(), "process.started");
  const normalReplay = startRun(sessionA, keys.startA, normalPrompt);
  assert.equal(normalReplay.runId, normalAdmission.runId);
  assert.equal(normalReplay.phase, "completed");
  assert.equal(providerMutationCount(readLog()), replayBefore);
  assert.equal(countLog(readLog(), "process.started"), providerProcessesBeforeReplay);

  const retryAdmission = retryRun(sessionA, normalAdmission.runId, keys.retryA);
  assert.equal(retryAdmission.retryOfRunId, normalAdmission.runId);
  const retryStatus = await waitForTerminal(sessionA, retryAdmission.runId);
  assert.equal(retryStatus.phase, "completed");
  await waitForLog((entries) => countLog(entries, "thread.resumed") === 1);

  const responseLossPrompt = "response-loss-exact-replay";
  await writeRunStartAndDisconnect(sessionA, keys.responseLoss, responseLossPrompt);
  await waitForLog((entries) => countLog(entries, "turn.started", responseLossPrompt) === 1);
  const responseLossReplay = startRun(sessionA, keys.responseLoss, responseLossPrompt);
  const responseLossStatus = await waitForTerminal(sessionA, responseLossReplay.runId);
  assert.equal(responseLossStatus.phase, "completed");
  assert.equal(countLog(readLog(), "turn.started", responseLossPrompt), 1);
  assertSessionReply(sessionA, responseLossPrompt);

  const sessionB = createSession("Process smoke B", keys.sessionB);
  const sessionC = createSession("Process smoke C", keys.sessionC);
  const promptB = "simultaneous-session-b";
  const promptC = "simultaneous-session-c";
  const [admissionB, admissionC] = await Promise.all([
    startRunAsync(sessionB, keys.simultaneousB, promptB),
    startRunAsync(sessionC, keys.simultaneousC, promptC),
  ]);
  const [statusB, statusC] = await Promise.all([
    waitForTerminal(sessionB, admissionB.runId),
    waitForTerminal(sessionC, admissionC.runId),
  ]);
  assert.equal(statusB.phase, "completed");
  assert.equal(statusC.phase, "completed");
  assertSessionReply(sessionB, promptB, promptC);
  assertSessionReply(sessionC, promptC, promptB);

  const crashAdmission = startRun(sessionB, keys.providerCrash, `trigger:${crashMarker}`);
  await waitForLog((entries) => entries.some((entry) => entry.event === "process.crashing"));
  const crashStatus = await waitForTerminal(sessionB, crashAdmission.runId);
  assert.equal(crashStatus.phase, "interrupted");
  assert.equal(runtimeHost.isRunning(), true);
  const readableAfterCrash = runJson(["session", "read", "--session-id", sessionB], 0);
  assert.equal(readableAfterCrash.applicationResponse.value.session.id, sessionB);

  const finalShutdown = await runtimeHost.stop();
  assert.equal(finalShutdown.checkpoint, "completed");
  runtimeHost = undefined;
  assert.equal(countLog(readLog(), "process.stdin_closed") >= 1, true);
} finally {
  await cleanupControlledRuntimeHost(runtimeHost, async () => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
}

function startFakeRuntimeHost() {
  return startControlledRuntimeHost(appDataRoot, 15_000, {
    cwd: fakeCwd,
    environment,
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

function startRun(sessionId, idempotencyKey, prompt) {
  return runJson(startArgs(sessionId, idempotencyKey, prompt), 0).applicationResponse.value;
}

async function startRunAsync(sessionId, idempotencyKey, prompt) {
  return (await runJsonAsync(startArgs(sessionId, idempotencyKey, prompt), 0)).applicationResponse.value;
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

function retryRun(sessionId, retryOfRunId, idempotencyKey) {
  return runJson(
    ["run", "retry", "--session-id", sessionId, "--retry-of-run-id", retryOfRunId, "--idempotency-key", idempotencyKey],
    0,
  ).applicationResponse.value;
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

function assertSessionReply(sessionId, expectedPrompt, rejectedPrompt) {
  const messages = runJson(["session", "messages", "--session-id", sessionId, "--limit", "50"], 0).applicationResponse
    .value.items;
  const serialized = JSON.stringify(messages);
  assert.match(serialized, new RegExp(escapeRegExp(`reply:${expectedPrompt}`), "u"));
  if (rejectedPrompt !== undefined) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(`reply:${rejectedPrompt}`), "u"));
  }
}

async function writeRunStartAndDisconnect(sessionId, idempotencyKey, prompt) {
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
    const requestSequence = 1;
    const operation = "run.start";
    const payload = snapshotRuntimeOperationPayload(operation, {
      sessionId,
      idempotencyKey,
      contentBlocks: [{ type: "text", text: prompt }],
      providerSettings: JSON.parse(providerSettingsJson('{"mode":"read-only","networkAccess":false}')),
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
  } finally {
    await connection.close();
  }
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

async function readEnvelope(connection) {
  const decoder = new RuntimeIpcJsonlDecoder();
  while (true) {
    const chunk = await connection.read();
    if (chunk === null) throw new Error("Runtime endpoint closed before the handshake response.");
    const envelopes = [];
    decoder.push(chunk, (envelope) => envelopes.push(envelope));
    if (envelopes.length > 0) return envelopes[0];
  }
}

function providerMutationCount(entries) {
  return entries.filter((entry) => ["thread.started", "thread.resumed", "turn.started"].includes(entry.event)).length;
}

function countLog(entries, event, prompt) {
  return entries.filter((entry) => entry.event === event && (prompt === undefined || entry.prompt === prompt)).length;
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
  const contents = fs.readFileSync(fakeLogPath, "utf8");
  return contents
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function runJson(args, expectedStatus) {
  const result = invoke(args);
  return assertJsonResult(result, args, expectedStatus);
}

async function runJsonAsync(args, expectedStatus) {
  const result = await invokeAsync(args);
  return assertJsonResult(result, args, expectedStatus);
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `${args.join(" ")} failed to spawn`);
  assert.notEqual(result.status, null, `${args.join(" ")} did not exit`);
  return result;
}

function invokeAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (signal !== null) {
        reject(new Error(`${args.join(" ")} exited with ${signal}.`));
        return;
      }
      resolve({ status, stdout, stderr, error: undefined });
    });
  });
}

function assertJsonResult(result, args, expectedStatus) {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
