import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupControlledRuntimeHost, startControlledRuntimeHost } from "./runtime-host-smoke-support.mjs";

const root = process.cwd();
const cliEntry = path.join(root, "dist", "cli", "entry.js");
const fakeModule = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-run-recovery-smoke-"));
const appDataRoot = path.join(tempDirectory, "app-data");
const workspacePath = path.join(tempDirectory, "workspace");
const fakeCwd = path.join(tempDirectory, "fake-codex");
const fakeLogPath = path.join(tempDirectory, "fake-codex.jsonl");
const fakeStatePath = path.join(tempDirectory, "fake-codex-recovery.json");
const fakeUserAgentPath = path.join(tempDirectory, "fake-codex-user-agent.txt");
const fakeWrapperPath = path.join(fakeCwd, "app-server");
const threadStartHoldFile = path.join(tempDirectory, "hold-thread-start");
const interruptReleaseFile = path.join(tempDirectory, "release-interrupt");
const crashMarker = "UNUSED_PROVIDER_CRASH_MARKER";
const turnStartHoldMarker = "HOLD_TURN_START_BEFORE_RESPONSE";
const activeHoldMarker = "HOLD_ACTIVE_TURN_FOR_RECOVERY";
const cancelResumeHoldMarker = "HOLD_RECOVERED_TURN_FOR_CANCEL";
const environment = isolatedEnvironment(appDataRoot, {
  WITHMATE_CODEX_EXECUTABLE: process.execPath,
  WITHMATE_FAKE_CODEX_CRASH_MARKER: crashMarker,
  WITHMATE_FAKE_CODEX_HOLD_MARKER: activeHoldMarker,
  WITHMATE_FAKE_CODEX_INTERRUPT_RELEASE_FILE: interruptReleaseFile,
  WITHMATE_FAKE_CODEX_LOG: fakeLogPath,
  WITHMATE_FAKE_CODEX_MODULE: pathToFileURL(fakeModule).href,
  WITHMATE_FAKE_CODEX_RECOVERY_STATE: fakeStatePath,
  WITHMATE_FAKE_CODEX_RESUME_HOLD_MARKER: cancelResumeHoldMarker,
  WITHMATE_FAKE_CODEX_THREAD_START_HOLD_FILE: threadStartHoldFile,
  WITHMATE_FAKE_CODEX_TURN_START_HOLD_MARKER: turnStartHoldMarker,
  WITHMATE_FAKE_CODEX_USER_AGENT_FILE: fakeUserAgentPath,
});
const terminalPhases = new Set(["completed", "failed", "canceled", "interrupted"]);
const keys = {
  creatingSession: "018f1f4e-7f0a-7000-8000-000000001001",
  creatingRun: "018f1f4e-7f0a-7000-8000-000000001011",
  ambiguousSession: "018f1f4e-7f0a-7000-8000-000000001002",
  ambiguousRun: "018f1f4e-7f0a-7000-8000-000000001012",
  activeSession: "018f1f4e-7f0a-7000-8000-000000001003",
  activeRun: "018f1f4e-7f0a-7000-8000-000000001013",
  cancelSession: "018f1f4e-7f0a-7000-8000-000000001005",
  cancelRun: "018f1f4e-7f0a-7000-8000-000000001015",
  cancel: "018f1f4e-7f0a-7000-8000-000000001025",
  nextSession: "018f1f4e-7f0a-7000-8000-000000001004",
  nextRun: "018f1f4e-7f0a-7000-8000-000000001014",
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
try {
  await assertFakeRejectsInvalidThreadReads();
  runtimeHost = await startFakeRuntimeHost();

  const creatingSession = createSession("Recovery creating", keys.creatingSession);
  fs.writeFileSync(threadStartHoldFile, "hold", "utf8");
  const creating = startRun(creatingSession, keys.creatingRun, "creating-before-response");
  await waitForLog((entries) => countLog(entries, "thread.start_blocked") === 1);
  await runtimeHost.terminate();
  runtimeHost = undefined;
  fs.rmSync(threadStartHoldFile, { force: true });

  runtimeHost = await startFakeRuntimeHost();
  const creatingTerminal = await waitForTerminal(creatingSession, creating.runId);
  assert.equal(creatingTerminal.phase, "interrupted");
  assert.equal(countLog(readLog(), "thread.started"), 0);

  const ambiguousSession = createSession("Recovery ambiguous", keys.ambiguousSession);
  const ambiguous = startRun(ambiguousSession, keys.ambiguousRun, `ambiguous:${turnStartHoldMarker}`);
  await waitForLog((entries) => countLog(entries, "turn.start_blocked", turnStartHoldMarker) === 1);
  await runtimeHost.terminate();
  runtimeHost = undefined;

  runtimeHost = await startFakeRuntimeHost();
  const ambiguousTerminal = await waitForTerminal(ambiguousSession, ambiguous.runId);
  assert.equal(ambiguousTerminal.phase, "interrupted");
  assert.equal(countLog(readLog(), "turn.started", turnStartHoldMarker), 0);
  assert.equal(countLog(readLog(), "turn.start_blocked", turnStartHoldMarker), 1);

  const activeSession = createSession("Recovery active", keys.activeSession);
  const activePrompt = `active:${activeHoldMarker}`;
  const active = startRun(activeSession, keys.activeRun, activePrompt);
  await waitForPhase(activeSession, active.runId, "active");
  await waitForLog((entries) => countLog(entries, "turn.held", activePrompt) === 1);
  const mutationsBeforeActiveRestart = providerMutationCount(readLog());
  await runtimeHost.terminate();
  runtimeHost = undefined;

  runtimeHost = await startFakeRuntimeHost();
  const activeTerminal = await waitForTerminal(activeSession, active.runId);
  assert.equal(activeTerminal.phase, "completed", JSON.stringify(readLog().slice(-20)));
  assert.equal(countLog(readLog(), "turn.started", activePrompt), 1);
  assert.equal(countLog(readLog(), "thread.read"), 1);
  assert.equal(countLog(readLog(), "thread.resumed"), 1);
  const activeRecoveryLog = readLog();
  const threadRead = activeRecoveryLog.find((entry) => entry.event === "thread.read");
  assert.deepEqual(threadRead?.includeTurns, true);
  assert.equal(
    activeRecoveryLog.findIndex((entry) => entry.event === "thread.read") <
      activeRecoveryLog.findIndex((entry) => entry.event === "thread.resumed"),
    true,
  );
  assert.equal(providerMutationCount(readLog()), mutationsBeforeActiveRestart + 1);
  assertSessionReply(activeSession, activePrompt);

  const cancelSession = createSession("Recovery cancel", keys.cancelSession);
  const cancelPrompt = `cancel:${activeHoldMarker}:${cancelResumeHoldMarker}`;
  const cancelRun = startRun(cancelSession, keys.cancelRun, cancelPrompt);
  await waitForPhase(cancelSession, cancelRun.runId, "active");
  fs.rmSync(interruptReleaseFile, { force: true });
  const cancelAdmission = cancelRunWithKey(cancelSession, cancelRun.runId, keys.cancel);
  assert.equal(cancelAdmission.phase, "canceling");
  await waitForLog((entries) => countLog(entries, "turn.interrupt_requested") === 1);
  await runtimeHost.terminate();
  runtimeHost = undefined;

  runtimeHost = await startFakeRuntimeHost();
  await waitForLog((entries) => countLog(entries, "turn.interrupt_requested") === 2);
  fs.writeFileSync(interruptReleaseFile, "release", "utf8");
  const cancelTerminal = await waitForTerminal(cancelSession, cancelRun.runId);
  assert.equal(cancelTerminal.phase, "canceled");
  assert.equal(countLog(readLog(), "turn.started", cancelPrompt), 1);
  assert.equal(countLog(readLog(), "turn.interrupt_requested"), 2);

  await runtimeHost.stop();
  runtimeHost = undefined;
  const mutationsBeforeIdempotentRestart = providerMutationCount(readLog());
  const processesBeforeIdempotentRestart = countLog(readLog(), "process.started");
  runtimeHost = await startFakeRuntimeHost();
  assert.equal(providerMutationCount(readLog()), mutationsBeforeIdempotentRestart);
  assert.equal(countLog(readLog(), "process.started"), processesBeforeIdempotentRestart);

  const nextSession = createSession("Recovery successor", keys.nextSession);
  const nextPrompt = "normal-after-recovery";
  const next = startRun(nextSession, keys.nextRun, nextPrompt);
  assert.equal((await waitForTerminal(nextSession, next.runId)).phase, "completed");
  assertSessionReply(nextSession, nextPrompt);

  await runtimeHost.stop();
  runtimeHost = undefined;
} finally {
  await cleanupControlledRuntimeHost(runtimeHost, async () => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
}

function startFakeRuntimeHost() {
  return startControlledRuntimeHost(appDataRoot, 15_000, { cwd: fakeCwd, environment });
}

async function assertFakeRejectsInvalidThreadReads() {
  for (const params of [
    { threadId: "thread-1" },
    { threadId: "thread-1", includeTurns: false },
    { threadId: "thread-1", includeTurns: true, unexpected: true },
  ]) {
    const selfTestLog = path.join(tempDirectory, `fake-self-test-${JSON.stringify(params).length}.jsonl`);
    const child = spawn(process.execPath, [fakeWrapperPath], {
      cwd: fakeCwd,
      env: {
        ...environment,
        WITHMATE_FAKE_CODEX_LOG: selfTestLog,
        WITHMATE_FAKE_CODEX_RECOVERY_STATE: "",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(`${JSON.stringify({ id: 1, method: "thread/read", params })}\n`);
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 66);
  }
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

function startRun(sessionId, idempotencyKey, prompt) {
  return runJson(
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
      providerSettingsJson(),
    ],
    0,
  ).applicationResponse.value;
}

function cancelRunWithKey(sessionId, runId, idempotencyKey) {
  return runJson(
    ["run", "cancel", "--session-id", sessionId, "--run-id", runId, "--idempotency-key", idempotencyKey],
    0,
  ).applicationResponse.value;
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

function runStatus(sessionId, runId) {
  return runJson(["run", "status", "--session-id", sessionId, "--run-id", runId], 0).applicationResponse.value;
}

function assertSessionReply(sessionId, expectedPrompt) {
  const messages = runJson(["session", "messages", "--session-id", sessionId, "--limit", "50"], 0).applicationResponse
    .value.items;
  assert.equal(JSON.stringify(messages).includes(`reply:${expectedPrompt}`), true);
}

function providerSettingsJson() {
  return JSON.stringify({
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    settings: {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalPolicy: "never",
      sandbox: { mode: "read-only", networkAccess: false },
    },
  });
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

function countLog(entries, event, promptFragment) {
  return entries.filter(
    (entry) =>
      entry.event === event &&
      (promptFragment === undefined || (typeof entry.prompt === "string" && entry.prompt.includes(promptFragment))),
  ).length;
}

function providerMutationCount(entries) {
  return entries.filter((entry) => ["thread.started", "thread.resumed", "turn.started"].includes(entry.event)).length;
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
  return JSON.parse(result.stdout);
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
