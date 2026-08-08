import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logPath = requiredEnvironment("WITHMATE_FAKE_CODEX_LOG");
const crashMarker = requiredEnvironment("WITHMATE_FAKE_CODEX_CRASH_MARKER");
const userAgentPath = requiredEnvironment("WITHMATE_FAKE_CODEX_USER_AGENT_FILE");
const holdMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_HOLD_MARKER");
const steerHoldMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_STEER_HOLD_MARKER");
const steerReleaseFile = optionalEnvironment("WITHMATE_FAKE_CODEX_STEER_RELEASE_FILE");
const steerRejectMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_STEER_REJECT_MARKER");
const steerCrashMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_STEER_CRASH_MARKER");
const steerTerminalMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_STEER_TERMINAL_MARKER");
const interruptReleaseFile = optionalEnvironment("WITHMATE_FAKE_CODEX_INTERRUPT_RELEASE_FILE");
const interruptNaturalCompletionMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_INTERRUPT_NATURAL_COMPLETION_MARKER");
const interactionMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_INTERACTION_MARKER");
const interactionResolvedFirstMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_INTERACTION_RESOLVED_FIRST_MARKER");
const interactionResolveFile = optionalEnvironment("WITHMATE_FAKE_CODEX_INTERACTION_RESOLVE_FILE");
const recoveryStatePath = optionalEnvironment("WITHMATE_FAKE_CODEX_RECOVERY_STATE");
const threadStartHoldFile = optionalEnvironment("WITHMATE_FAKE_CODEX_THREAD_START_HOLD_FILE");
const turnStartHoldMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_TURN_START_HOLD_MARKER");
const resumeHoldMarker = optionalEnvironment("WITHMATE_FAKE_CODEX_RESUME_HOLD_MARKER");
const safeLog = optionalEnvironment("WITHMATE_FAKE_CODEX_SAFE_LOG") === "1";
const model = "gpt-5.4";
let threadSequence = 0;
let turnSequence = 0;
let closing = false;
const activeTurns = new Map();
const threads = new Map();
const pendingInteractions = new Map();

loadRecoveryState();

log("process.started", { pid: process.pid });

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 65;
    lines.close();
    return;
  }
  void handleMessage(message).catch(() => {
    process.exitCode = 66;
    lines.close();
  });
});

lines.on("close", () => {
  if (closing) return;
  closing = true;
  log("process.stdin_closed", {});
});

async function handleMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Invalid request.");
  }
  if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
    handleServerResponse(message);
    return;
  }
  if (message.method === "initialized" && !Object.hasOwn(message, "id")) {
    log("protocol.ready", {});
    return;
  }
  if (!Number.isSafeInteger(message.id) || typeof message.method !== "string") {
    throw new Error("Invalid request.");
  }
  log("protocol.request", { id: message.id, method: message.method });
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        codexHome: path.resolve(path.dirname(logPath), "fake-codex-home"),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
        userAgent: fs.readFileSync(userAgentPath, "utf8"),
      });
      return;
    case "model/list":
      respond(message.id, {
        data: [
          {
            id: model,
            model,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.4",
            description: "Deterministic process smoke model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: true,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      });
      return;
    case "thread/start":
      await handleThreadStart(message);
      return;
    case "thread/resume":
      await handleThreadResume(message);
      return;
    case "thread/read":
      handleThreadRead(message);
      return;
    case "turn/start":
      await handleTurnStart(message);
      return;
    case "turn/steer":
      await handleTurnSteer(message);
      return;
    case "turn/interrupt":
      await handleTurnInterrupt(message);
      return;
    default:
      write({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

async function handleThreadStart(message) {
  const params = record(message.params);
  if (threadStartHoldFile !== undefined && fs.existsSync(threadStartHoldFile)) {
    log("thread.start_blocked", {});
    await new Promise(() => {});
  }
  threadSequence += 1;
  const threadId = `fake-thread-${process.pid}-${threadSequence}`;
  const cwd = requiredString(params.cwd);
  const approvalPolicy = approvalPolicyValue(params.approvalPolicy);
  threads.set(threadId, { cwd, approvalPolicy });
  persistRecoveryState();
  log("thread.started", { threadId });
  respond(
    message.id,
    threadOperation(
      threadId,
      cwd,
      requiredString(params.model),
      requiredString(params.sandbox),
      params.ephemeral === true,
      approvalPolicy,
    ),
  );
}

async function handleThreadResume(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const cwd = requiredString(params.cwd);
  const requestedModel = typeof params.model === "string" ? params.model : model;
  const sandbox = typeof params.sandbox === "string" ? params.sandbox : "read-only";
  const approvalPolicy = approvalPolicyValue(params.approvalPolicy);
  threads.set(threadId, { cwd, approvalPolicy });
  log("thread.resumed", { threadId });
  respond(message.id, threadOperation(threadId, cwd, requestedModel, sandbox, false, approvalPolicy));
  const recovered = activeTurns.get(threadId);
  if (recovered !== undefined) {
    const recoveredTurn = turn(recovered.turnId, "inProgress", []);
    setImmediate(() => {
      notify("turn/started", { threadId, turn: recoveredTurn });
      if (resumeHoldMarker === undefined || !recovered.prompt.includes(resumeHoldMarker)) {
        completeTurn(threadId, recovered.turnId, recovered.prompt);
      }
    });
  }
}

function handleThreadRead(message) {
  const params = record(message.params);
  if (
    Object.keys(params).length !== 2 ||
    !Object.hasOwn(params, "threadId") ||
    !Object.hasOwn(params, "includeTurns") ||
    params.includeTurns !== true
  ) {
    throw new Error("Invalid thread/read request.");
  }
  const threadId = requiredString(params.threadId);
  const thread = threads.get(threadId);
  if (thread === undefined) {
    write({ id: message.id, error: { code: -32_001, message: "Thread not found" } });
    return;
  }
  log("thread.read", { threadId, includeTurns: true });
  respond(message.id, { thread: threadView(threadId, thread.cwd, false) });
}

async function handleTurnStart(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const prompt = extractPrompt(params.input);
  if (turnStartHoldMarker !== undefined && prompt.includes(turnStartHoldMarker)) {
    log("turn.start_blocked", { threadId, prompt });
    await new Promise(() => {});
  }
  turnSequence += 1;
  const turnId = `fake-turn-${process.pid}-${turnSequence}`;
  const inProgressTurn = turn(turnId, "inProgress", []);
  activeTurns.set(threadId, { turnId, prompt });
  persistRecoveryState();
  log("turn.started", { threadId, turnId, prompt });
  respond(message.id, { turn: inProgressTurn });

  if (prompt.includes(crashMarker)) {
    notify("turn/started", { threadId, turn: inProgressTurn });
    log("process.crashing", { threadId, turnId });
    setImmediate(() => process.exit(17));
    return;
  }

  if (holdMarker !== undefined && prompt.includes(holdMarker)) {
    notify("turn/started", { threadId, turn: inProgressTurn });
    log("turn.held", { threadId, turnId, prompt });
    return;
  }

  if (interactionMarker !== undefined && prompt.includes(interactionMarker)) {
    const thread = threads.get(threadId);
    if (thread === undefined || thread.approvalPolicy === "never") {
      throw new Error("An interactive Turn requires a non-never approval policy.");
    }
    const requestId = `fake-approval-${process.pid}-${turnSequence}`;
    const resolvedFirst =
      interactionResolvedFirstMarker !== undefined && prompt.includes(interactionResolvedFirstMarker);
    pendingInteractions.set(requestKey(requestId), { requestId, threadId, turnId, resolvedFirst });
    setImmediate(() => {
      notify("turn/started", { threadId, turn: inProgressTurn });
      write({
        id: requestId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: `fake-command-${turnSequence}`,
          startedAtMs: Date.now(),
          command: "node --version",
          cwd: thread.cwd,
        },
      });
      log("interaction.requested", {
        kind: "command_approval",
        order: resolvedFirst ? "resolved_first" : "response_first",
      });
      if (resolvedFirst) {
        void resolveInteractionFirst(threadId, requestId);
      }
    });
    return;
  }

  setImmediate(() => {
    notify("turn/started", { threadId, turn: inProgressTurn });
    completeTurn(threadId, turnId, prompt);
  });
}

function completeTurn(threadId, turnId, prompt) {
  const item = {
    type: "agentMessage",
    id: `fake-item-${process.pid}-${turnSequence}`,
    text: `reply:${prompt}`,
    phase: "final_answer",
    memoryCitation: null,
  };
  notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
  notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
  notify("turn/completed", { threadId, turn: turn(turnId, "completed", [item]) });
  activeTurns.delete(threadId);
  persistRecoveryState();
  log("turn.completed", { threadId, turnId, prompt });
}

async function handleTurnSteer(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const expectedTurnId = requiredString(params.expectedTurnId);
  requiredString(params.clientUserMessageId);
  const prompt = extractPrompt(params.input);
  const active = activeTurns.get(threadId);
  log("turn.steered", { threadId, turnId: expectedTurnId, prompt });
  if (active === undefined || active.turnId !== expectedTurnId) {
    write({ id: message.id, error: { code: -32_002, message: "Active Turn mismatch" } });
    return;
  }
  if (steerRejectMarker !== undefined && prompt.includes(steerRejectMarker)) {
    write({ id: message.id, error: { code: -32_000, message: "Steer rejected" } });
    return;
  }
  if (steerCrashMarker !== undefined && prompt.includes(steerCrashMarker)) {
    log("process.crashing", { threadId, turnId: expectedTurnId });
    setImmediate(() => process.exit(17));
    return;
  }
  if (steerHoldMarker !== undefined && prompt.includes(steerHoldMarker)) {
    if (steerReleaseFile === undefined) throw new Error("A steer release file is required.");
    log("turn.steer_waiting", { threadId, turnId: expectedTurnId, prompt });
    await waitForFile(steerReleaseFile, 15_000);
    log("turn.steer_released", { threadId, turnId: expectedTurnId, prompt });
  }
  if (steerTerminalMarker !== undefined && prompt.includes(steerTerminalMarker)) {
    const item = {
      type: "agentMessage",
      id: `fake-item-${process.pid}-${turnSequence}-terminal`,
      text: `reply:${prompt}`,
      phase: "final_answer",
      memoryCitation: null,
    };
    notify("turn/completed", { threadId, turn: turn(expectedTurnId, "completed", [item]) });
    activeTurns.delete(threadId);
    log("turn.completed", { threadId, turnId: expectedTurnId, prompt });
    respond(message.id, { turnId: expectedTurnId });
    return;
  }
  respond(message.id, { turnId: expectedTurnId });
}

async function handleTurnInterrupt(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const turnId = requiredString(params.turnId);
  const active = activeTurns.get(threadId);
  log("turn.interrupt_requested", { threadId, turnId });
  if (active === undefined || active.turnId !== turnId) {
    write({ id: message.id, error: { code: -32_002, message: "Active Turn mismatch" } });
    return;
  }

  respond(message.id, {});
  if (interruptReleaseFile !== undefined) {
    log("turn.interrupt_waiting", { threadId, turnId });
    await waitForFile(interruptReleaseFile, 15_000);
    log("turn.interrupt_released", { threadId, turnId });
  }

  if (interruptNaturalCompletionMarker !== undefined && active.prompt.includes(interruptNaturalCompletionMarker)) {
    const item = {
      type: "agentMessage",
      id: `fake-item-${process.pid}-${turnSequence}-cancel-race`,
      text: `reply:${active.prompt}`,
      phase: "final_answer",
      memoryCitation: null,
    };
    notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
    notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
    notify("turn/completed", { threadId, turn: turn(turnId, "completed", [item]) });
    activeTurns.delete(threadId);
    persistRecoveryState();
    releaseTurnInteractions(threadId, turnId);
    log("turn.completed", { threadId, turnId, prompt: active.prompt });
    return;
  }

  notify("turn/completed", { threadId, turn: turn(turnId, "interrupted", []) });
  activeTurns.delete(threadId);
  persistRecoveryState();
  releaseTurnInteractions(threadId, turnId);
  log("turn.interrupted", { threadId, turnId, prompt: active.prompt });
}

function handleServerResponse(message) {
  const pending = pendingInteractions.get(requestKey(message.id));
  if (pending === undefined) throw new Error("Unknown server response.");
  const result = record(message.result);
  const decision = result.decision;
  if (decision !== "accept" && decision !== "decline" && decision !== "cancel") {
    throw new Error("Invalid command approval response.");
  }
  pendingInteractions.delete(requestKey(message.id));
  log("interaction.response", { kind: "command_approval", decision });
  if (!pending.resolvedFirst) {
    notify("serverRequest/resolved", { threadId: pending.threadId, requestId: pending.requestId });
    log("interaction.resolved", { kind: "command_approval", order: "response_first" });
  }
}

async function resolveInteractionFirst(threadId, requestId) {
  if (interactionResolveFile === undefined) throw new Error("An interaction resolution release file is required.");
  await waitForFile(interactionResolveFile, 15_000);
  const key = requestKey(requestId);
  if (!pendingInteractions.has(key)) return;
  notify("serverRequest/resolved", { threadId, requestId });
  log("interaction.resolved", { kind: "command_approval", order: "resolved_first" });
}

function releaseTurnInteractions(threadId, turnId) {
  for (const [key, pending] of pendingInteractions) {
    if (pending.threadId === threadId && pending.turnId === turnId) pendingInteractions.delete(key);
  }
}

function threadOperation(threadId, cwd, requestedModel, sandboxMode, ephemeral, approvalPolicy) {
  return {
    thread: threadView(threadId, cwd, ephemeral),
    model: requestedModel,
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy,
    approvalsReviewer: "user",
    sandbox: sandbox(sandboxMode),
    reasoningEffort: "medium",
  };
}

function threadView(threadId, cwd, ephemeral) {
  const active = activeTurns.get(threadId);
  return {
    id: threadId,
    sessionId: `fake-session-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: active === undefined ? { type: "idle" } : { type: "active", activeFlags: [] },
    path: null,
    cwd,
    cliVersion: "0.145.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: active === undefined ? [] : [turn(active.turnId, "inProgress", [])],
  };
}

function loadRecoveryState() {
  if (recoveryStatePath === undefined || !fs.existsSync(recoveryStatePath)) return;
  const state = JSON.parse(fs.readFileSync(recoveryStatePath, "utf8"));
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid recovery state.");
  threadSequence = Number.isSafeInteger(state.threadSequence) ? state.threadSequence : 0;
  turnSequence = Number.isSafeInteger(state.turnSequence) ? state.turnSequence : 0;
  for (const entry of Array.isArray(state.threads) ? state.threads : []) {
    const value = record(entry);
    threads.set(requiredString(value.threadId), {
      cwd: requiredString(value.cwd),
      approvalPolicy: approvalPolicyValue(value.approvalPolicy),
    });
  }
  for (const entry of Array.isArray(state.activeTurns) ? state.activeTurns : []) {
    const value = record(entry);
    activeTurns.set(requiredString(value.threadId), {
      turnId: requiredString(value.turnId),
      prompt: requiredString(value.prompt),
    });
  }
}

function persistRecoveryState() {
  if (recoveryStatePath === undefined) return;
  const state = {
    threadSequence,
    turnSequence,
    threads: [...threads].map(([threadId, value]) => ({ threadId, ...value })),
    activeTurns: [...activeTurns].map(([threadId, value]) => ({ threadId, ...value })),
  };
  const temporaryPath = `${recoveryStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state), "utf8");
  fs.renameSync(temporaryPath, recoveryStatePath);
}

function sandbox(mode) {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      throw new Error("Unsupported sandbox.");
  }
}

function turn(id, status, items) {
  return {
    id,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function extractPrompt(value) {
  if (!Array.isArray(value)) throw new Error("Invalid Turn input.");
  return value
    .map((entry) => {
      const item = record(entry);
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("\n");
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function log(event, fields) {
  const entry = safeLog
    ? {
        event,
        ...(typeof fields.method === "string" ? { method: fields.method } : {}),
        ...(typeof fields.kind === "string" ? { kind: fields.kind } : {}),
        ...(typeof fields.decision === "string" ? { decision: fields.decision } : {}),
        ...(typeof fields.order === "string" ? { order: fields.order } : {}),
      }
    : { event, ...fields };
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function record(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value;
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected a string.");
  return value;
}

function approvalPolicyValue(value) {
  if (value === "never" || value === "untrusted" || value === "on-request") return value;
  throw new Error("Unsupported approval policy.");
}

function requestKey(value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error("Invalid request id.");
  }
  return `${typeof value}:${String(value)}`;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvironment(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting to release the fake Turn mutation.");
}
