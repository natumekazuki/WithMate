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
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-run-interactions-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const interactionResolveFile = path.join(tempDirectory, "resolve-interaction");
const crashMarker = "CRASH_PROVIDER_AFTER_ACCEPTANCE";
const interactionMarker = "REQUEST_COMMAND_APPROVAL";
const resolvedFirstMarker = "RESOLVE_COMMAND_APPROVAL_FIRST";
const secretMarker = "INTERACTION_SMOKE_SECRET_MUST_NOT_BE_LOGGED";
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: crashMarker,
  WITHMATE_FAKE_CODEX_INTERACTION_MARKER: interactionMarker,
  WITHMATE_FAKE_CODEX_INTERACTION_RESOLVED_FIRST_MARKER: resolvedFirstMarker,
  WITHMATE_FAKE_CODEX_INTERACTION_RESOLVE_FILE: interactionResolveFile,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_SAFE_LOG: "1",
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const keys = {
  sessionResponse: "018f1f4e-7f0a-7000-8000-000000000a01",
  runResponse: "018f1f4e-7f0a-7000-8000-000000000a02",
  response: "018f1f4e-7f0a-7000-8000-000000000a03",
  responseConflict: "018f1f4e-7f0a-7000-8000-000000000a04",
  cancelResponse: "018f1f4e-7f0a-7000-8000-000000000a05",
  sessionDisconnect: "018f1f4e-7f0a-7000-8000-000000000a11",
  runDisconnect: "018f1f4e-7f0a-7000-8000-000000000a12",
  disconnectResponse: "018f1f4e-7f0a-7000-8000-000000000a13",
  cancelDisconnect: "018f1f4e-7f0a-7000-8000-000000000a14",
  sessionResolved: "018f1f4e-7f0a-7000-8000-000000000a21",
  runResolved: "018f1f4e-7f0a-7000-8000-000000000a22",
  resolvedLate: "018f1f4e-7f0a-7000-8000-000000000a23",
  cancelResolved: "018f1f4e-7f0a-7000-8000-000000000a24",
  sessionTerminal: "018f1f4e-7f0a-7000-8000-000000000a31",
  runTerminal: "018f1f4e-7f0a-7000-8000-000000000a32",
  cancelTerminal: "018f1f4e-7f0a-7000-8000-000000000a33",
  terminalLate: "018f1f4e-7f0a-7000-8000-000000000a34",
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

  const responseSession = createSession("Interaction response smoke", keys.sessionResponse);
  const responseRun = startInteractionRun(
    responseSession,
    keys.runResponse,
    `${interactionMarker}:response-first:${secretMarker}`,
  );
  const responseInteraction = await waitForInteraction(responseSession, responseRun);
  assertCommandInteraction(responseInteraction);
  const publicSnapshot = JSON.stringify(responseInteraction);
  for (const rawProviderToken of ["fake-thread", "fake-turn", "fake-command", "fake-approval", secretMarker]) {
    assert.equal(publicSnapshot.includes(rawProviderToken), false);
  }

  const acceptedResponse = interactionResponse(responseInteraction, "accept");
  const initialResponse = respondInteraction(responseSession, responseRun, keys.response, acceptedResponse, 0);
  assert.equal(initialResponse.applicationResponse.overallStatus, "success");
  assertPublicOutput(initialResponse);
  await waitForInteractionResponseCount(1);
  const resolvedResponse = await waitForResponseCertainty(
    responseSession,
    responseRun,
    keys.response,
    acceptedResponse,
    "resolved",
  );
  assert.equal(resolvedResponse.applicationResponse.persistence.replayed, true);
  assertPublicOutput(resolvedResponse);
  assert.equal(countLog("interaction.response"), 1);

  const sameKeyConflict = respondInteraction(
    responseSession,
    responseRun,
    keys.response,
    interactionResponse(responseInteraction, "decline"),
    22,
  );
  assertDomainFailure(sameKeyConflict, "idempotency_conflict");
  const differentKeyConflict = respondInteraction(
    responseSession,
    responseRun,
    keys.responseConflict,
    acceptedResponse,
    22,
  );
  assertDomainFailure(differentKeyConflict, ["lifecycle_conflict", "reference_invalid"]);
  assert.equal(countLog("interaction.response"), 1);
  await cancelRun(responseSession, responseRun, keys.cancelResponse);

  const disconnectSession = createSession("Interaction disconnect smoke", keys.sessionDisconnect);
  const disconnectRun = startInteractionRun(disconnectSession, keys.runDisconnect, interactionMarker);
  const disconnectInteraction = await waitForInteraction(disconnectSession, disconnectRun);
  const disconnectedResponse = interactionResponse(disconnectInteraction, "decline");
  await writeResponseAndDisconnect(disconnectSession, disconnectRun, keys.disconnectResponse, disconnectedResponse, 2);
  assert.equal(runtimeHost.isRunning(), true);
  const disconnectedReplay = await waitForResponseCertainty(
    disconnectSession,
    disconnectRun,
    keys.disconnectResponse,
    disconnectedResponse,
    "resolved",
  );
  assert.equal(disconnectedReplay.applicationResponse.persistence.replayed, true);
  assertPublicOutput(disconnectedReplay);
  assert.equal(countLog("interaction.response"), 2);
  assert.equal(
    runJson(["session", "read", "--session-id", disconnectSession], 0).applicationResponse.value.session.id,
    disconnectSession,
  );
  await cancelRun(disconnectSession, disconnectRun, keys.cancelDisconnect);

  fs.rmSync(interactionResolveFile, { force: true });
  const resolvedSession = createSession("Interaction resolved-first smoke", keys.sessionResolved);
  const resolvedRun = startInteractionRun(
    resolvedSession,
    keys.runResolved,
    `${interactionMarker}:${resolvedFirstMarker}`,
  );
  const resolvedFirstInteraction = await waitForInteraction(resolvedSession, resolvedRun);
  fs.writeFileSync(interactionResolveFile, "resolve\n", "utf8");
  await waitForNoInteractions(resolvedSession, resolvedRun);
  await waitForLog((entries) => countEntries(entries, "interaction.resolved", "resolved_first") === 1);
  const resolvedLate = respondInteraction(
    resolvedSession,
    resolvedRun,
    keys.resolvedLate,
    interactionResponse(resolvedFirstInteraction, "accept"),
    22,
  );
  assertDomainFailure(resolvedLate, ["lifecycle_conflict", "reference_invalid", "not_found"]);
  assert.equal(countLog("interaction.response"), 2);
  await cancelRun(resolvedSession, resolvedRun, keys.cancelResolved);

  const terminalSession = createSession("Interaction terminal race smoke", keys.sessionTerminal);
  const terminalRun = startInteractionRun(terminalSession, keys.runTerminal, interactionMarker);
  const terminalInteraction = await waitForInteraction(terminalSession, terminalRun);
  await cancelRun(terminalSession, terminalRun, keys.cancelTerminal);
  await waitForNoInteractions(terminalSession, terminalRun);
  const terminalLate = respondInteraction(
    terminalSession,
    terminalRun,
    keys.terminalLate,
    interactionResponse(terminalInteraction, "accept"),
    22,
  );
  assertDomainFailure(terminalLate, ["lifecycle_conflict", "reference_invalid", "not_found"]);
  assert.equal(countLog("interaction.response"), 2);

  const safeLogText = fs.readFileSync(fakeLogPath, "utf8");
  for (const privateValue of [
    appDataRoot,
    workspacePath,
    fakeCwd,
    secretMarker,
    "fake-thread",
    "fake-turn",
    "fake-command",
    "fake-approval",
    '"params"',
    '"result"',
  ]) {
    assert.equal(safeLogText.includes(privateValue), false, `safe fake log leaked ${privateValue}`);
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

function startInteractionRun(sessionId, idempotencyKey, prompt) {
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
      "--provider-settings-json",
      JSON.stringify({
        providerId: "codex",
        definitionVersion: "codex-provider-v1",
        settings: {
          model: "gpt-5.4",
          reasoningEffort: "medium",
          approvalPolicy: "on-request",
          sandbox: { mode: "read-only", networkAccess: false },
        },
      }),
    ],
    0,
  ).applicationResponse.value;
  assert.equal(admission.phase, "queued");
  return admission.runId;
}

function readInteractions(sessionId, runId) {
  return runJson(["run", "interactions", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse.value;
}

async function waitForInteraction(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = readInteractions(sessionId, runId);
    if (snapshot.interactions.length === 1) {
      assert.equal(snapshot.sessionId, sessionId);
      assert.equal(snapshot.runId, runId);
      return snapshot.interactions[0];
    }
    const status = runStatus(sessionId, runId);
    if (terminalPhases.has(status.phase)) throw new Error(`Run ${runId} became terminal before interaction admission.`);
    await delay(25);
  }
  throw new Error(`Run ${runId} did not expose an interaction.`);
}

async function waitForNoInteractions(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readInteractions(sessionId, runId).interactions.length === 0) return;
    await delay(25);
  }
  throw new Error(`Run ${runId} retained a terminal or resolved interaction.`);
}

function assertCommandInteraction(interaction) {
  assert.equal(interaction.providerId, "codex");
  assert.equal(interaction.definitionVersion, "codex-provider-v1");
  assert.equal(interaction.kind, "codex.command_approval");
  assert.equal(interaction.answerable, true);
  assert.deepEqual(interaction.display, {
    summary: "Codex requests permission to run a command.",
    command: "node --version",
    availableDecisions: ["accept", "decline", "cancel"],
  });
}

function interactionResponse(interaction, decision) {
  return {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    payload: { decision },
  };
}

function respondInteraction(sessionId, runId, idempotencyKey, response, expectedStatus) {
  return runJson(
    [
      "run",
      "respond-interaction",
      "--session-id",
      sessionId,
      "--run-id",
      runId,
      "--idempotency-key",
      idempotencyKey,
      "--response-json",
      JSON.stringify(response),
    ],
    expectedStatus,
  );
}

async function waitForResponseCertainty(sessionId, runId, idempotencyKey, response, certainty, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = respondInteraction(sessionId, runId, idempotencyKey, response, 0);
    if (output.applicationResponse.value.effectCertainty === certainty) return output;
    await delay(25);
  }
  throw new Error(`Interaction response ${idempotencyKey} did not reach ${certainty}.`);
}

function assertDomainFailure(output, code) {
  assert.equal(output.applicationResponse.overallStatus, "failure");
  assert.equal(output.applicationResponse.error.kind, "domain");
  const acceptedCodes = Array.isArray(code) ? code : [code];
  assert.equal(
    acceptedCodes.includes(output.applicationResponse.error.code),
    true,
    `expected ${acceptedCodes.join(" or ")}, received ${String(output.applicationResponse.error.code)}`,
  );
}

function assertPublicOutput(output) {
  const serialized = JSON.stringify(output);
  for (const privateValue of [
    appDataRoot,
    workspacePath,
    fakeCwd,
    secretMarker,
    "fake-thread",
    "fake-turn",
    "fake-command",
    "fake-approval",
    "attemptId",
    "bindingId",
    "externalConversationId",
    "externalExecutionId",
    "generationId",
    "ownerToken",
    "responseRefId",
  ]) {
    assert.equal(serialized.includes(privateValue), false, `public output leaked ${privateValue}`);
  }
}

async function cancelRun(sessionId, runId, idempotencyKey) {
  const output = runJson(
    ["run", "cancel", "--session-id", sessionId, "--run-id", runId, "--idempotency-key", idempotencyKey],
    0,
  );
  assert.equal(output.applicationResponse.overallStatus, "success");
  return waitForTerminal(sessionId, runId);
}

function runStatus(sessionId, runId) {
  return runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse.value;
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

async function writeResponseAndDisconnect(sessionId, runId, idempotencyKey, response, expectedResponseCount) {
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
    const operation = "run.respond_interaction";
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
          payload: snapshotRuntimeOperationPayload(operation, {
            sessionId,
            runId,
            idempotencyKey,
            response,
          }),
        }),
      ),
    );
    await waitForInteractionResponseCount(expectedResponseCount);
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

async function waitForInteractionResponseCount(expectedCount, timeoutMs = 15_000) {
  return waitForLog((entries) => countEntries(entries, "interaction.response") === expectedCount, timeoutMs);
}

async function waitForLog(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = readLog();
    if (predicate(entries)) return entries;
    await delay(25);
  }
  throw new Error("Fake Codex interaction observation timed out.");
}

function countLog(event) {
  return countEntries(readLog(), event);
}

function countEntries(entries, event, order) {
  return entries.filter((entry) => entry.event === event && (order === undefined || entry.order === order)).length;
}

function readLog() {
  if (!fs.existsSync(fakeLogPath)) return [];
  return fs
    .readFileSync(fakeLogPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
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
