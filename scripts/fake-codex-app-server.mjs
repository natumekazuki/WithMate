import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logPath = requiredEnvironment("WITHMATE_FAKE_CODEX_LOG");
const crashMarker = requiredEnvironment("WITHMATE_FAKE_CODEX_CRASH_MARKER");
const userAgentPath = requiredEnvironment("WITHMATE_FAKE_CODEX_USER_AGENT_FILE");
const model = "gpt-5.4";
let threadSequence = 0;
let turnSequence = 0;
let closing = false;

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
    case "turn/start":
      await handleTurnStart(message);
      return;
    default:
      write({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

async function handleThreadStart(message) {
  const params = record(message.params);
  threadSequence += 1;
  const threadId = `fake-thread-${process.pid}-${threadSequence}`;
  log("thread.started", { threadId });
  respond(
    message.id,
    threadOperation(
      threadId,
      requiredString(params.cwd),
      requiredString(params.model),
      requiredString(params.sandbox),
      params.ephemeral === true,
    ),
  );
}

async function handleThreadResume(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const cwd = requiredString(params.cwd);
  const requestedModel = typeof params.model === "string" ? params.model : model;
  const sandbox = typeof params.sandbox === "string" ? params.sandbox : "read-only";
  log("thread.resumed", { threadId });
  respond(message.id, threadOperation(threadId, cwd, requestedModel, sandbox, false));
}

async function handleTurnStart(message) {
  const params = record(message.params);
  const threadId = requiredString(params.threadId);
  const prompt = extractPrompt(params.input);
  turnSequence += 1;
  const turnId = `fake-turn-${process.pid}-${turnSequence}`;
  const inProgressTurn = turn(turnId, "inProgress", []);
  log("turn.started", { threadId, turnId, prompt });
  respond(message.id, { turn: inProgressTurn });

  if (prompt.includes(crashMarker)) {
    notify("turn/started", { threadId, turn: inProgressTurn });
    log("process.crashing", { threadId, turnId });
    setImmediate(() => process.exit(17));
    return;
  }

  const item = {
    type: "agentMessage",
    id: `fake-item-${process.pid}-${turnSequence}`,
    text: `reply:${prompt}`,
    phase: "final_answer",
    memoryCitation: null,
  };
  setImmediate(() => {
    notify("turn/started", { threadId, turn: inProgressTurn });
    notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
    notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
    notify("turn/completed", { threadId, turn: turn(turnId, "completed", [item]) });
    log("turn.completed", { threadId, turnId, prompt });
  });
}

function threadOperation(threadId, cwd, requestedModel, sandboxMode, ephemeral) {
  return {
    thread: {
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
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: "0.145.0",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: requestedModel,
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: sandbox(sandboxMode),
    reasoningEffort: "medium",
  };
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
  fs.appendFileSync(logPath, `${JSON.stringify({ event, ...fields })}\n`, "utf8");
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

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
