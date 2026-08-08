import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupControlledRuntimeHost, startControlledRuntimeHost } from "./runtime-host-smoke-support.mjs";

const root = process.cwd();
const cliEntry = path.join(root, "dist", "cli", "entry.js");
const fakeModule = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-cp03-single-session-gate-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeStatePath = path.join(tempDirectory, "fake-codex-state.json");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const holdMarker = "CP03_SINGLE_SESSION_HOLD";
const interactionMarker = "CP03_SINGLE_SESSION_INTERACTION";
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: "CP03_UNUSED_PROVIDER_CRASH",
  WITHMATE_FAKE_CODEX_HOLD_MARKER: holdMarker,
  WITHMATE_FAKE_CODEX_INTERACTION_MARKER: interactionMarker,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_RECOVERY_STATE: fakeStatePath,
  WITHMATE_FAKE_CODEX_SAFE_LOG: "1",
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const keys = {
  primarySession: "018f1f4e-7f0a-7000-8000-000000001101",
  secondarySession: "018f1f4e-7f0a-7000-8000-000000001102",
  bootstrap: "018f1f4e-7f0a-7000-8000-000000001111",
  held: "018f1f4e-7f0a-7000-8000-000000001112",
  conflictingStart: "018f1f4e-7f0a-7000-8000-000000001113",
  conflictingRetry: "018f1f4e-7f0a-7000-8000-000000001114",
  archive: "018f1f4e-7f0a-7000-8000-000000001115",
  close: "018f1f4e-7f0a-7000-8000-000000001116",
  delete: "018f1f4e-7f0a-7000-8000-000000001117",
  input: "018f1f4e-7f0a-7000-8000-000000001118",
  interactionRun: "018f1f4e-7f0a-7000-8000-000000001121",
  interactionResponse: "018f1f4e-7f0a-7000-8000-000000001122",
  cancelPrimary: "018f1f4e-7f0a-7000-8000-000000001123",
  cancelSecondary: "018f1f4e-7f0a-7000-8000-000000001124",
  successor: "018f1f4e-7f0a-7000-8000-000000001131",
  recovery: "018f1f4e-7f0a-7000-8000-000000001132",
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
fs.writeFileSync(fakeUserAgentPath, "codex-cli/0.146.0", "utf8");

let runtimeHost;
const publicOutputs = [];
try {
  runtimeHost = await startRuntimeHost();
  const primarySession = createSession("CP3 primary Session", keys.primarySession);
  const secondarySession = createSession("CP3 secondary Session", keys.secondarySession);

  const bootstrapPrompt = "primary-bootstrap";
  const bootstrap = startRun(primarySession, keys.bootstrap, bootstrapPrompt);
  assert.equal((await waitForTerminal(primarySession, bootstrap.runId)).phase, "completed");

  const heldPrompt = `primary-held:${holdMarker}`;
  const held = startRun(primarySession, keys.held, heldPrompt);
  await waitForPhase(primarySession, held.runId, "active");
  const providerMutationsBeforeReplay = providerMutationCount();
  const heldReplay = startRun(primarySession, keys.held, heldPrompt);
  assert.equal(heldReplay.runId, held.runId);
  assert.equal(providerMutationCount(), providerMutationsBeforeReplay);

  assertDomainFailure(
    runJson(startArgs(primarySession, keys.conflictingStart, "conflicting-start"), 22),
    "session_busy",
  );
  assertDomainFailure(
    runJson(
      [
        "run",
        "retry",
        "--session-id",
        primarySession,
        "--retry-of-run-id",
        bootstrap.runId,
        "--idempotency-key",
        keys.conflictingRetry,
      ],
      22,
    ),
    "session_busy",
  );
  assertDomainFailure(
    runJson(["session", "archive", "--session-id", primarySession, "--idempotency-key", keys.archive], 22),
    "session_busy",
  );
  assertDomainFailure(
    runJson(
      [
        "session",
        "close",
        "--session-id",
        primarySession,
        "--idempotency-key",
        keys.close,
        "--expected-lifecycle-status",
        "active",
      ],
      22,
    ),
    "session_busy",
  );
  assertDomainFailure(
    runJson(
      ["session", "delete", "--session-id", primarySession, "--idempotency-key", keys.delete, "--confirm-local-only"],
      22,
    ),
    "session_busy",
  );
  assert.equal(providerMutationCount(), providerMutationsBeforeReplay);

  const secondaryPrompt = interactionMarker;
  const secondary = startRun(secondarySession, keys.interactionRun, secondaryPrompt, "on-request");
  const interaction = await waitForInteraction(secondarySession, secondary.runId);
  assert.equal(runStatus(primarySession, held.runId).phase, "active");
  assert.equal(interaction.kind, "codex.command_approval");
  assert.equal(interaction.display.command, "node --version");
  assertNotContains(interaction, workspacePath);

  const activePrimary = sessionRead(primarySession).applicationResponse.value.execution;
  assert.equal(activePrimary.state, "running");
  assert.equal(activePrimary.activeRunId, held.runId);
  assert.equal(activePrimary.latestRunId, held.runId);

  const mutationsBeforeCrossSessionRequests = providerMutationCount();
  assertDomainFailure(
    runJson(
      [
        "run",
        "send-input",
        "--session-id",
        primarySession,
        "--run-id",
        secondary.runId,
        "--idempotency-key",
        keys.input,
        "--content-blocks-json",
        JSON.stringify([{ type: "text", text: "cross-session-input" }]),
      ],
      22,
    ),
    "not_found",
  );
  assertDomainFailure(
    runJson(
      [
        "run",
        "respond-interaction",
        "--session-id",
        primarySession,
        "--run-id",
        secondary.runId,
        "--idempotency-key",
        keys.interactionResponse,
        "--response-json",
        JSON.stringify({
          interactionId: interaction.interactionId,
          kind: interaction.kind,
          payload: { decision: "accept" },
        }),
      ],
      30,
    ),
    "persistence_operation_failed",
    "persistence",
  );
  assertDomainFailure(
    runJson(
      [
        "run",
        "cancel",
        "--session-id",
        primarySession,
        "--run-id",
        secondary.runId,
        "--idempotency-key",
        keys.cancelSecondary,
      ],
      30,
    ),
    "persistence_operation_failed",
    "persistence",
  );
  assert.equal(providerMutationCount(), mutationsBeforeCrossSessionRequests);
  assert.equal(runStatus(primarySession, held.runId).phase, "active");
  assert.equal(readInteractions(secondarySession, secondary.runId).interactions.length, 1);

  const inputPrompt = "primary-supplemental";
  const inputAdmission = sendInput(primarySession, held.runId, keys.input, inputPrompt);
  const input = await waitForInput(primarySession, held.runId, keys.input, inputPrompt);
  assert.equal(input.deliveryState, "accepted");
  assert.equal(input.messageId, inputAdmission.messageId);
  const steerCount = countLog("turn.steered");
  assert.deepEqual(sendInput(primarySession, held.runId, keys.input, inputPrompt), input);
  assert.equal(countLog("turn.steered"), steerCount);
  assert.equal(readInteractions(secondarySession, secondary.runId).interactions.length, 1);

  const response = {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    payload: { decision: "accept" },
  };
  const responseAdmission = respondInteraction(secondarySession, secondary.runId, keys.interactionResponse, response);
  assert.equal(responseAdmission.applicationResponse.overallStatus, "success");
  const settledResponse = await waitForInteractionResponse(
    secondarySession,
    secondary.runId,
    keys.interactionResponse,
    response,
  );
  const responseCount = countLog("interaction.response");
  assert.deepEqual(
    respondInteraction(secondarySession, secondary.runId, keys.interactionResponse, response),
    settledResponse,
  );
  assert.equal(countLog("interaction.response"), responseCount);

  const [primaryTerminal, secondaryTerminal] = await Promise.all([
    cancelRun(primarySession, held.runId, keys.cancelPrimary),
    cancelRun(secondarySession, secondary.runId, keys.cancelSecondary),
  ]);
  assert.equal(primaryTerminal.phase, "canceled");
  assert.equal(secondaryTerminal.phase, "canceled");
  const released = sessionRead(primarySession).applicationResponse.value;
  assert.equal(released.execution.state, "canceled");
  assert.equal(released.execution.latestRunId, held.runId);
  assert.equal(Object.hasOwn(released.execution, "activeRunId"), false);

  const successorPrompt = "primary-successor";
  const successor = startRun(primarySession, keys.successor, successorPrompt);
  assert.equal((await waitForTerminal(primarySession, successor.runId)).phase, "completed");

  const recoveryPrompt = `primary-recovery:${holdMarker}`;
  const recovery = startRun(primarySession, keys.recovery, recoveryPrompt);
  await waitForPhase(primarySession, recovery.runId, "active");
  const turnStartsBeforeRestart = countLog("turn.started");
  await runtimeHost.terminate();
  runtimeHost = undefined;

  runtimeHost = await startRuntimeHost();
  const recovered = await waitForTerminal(primarySession, recovery.runId);
  assert.equal(recovered.phase, "completed");
  assert.equal(countLog("turn.started"), turnStartsBeforeRestart);
  assert.equal(countLog("thread.read") >= 1, true);
  assert.equal(countLog("thread.resumed") >= 1, true);

  const primaryMessages = sessionMessages(primarySession);
  const secondaryMessages = sessionMessages(secondarySession);
  assertContains(primaryMessages, bootstrapPrompt);
  assertContains(primaryMessages, heldPrompt);
  assertContains(primaryMessages, inputPrompt);
  assertContains(primaryMessages, successorPrompt);
  assertContains(primaryMessages, recoveryPrompt);
  assertNotContains(primaryMessages, secondaryPrompt);
  assertContains(secondaryMessages, secondaryPrompt);
  assertNotContains(secondaryMessages, inputPrompt);

  const runs = runJson(["session", "runs", "--session-id", primarySession, "--limit", "50"], 0).applicationResponse
    .value.items;
  const primaryRunOrdinals = new Map(runs.map((run) => [run.runId, run.ordinal]));
  assert.deepEqual(
    [bootstrap.runId, held.runId, successor.runId, recovery.runId].map((runId) => primaryRunOrdinals.get(runId)),
    [1, 2, 3, 4],
  );
  assert.equal(primaryRunOrdinals.has(secondary.runId), false);

  publicOutputs.push(
    sessionRead(primarySession),
    sessionRead(secondarySession),
    primaryMessages,
    secondaryMessages,
    runs,
    runStatus(primarySession, recovery.runId),
  );
  assertPublicBoundary(publicOutputs);

  const shutdown = await runtimeHost.stop();
  assert.equal(shutdown.checkpoint, "completed");
  runtimeHost = undefined;
} finally {
  await cleanupControlledRuntimeHost(runtimeHost, async () => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
}

function startRuntimeHost() {
  return startControlledRuntimeHost(appDataRoot, 15_000, { cwd: fakeCwd, environment });
}

function createSession(title, idempotencyKey) {
  const output = runJson(
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
  publicOutputs.push(output);
  return output.applicationResponse.value.sessionId;
}

function startRun(sessionId, idempotencyKey, prompt, approvalPolicy = "never") {
  const output = runJson(startArgs(sessionId, idempotencyKey, prompt, approvalPolicy), 0);
  publicOutputs.push(output);
  return output.applicationResponse.value;
}

function startArgs(sessionId, idempotencyKey, prompt, approvalPolicy = "never") {
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
    providerSettingsJson(approvalPolicy),
  ];
}

function providerSettingsJson(approvalPolicy) {
  return JSON.stringify({
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    settings: {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalPolicy,
      sandbox: { mode: "read-only", networkAccess: false },
    },
  });
}

function sendInput(sessionId, runId, idempotencyKey, prompt) {
  const output = runJson(
    [
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
    ],
    0,
  );
  publicOutputs.push(output);
  return output.applicationResponse.value;
}

async function waitForInput(sessionId, runId, idempotencyKey, prompt, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = sendInput(sessionId, runId, idempotencyKey, prompt);
    if (value.deliveryState !== "pending") return value;
    await delay(25);
  }
  throw new Error(`Run input ${idempotencyKey} did not settle.`);
}

function readInteractions(sessionId, runId) {
  const output = runJson(["run", "interactions", "--session-id", sessionId, "--run-id", runId], 0);
  publicOutputs.push(output);
  return output.applicationResponse.value;
}

async function waitForInteraction(sessionId, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readInteractions(sessionId, runId);
    if (value.interactions.length === 1) {
      assert.equal(value.sessionId, sessionId);
      assert.equal(value.runId, runId);
      return value.interactions[0];
    }
    if (terminalPhases.has(runStatus(sessionId, runId).phase)) {
      throw new Error(`Run ${runId} became terminal before exposing its interaction.`);
    }
    await delay(25);
  }
  throw new Error(`Run ${runId} did not expose an interaction.`);
}

function respondInteraction(sessionId, runId, idempotencyKey, response) {
  const output = runJson(
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
    0,
  );
  publicOutputs.push(output);
  return output;
}

async function waitForInteractionResponse(sessionId, runId, idempotencyKey, response, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = respondInteraction(sessionId, runId, idempotencyKey, response);
    if (output.applicationResponse.value.effectCertainty === "resolved") return output;
    await delay(25);
  }
  throw new Error(`Interaction response ${idempotencyKey} did not resolve.`);
}

async function cancelRun(sessionId, runId, idempotencyKey) {
  const output = runJson(
    ["run", "cancel", "--session-id", sessionId, "--run-id", runId, "--idempotency-key", idempotencyKey],
    0,
  );
  publicOutputs.push(output);
  return waitForTerminal(sessionId, runId);
}

function runStatus(sessionId, runId) {
  const output = runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0);
  publicOutputs.push(output);
  return output.applicationResponse.value;
}

async function waitForPhase(sessionId, runId, phase, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runStatus(sessionId, runId);
    if (status.phase === phase) return status;
    if (terminalPhases.has(status.phase)) throw new Error(`Run ${runId} became ${status.phase} before ${phase}.`);
    await delay(25);
  }
  throw new Error(`Run ${runId} did not become ${phase}.`);
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

function sessionRead(sessionId) {
  const output = runJson(["session", "read", "--session-id", sessionId], 0);
  publicOutputs.push(output);
  return output;
}

function sessionMessages(sessionId) {
  const output = runJson(["session", "messages", "--session-id", sessionId, "--limit", "50"], 0);
  publicOutputs.push(output);
  return output.applicationResponse.value.items;
}

function assertDomainFailure(output, code, kind = "domain") {
  publicOutputs.push(output);
  assert.equal(output.applicationResponse.overallStatus, "failure");
  assert.equal(output.applicationResponse.error.kind, kind);
  assert.equal(output.applicationResponse.error.code, code);
}

function assertContains(value, expected) {
  assert.equal(JSON.stringify(value).includes(expected), true, `expected ${expected}`);
}

function assertNotContains(value, rejected) {
  assert.equal(JSON.stringify(value).includes(rejected), false, `rejected ${rejected}`);
}

function assertPublicBoundary(outputs) {
  const serialized = JSON.stringify(outputs);
  for (const privateValue of [
    appDataRoot,
    fakeCwd,
    fakeStatePath,
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
    '"params"',
    '"result"',
  ]) {
    assert.equal(serialized.includes(privateValue), false, `public boundary leaked ${privateValue}`);
  }
}

function providerMutationCount() {
  return readLog().filter((entry) =>
    [
      "thread.started",
      "thread.resumed",
      "turn.started",
      "turn.steered",
      "turn.interrupt_requested",
      "interaction.response",
    ].includes(entry.event),
  ).length;
}

function countLog(event) {
  return readLog().filter((entry) => entry.event === event).length;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
