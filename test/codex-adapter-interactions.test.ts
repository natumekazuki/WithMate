import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type {
  CodexAdapterInteractionHandle,
  CodexAdapterInteractionResponse,
  CodexAdapterServerRequestPort,
} from "../src/main/providers/codex/codex-adapter-contract.js";
import { CODEX_ADAPTER_LIMITS } from "../src/main/providers/codex/codex-adapter-contract.js";
import { CodexAdapterInteractionManager } from "../src/main/providers/codex/codex-adapter-interactions.js";
import { codexProviderDefinition } from "../src/main/providers/codex/codex-provider-definition.js";
import type { CodexServerRequestIdentity } from "../src/main/providers/codex/protocol-session.js";
import { CodexTransportError } from "../src/main/providers/codex/transport-error.js";

class FakeServerRequest implements CodexAdapterServerRequestPort {
  readonly responses: unknown[] = [];
  readonly identity = Object.freeze(Object.create(null)) as CodexServerRequestIdentity;
  readonly params: unknown;

  constructor(
    readonly id: string | number,
    readonly method: string,
    params: unknown,
    readonly failure?: CodexTransportError,
  ) {
    this.params = approvalProtocolFixture(method, params);
  }

  async respond(result: unknown): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.responses.push(result);
  }
}

class DeferredServerRequest extends FakeServerRequest {
  readonly #write: Promise<void>;
  #resolveWrite: (() => void) | undefined;
  #rejectWrite: ((error: Error) => void) | undefined;

  constructor(id: string, itemId: string) {
    super(id, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId,
      command: "node --version",
      cwd: workspace,
    });
    this.#write = new Promise<void>((resolve, reject) => {
      this.#resolveWrite = resolve;
      this.#rejectWrite = reject;
    });
  }

  override respond(result: unknown): Promise<void> {
    this.responses.push(result);
    return this.#write;
  }

  resolveWrite(): void {
    this.#resolveWrite?.();
  }

  rejectWrite(error: Error): void {
    this.#rejectWrite?.(error);
  }
}

function approvalProtocolFixture(method: string, params: unknown): unknown {
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "item/fileChange/requestApproval" &&
    method !== "item/permissions/requestApproval"
  ) {
    return params;
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
  let snapshot: object;
  try {
    snapshot = Object.create(Object.getPrototypeOf(params) as object | null) as object;
    Object.defineProperties(snapshot, Object.getOwnPropertyDescriptors(params));
  } catch {
    return params;
  }
  if (!Object.hasOwn(snapshot, "startedAtMs")) {
    Object.defineProperty(snapshot, "startedAtMs", { value: 1, enumerable: true });
  }
  return snapshot;
}

const workspace = path.resolve("codex-interaction-workspace");
const threadId = "thread-live";
const turnId = "turn-live";

function admit(
  manager: CodexAdapterInteractionManager,
  request: FakeServerRequest,
  workspacePath: string | undefined = workspace,
) {
  const admission = manager.admit(
    request,
    workspacePath,
    (candidateThreadId, candidateTurnId) => candidateThreadId === threadId && candidateTurnId === turnId,
  );
  assert.ok(admission.event, `expected ${request.method} to produce an interaction`);
  return admission.event;
}

function decisionResponse(
  event: ReturnType<typeof admit>,
  decision: "accept" | "decline" | "cancel" = "accept",
): CodexAdapterInteractionResponse {
  return {
    interactionId: event.snapshot.interactionId,
    kind: event.snapshot.kind as "codex.command_approval",
    payload: { decision },
  };
}

test("six interaction kinds project bounded public snapshots and exact provider responses", async () => {
  const manager = new CodexAdapterInteractionManager();

  const command = new FakeServerRequest(1, "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "command-item",
    command: "node --version",
    cwd: workspace,
  });
  const commandEvent = admit(manager, command);
  assert.deepEqual(commandEvent.snapshot, {
    interactionId: commandEvent.snapshot.interactionId,
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    kind: "codex.command_approval",
    answerable: true,
    display: {
      summary: "Codex requests permission to run a command.",
      command: "node --version",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  });
  const canonicalCommand = codexProviderDefinition.canonicalizeInteractionResponse(
    commandEvent.snapshot,
    decisionResponse(commandEvent),
  );
  assert.equal(canonicalCommand.semanticAction, "accept");
  assert.deepEqual(await manager.respond(commandEvent.handle, canonicalCommand.response), {
    kind: "write_attempted",
    effect: "unknown",
    providerResolution: "pending",
  });
  assert.deepEqual(command.responses, [{ decision: "accept" }]);

  manager.observeFileChanges(threadId, turnId, "file-item", [
    { path: "src/new.ts", kind: "add" },
    { path: "src/existing.ts", kind: "update" },
  ]);
  const file = new FakeServerRequest("file-request", "item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "file-item",
    grantRoot: null,
  });
  const fileEvent = admit(manager, file);
  assert.equal(fileEvent.snapshot.kind, "codex.file_change_approval");
  assert.equal(fileEvent.snapshot.answerable, true);
  if (fileEvent.snapshot.kind !== "codex.file_change_approval" || !fileEvent.snapshot.answerable) assert.fail();
  assert.deepEqual(fileEvent.snapshot.display.changes, [
    { displayPath: "src/new.ts", changeKind: "add" },
    { displayPath: "src/existing.ts", changeKind: "update" },
  ]);
  await manager.respond(fileEvent.handle, {
    interactionId: fileEvent.snapshot.interactionId,
    kind: "codex.file_change_approval",
    payload: { decision: "decline" },
  });
  assert.deepEqual(file.responses, [{ decision: "decline" }]);

  const permission = new FakeServerRequest(3, "item/permissions/requestApproval", {
    threadId,
    turnId,
    itemId: "permission-item",
    cwd: workspace,
    permissions: {
      fileSystem: {
        entries: [{ access: "write", path: { type: "path", path: workspace } }],
      },
      network: null,
    },
  });
  const permissionEvent = admit(manager, permission);
  assert.equal(permissionEvent.snapshot.kind, "codex.permission_approval");
  assert.equal(permissionEvent.snapshot.answerable, true);
  await manager.respond(permissionEvent.handle, {
    interactionId: permissionEvent.snapshot.interactionId,
    kind: "codex.permission_approval",
    payload: { permissions: ["workspace_write"], scope: "turn" },
  });
  assert.deepEqual(permission.responses, [
    {
      permissions: {
        fileSystem: { entries: [{ access: "write", path: { type: "path", path: workspace } }] },
      },
      scope: "turn",
      strictAutoReview: null,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(permissionEvent.snapshot),
    /fileSystem|networkAccess|codex-interaction-workspace/u,
  );

  const userInput = new FakeServerRequest(4, "item/tool/requestUserInput", {
    threadId,
    turnId,
    itemId: "input-item",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Choose a value",
        isSecret: false,
        isOther: true,
        options: [
          { label: "one", description: "First choice" },
          { label: "two", description: "Second choice" },
        ],
      },
    ],
  });
  const userInputEvent = admit(manager, userInput);
  assert.equal(userInputEvent.snapshot.kind, "codex.user_input");
  assert.equal(userInputEvent.snapshot.answerable, true);
  await manager.respond(userInputEvent.handle, {
    interactionId: userInputEvent.snapshot.interactionId,
    kind: "codex.user_input",
    payload: { answers: { choice: ["custom"] } },
  });
  assert.deepEqual(userInput.responses, [{ answers: { choice: { answers: ["custom"] } } }]);

  const toolApproval = new FakeServerRequest("tool-request", "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    mode: "form",
    message: "Allow tool",
    requestedSchema: { type: "object", properties: {} },
    meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "collect",
      tool_params: {},
      persist: ["session", "always"],
    },
  });
  const toolEvent = admit(manager, toolApproval);
  assert.equal(toolEvent.snapshot.kind, "codex.mcp_tool_approval");
  assert.equal(toolEvent.snapshot.answerable, true);
  await manager.respond(toolEvent.handle, {
    interactionId: toolEvent.snapshot.interactionId,
    kind: "codex.mcp_tool_approval",
    payload: { decision: "accept" },
  });
  assert.deepEqual(toolApproval.responses, [{ action: "accept", content: {} }]);
  const resolution = manager.resolve(toolApproval.identity, threadId);
  assert.equal(resolution.kind, "resolved");

  const form = new FakeServerRequest(6, "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    message: "Choose a value",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: { choice: { type: "string", title: "Choice", maxLength: 16 } },
      required: ["choice"],
    },
  });
  const formEvent = admit(manager, form);
  assert.equal(formEvent.snapshot.kind, "codex.mcp_server_form");
  assert.equal(formEvent.snapshot.answerable, true);
  await manager.respond(formEvent.handle, {
    interactionId: formEvent.snapshot.interactionId,
    kind: "codex.mcp_server_form",
    payload: { action: "accept", values: { choice: "selected" } },
  });
  assert.deepEqual(form.responses, [{ action: "accept", content: { choice: "selected" } }]);

  const serialized = JSON.stringify([
    commandEvent.snapshot,
    fileEvent.snapshot,
    permissionEvent.snapshot,
    userInputEvent.snapshot,
    toolEvent.snapshot,
    formEvent.snapshot,
  ]);
  assert.doesNotMatch(serialized, /tool-request|file-request|requestId/u);
});

test("permission responses admit canonical subsets and map only selected captured wire subtrees", async () => {
  const permissionProfile = {
    fileSystem: {
      entries: [{ access: "write", path: { type: "path", path: workspace } }],
      read: [],
    },
    network: { enabled: true },
  } as const;
  const cases = [
    { permissions: [], wirePermissions: {} },
    { permissions: ["workspace_write"], wirePermissions: { fileSystem: permissionProfile.fileSystem } },
    { permissions: ["network"], wirePermissions: { network: permissionProfile.network } },
    {
      permissions: ["network", "workspace_write"],
      wirePermissions: permissionProfile,
    },
  ] as const;

  for (const entry of cases) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(
      `permission-subset-${entry.permissions.join("-") || "decline"}`,
      "item/permissions/requestApproval",
      {
        threadId,
        turnId,
        itemId: `permission-subset-${entry.permissions.join("-") || "decline"}`,
        cwd: workspace,
        permissions: permissionProfile,
      },
    );
    const event = admit(manager, request);
    assert.equal(event.snapshot.kind, "codex.permission_approval");
    assert.equal(event.snapshot.answerable, true);
    if (event.snapshot.kind !== "codex.permission_approval" || !event.snapshot.answerable) assert.fail();
    assert.deepEqual(event.snapshot.display.permissions, ["workspace_write", "network"]);

    const result = await manager.respond(event.handle, {
      interactionId: event.snapshot.interactionId,
      kind: "codex.permission_approval",
      payload: { permissions: entry.permissions, scope: "turn" },
    });
    assert.equal(result.kind, "write_attempted");
    assert.deepEqual(request.responses, [
      { permissions: entry.wirePermissions, scope: "turn", strictAutoReview: null },
    ]);
  }
});

test("permission responses reject invalid profiles before any Provider write", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest("permission-invalid-response", "item/permissions/requestApproval", {
    threadId,
    turnId,
    itemId: "permission-invalid-response",
    cwd: workspace,
    permissions: {
      fileSystem: { entries: [{ access: "write", path: { type: "path", path: workspace } }] },
    },
  });
  const event = admit(manager, request);
  const response = {
    interactionId: event.snapshot.interactionId,
    kind: "codex.permission_approval",
  } as const;
  for (const payload of [
    { permissions: ["network"], scope: "turn" },
    { permissions: ["workspace_write", "workspace_write"], scope: "turn" },
    { permissions: ["future"], scope: "turn" },
    { permissions: ["workspace_write"], scope: "session" },
    { permissions: ["workspace_write"], scope: "turn", unknown: true },
    { decision: "cancel" },
  ] as const) {
    assert.deepEqual(await manager.respond(event.handle, { ...response, payload }), {
      kind: "not_sent",
      effect: "none",
      code: "invalid_input",
    });
  }
  assert.equal(request.responses.length, 0);

  assert.equal(
    (
      await manager.respond(event.handle, {
        ...response,
        payload: { permissions: [], scope: "turn" },
      })
    ).kind,
    "write_attempted",
  );
  assert.deepEqual(request.responses, [{ permissions: {}, scope: "turn", strictAutoReview: null }]);
});

test("command approvals hide unsafe modifiers and only admit a safely represented plain decision", async () => {
  const command = `node ${workspace}\\script.js`;
  const unsafeModifiers: readonly Readonly<{ label: string; value: Readonly<Record<string, unknown>> }>[] = [
    { label: "empty command actions", value: { commandActions: [] } },
    {
      label: "multiple command actions",
      value: {
        commandActions: [
          { type: "unknown", command },
          { type: "unknown", command },
        ],
      },
    },
    {
      label: "mismatched command action",
      value: { commandActions: [{ type: "unknown", command: "node different.js" }] },
    },
    {
      label: "managed network context",
      value: { networkApprovalContext: { host: "example.invalid", protocol: "https" } },
    },
    {
      label: "network policy amendment",
      value: { proposedNetworkPolicyAmendments: [{ host: "example.invalid", action: "allow" }] },
    },
  ];

  for (const unsafe of unsafeModifiers) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(`unsafe-${unsafe.label}`, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: `command-${unsafe.label}`,
      command,
      cwd: workspace,
      ...unsafe.value,
    });
    const admission = manager.admit(request, workspace, () => true);
    assert.ok(admission.event, unsafe.label);
    assert.equal(admission.event.snapshot.answerable, false, unsafe.label);
    assert.equal(admission.failClosed, true, unsafe.label);
    assert.equal(admission.interrupt, false, unsafe.label);
    assert.deepEqual(
      admission.event.snapshot.display,
      {
        summary: "A command approval request is unavailable.",
        unavailableReason: "unsupported_shape",
      },
      unsafe.label,
    );
    await manager.failClosed(admission.event.handle);
    assert.deepEqual(request.responses, [{ decision: "decline" }], unsafe.label);
  }

  const invalidAction = new FakeServerRequest("invalid-action", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "invalid-action",
    command,
    cwd: workspace,
    commandActions: [{ type: "unknown" }],
  });
  assert.equal(new CodexAdapterInteractionManager().admit(invalidAction, workspace, () => true).protocolFailure, true);
  for (const proposedExecpolicyAmendment of [Array.from({ length: 17 }, () => "rule"), ["x".repeat(1_025)]]) {
    const malformed = new FakeServerRequest("invalid-policy", "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "invalid-policy",
      command,
      cwd: workspace,
      proposedExecpolicyAmendment,
    });
    const admission = new CodexAdapterInteractionManager().admit(malformed, workspace, () => true);
    assert.ok(admission.event);
    assert.equal(admission.event.snapshot.answerable, false);
    assert.deepEqual(admission.event.snapshot.display, {
      summary: "A command approval request is unavailable.",
      unavailableReason: "resource_limit",
    });
  }

  const supportedManager = new CodexAdapterInteractionManager();
  const supported = new FakeServerRequest("supported-command", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "supported-command",
    command,
    commandActions: [{ type: "unknown", command }],
    cwd: workspace,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: Array.from({ length: 16 }, () => "x".repeat(256)),
    proposedNetworkPolicyAmendments: null,
  });
  const supportedEvent = admit(supportedManager, supported);
  assert.equal(supportedEvent.snapshot.answerable, true);
  assert.equal(supportedEvent.snapshot.kind, "codex.command_approval");
  if (supportedEvent.snapshot.answerable && supportedEvent.snapshot.kind === "codex.command_approval") {
    assert.equal(supportedEvent.snapshot.display.command, "node <workspace>\\script.js");
    assert.doesNotMatch(JSON.stringify(supportedEvent.snapshot), /zgmfx|GitWorktree|source/u);
  }
  assert.equal(
    (await supportedManager.respond(supportedEvent.handle, decisionResponse(supportedEvent))).kind,
    "write_attempted",
  );
  assert.deepEqual(supported.responses, [{ decision: "accept" }]);
});

test("command approval rejects external or ambiguous absolute paths without exposing them", async () => {
  for (const command of [
    "node C:\\Users\\alice\\private\\script.js",
    `node ${workspace}-other\\script.js`,
    `node "${workspace} space\\secret.js"`,
    `cat "${workspace}"space/secret`,
    String.raw`cat "foo"${workspace}\secret`,
    String.raw`cat "foo\"${workspace}\secret`,
    String.raw`cat "${workspace}\secret\" tail`,
    `cat "${workspace}\\secret\`" tail"`,
    `cat "${workspace}\\secret^" tail"`,
    `node ${workspace}\\src\\ok.js C:\\Users\\alice\\private\\other.js`,
    "node \\\\server\\share\\script.js",
    "node /home/alice/private/script.js",
    "node file:///tmp/private.js",
    "node ~/private.js",
    `node ${workspace}\\src\\..\\private.js`,
    "cd ..",
    "type \\Windows\\System32\\drivers\\etc\\hosts",
    "type C:secret.txt",
    "type C:..\\secret.txt",
    "cat //etc/passwd",
    "cat ~alice/secret",
  ]) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(`private-${command}`, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "private-command",
      command,
      cwd: workspace,
    });
    const admission = manager.admit(request, workspace, () => true);
    assert.ok(admission.event, command);
    assert.equal(admission.event.snapshot.answerable, false, command);
    assert.deepEqual(admission.event.snapshot.display, {
      summary: "A command approval request is unavailable.",
      unavailableReason: "unsafe_projection",
    });
    assert.doesNotMatch(JSON.stringify(admission.event.snapshot), /alice|private|share|tmp/u);
    await manager.failClosed(admission.event.handle);
    assert.deepEqual(request.responses, [{ decision: "decline" }]);
  }

  for (const [unsafeWorkspace, command] of [
    ["\\\\server\\share\\workspace", "node \\\\server\\share\\workspace\\a.js"],
    ["\\\\?\\C:\\workspace", "node \\\\?\\C:\\workspace\\a.js"],
  ] as const) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(`private-workspace-${command}`, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "private-workspace-command",
      command,
      commandActions: [{ type: "unknown", command }],
      cwd: unsafeWorkspace,
    });
    const admission = manager.admit(request, unsafeWorkspace, () => true);
    assert.ok(admission.event, unsafeWorkspace);
    assert.equal(admission.event.snapshot.answerable, false, unsafeWorkspace);
    assert.deepEqual(admission.event.snapshot.display, {
      summary: "A command approval request is unavailable.",
      unavailableReason: "unsafe_projection",
    });
    assert.doesNotMatch(JSON.stringify(admission.event.snapshot), /share|\\\\workspace|C:|secret/u);
    await manager.failClosed(admission.event.handle);
    assert.deepEqual(request.responses, [{ decision: "decline" }]);
  }
});

test("command approval rejects decisions outside the current Provider snapshot before writing", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest("decline-only-command", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "decline-only-command",
    command: "node --version",
    cwd: workspace,
    availableDecisions: ["decline"],
  });
  const event = admit(manager, request);
  assert.equal(event.snapshot.kind, "codex.command_approval");
  assert.equal(event.snapshot.answerable, true);
  if (event.snapshot.kind !== "codex.command_approval" || !event.snapshot.answerable) assert.fail();
  assert.deepEqual(event.snapshot.display.availableDecisions, ["decline"]);

  assert.deepEqual(await manager.respond(event.handle, decisionResponse(event, "accept")), {
    kind: "not_sent",
    effect: "none",
    code: "invalid_input",
  });
  assert.equal(request.responses.length, 0);

  assert.equal((await manager.respond(event.handle, decisionResponse(event, "decline"))).kind, "write_attempted");
  assert.deepEqual(request.responses, [{ decision: "decline" }]);
});

test("file approval with a persistent grant root is unavailable while a null grant remains answerable", async () => {
  const unsafeManager = new CodexAdapterInteractionManager();
  unsafeManager.observeFileChanges(threadId, turnId, "file-grant", [{ path: "src/grant.ts", kind: "update" }]);
  const unsafe = new FakeServerRequest("file-grant", "item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "file-grant",
    grantRoot: workspace,
  });
  const admission = unsafeManager.admit(unsafe, workspace, () => true);
  assert.ok(admission.event);
  assert.equal(admission.event.snapshot.answerable, false);
  assert.equal(admission.failClosed, true);
  assert.equal(admission.interrupt, false);
  assert.deepEqual(admission.event.snapshot.display, {
    summary: "A file change approval request is unavailable.",
    unavailableReason: "unsupported_shape",
  });
  await unsafeManager.failClosed(admission.event.handle);
  assert.deepEqual(unsafe.responses, [{ decision: "decline" }]);

  const supportedManager = new CodexAdapterInteractionManager();
  supportedManager.observeFileChanges(threadId, turnId, "file-normal", [{ path: "src/normal.ts", kind: "update" }]);
  const supported = new FakeServerRequest("file-normal", "item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "file-normal",
    grantRoot: null,
  });
  assert.equal(admit(supportedManager, supported).snapshot.answerable, true);
});

test("official Codex 0.145 request variants stay distinct from malformed Provider payloads", async () => {
  const commandManager = new CodexAdapterInteractionManager();
  const command = new FakeServerRequest("command-data-decision", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "command-data-decision",
    startedAtMs: 1,
    command: "node --version",
    cwd: workspace,
    availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } }],
  });
  const commandAdmission = commandManager.admit(command, workspace, () => true);
  assert.equal(commandAdmission.protocolFailure, false);
  assert.equal(commandAdmission.event?.snapshot.answerable, false);
  if (commandAdmission.event !== undefined) await commandManager.failClosed(commandAdmission.event.handle);

  const userManager = new CodexAdapterInteractionManager();
  const user = new FakeServerRequest("user-auto-resolution", "item/tool/requestUserInput", {
    threadId,
    turnId,
    itemId: "user-auto-resolution",
    autoResolutionMs: null,
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Choose",
        options: [
          { label: "one", description: "First" },
          { label: "two", description: "Second" },
        ],
      },
    ],
  });
  const userAdmission = userManager.admit(user, workspace, () => true);
  assert.equal(userAdmission.protocolFailure, false);
  assert.equal(userAdmission.event?.snapshot.answerable, true);
  userManager.close();

  const malformedUser = new FakeServerRequest("user-missing-description", "item/tool/requestUserInput", {
    threadId,
    turnId,
    itemId: "user-missing-description",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Choose",
        options: [{ label: "one" }, { label: "two", description: "Second" }],
      },
    ],
  });
  assert.equal(new CodexAdapterInteractionManager().admit(malformedUser, workspace, () => true).protocolFailure, true);

  const ownerlessMcp = new FakeServerRequest("mcp-null-owner", "mcpServer/elicitation/request", {
    threadId,
    turnId: null,
    serverName: "fixture",
    mode: "form",
    _meta: null,
    message: "Enter a value",
    requestedSchema: { type: "object", properties: {} },
  });
  const ownerlessAdmission = new CodexAdapterInteractionManager().admit(ownerlessMcp, workspace, () => true);
  assert.equal(ownerlessAdmission.protocolFailure, false);
  assert.equal(ownerlessAdmission.event, undefined);

  const schemaManager = new CodexAdapterInteractionManager();
  const validUnsupportedSchema = new FakeServerRequest("mcp-known-schema", "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    mode: "form",
    _meta: null,
    message: "Enter a value",
    requestedSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "Value", minLength: 1, default: "default" },
      },
    },
  });
  const schemaAdmission = schemaManager.admit(validUnsupportedSchema, workspace, () => true);
  assert.equal(schemaAdmission.protocolFailure, false);
  assert.equal(schemaAdmission.event?.snapshot.answerable, false);
  if (schemaAdmission.event !== undefined) await schemaManager.failClosed(schemaAdmission.event.handle);

  const permissionManager = new CodexAdapterInteractionManager();
  const permission = new FakeServerRequest("permission-option-nulls", "item/permissions/requestApproval", {
    threadId,
    turnId,
    itemId: "permission-option-nulls",
    startedAtMs: 1,
    cwd: workspace,
    permissions: {
      fileSystem: {
        entries: [{ access: "write", path: { type: "path", path: workspace } }],
        read: null,
        write: null,
      },
      network: null,
    },
  });
  const permissionAdmission = permissionManager.admit(permission, workspace, () => true);
  assert.equal(permissionAdmission.protocolFailure, false);
  assert.equal(permissionAdmission.event?.snapshot.answerable, true);
  permissionManager.close();
});

test("dynamic answers are exact, current, and one-shot before any provider write", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest(10, "item/tool/requestUserInput", {
    threadId,
    turnId,
    itemId: "input-item",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Choose",
        isOther: false,
        options: [
          { label: "one", description: "First" },
          { label: "two", description: "Second" },
        ],
      },
    ],
  });
  const event = admit(manager, request);
  const base = { interactionId: event.snapshot.interactionId, kind: "codex.user_input" as const };
  for (const payload of [
    { answers: { choice: ["other"] } },
    { answers: {} },
    { answers: { choice: ["one"], extra: ["two"] } },
    { answers: { choice: ["one", "two"] } },
  ]) {
    assert.deepEqual(await manager.respond(event.handle, { ...base, payload } as never), {
      kind: "not_sent",
      effect: "none",
      code: "invalid_input",
    });
  }
  assert.equal(request.responses.length, 0);
  const accepted = { ...base, payload: { answers: { choice: ["one"] } } } as const;
  const firstWrite = manager.respond(event.handle, accepted);
  assert.deepEqual(await manager.respond(event.handle, accepted), {
    kind: "not_sent",
    effect: "none",
    code: "already_used",
  });
  assert.equal((await firstWrite).kind, "write_attempted");
  assert.equal(request.responses.length, 1);
});

test("response reservation freezes admission synchronously and survives resolution or terminal until one write", async () => {
  for (const beforeWrite of ["resolved", "terminal"] as const) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(`reserved-${beforeWrite}`, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: `reserved-${beforeWrite}`,
      command: "node --version",
      cwd: workspace,
    });
    const event = admit(manager, request);
    const reserved = manager.reserve(event.handle, decisionResponse(event));
    assert.equal(reserved.kind, "reserved");
    if (reserved.kind !== "reserved") continue;
    assert.deepEqual(await manager.respond(event.handle, decisionResponse(event)), {
      kind: "not_sent",
      effect: "none",
      code: "already_used",
    });
    if (beforeWrite === "resolved") {
      assert.equal(manager.resolve(request.identity, threadId).kind, "resolved");
    } else if (beforeWrite === "terminal") {
      manager.completeTurn(threadId, turnId);
    }
    const result = await manager.writeReserved(reserved.reservation);
    assert.equal(result.kind, "write_attempted");
    if (result.kind === "write_attempted" && beforeWrite === "resolved") {
      assert.equal(result.providerResolution, "resolved");
    }
    assert.deepEqual(request.responses, [{ decision: "accept" }]);
    assert.deepEqual(await manager.writeReserved(reserved.reservation), {
      kind: "not_sent",
      effect: "none",
      code: "already_used",
    });
  }
});

test("connection close retires reserved responses for all six interaction kinds without a Provider write", async () => {
  const cases: readonly Readonly<{
    label: string;
    method: string;
    params: () => Readonly<Record<string, unknown>>;
    response: (interactionId: string) => unknown;
    prepare?: (manager: CodexAdapterInteractionManager) => void;
  }>[] = [
    {
      label: "command approval",
      method: "item/commandExecution/requestApproval",
      params: () => ({ threadId, turnId, itemId: "close-command", command: "node --version", cwd: workspace }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.command_approval",
        payload: { decision: "accept" },
      }),
    },
    {
      label: "file change approval",
      method: "item/fileChange/requestApproval",
      params: () => ({ threadId, turnId, itemId: "close-file", grantRoot: null }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.file_change_approval",
        payload: { decision: "accept" },
      }),
      prepare: (manager) => {
        manager.observeFileChanges(threadId, turnId, "close-file", [{ path: "src/close.ts", kind: "update" }]);
      },
    },
    {
      label: "permission approval",
      method: "item/permissions/requestApproval",
      params: () => ({
        threadId,
        turnId,
        itemId: "close-permission",
        cwd: workspace,
        permissions: {
          fileSystem: { entries: [{ access: "write", path: { type: "path", path: workspace } }] },
          network: null,
        },
      }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.permission_approval",
        payload: { permissions: ["workspace_write"], scope: "turn" },
      }),
    },
    {
      label: "user input",
      method: "item/tool/requestUserInput",
      params: () => ({
        threadId,
        turnId,
        itemId: "close-user-input",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose",
            isOther: false,
            options: [
              { label: "one", description: "First" },
              { label: "two", description: "Second" },
            ],
          },
        ],
      }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.user_input",
        payload: { answers: { choice: ["one"] } },
      }),
    },
    {
      label: "MCP tool approval",
      method: "mcpServer/elicitation/request",
      params: () => ({
        threadId,
        turnId,
        serverName: "fixture",
        mode: "form",
        message: "Allow tool",
        requestedSchema: { type: "object", properties: {} },
        meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_name: "collect",
          tool_params: {},
          persist: "session",
        },
      }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.mcp_tool_approval",
        payload: { decision: "accept" },
      }),
    },
    {
      label: "MCP server form",
      method: "mcpServer/elicitation/request",
      params: () => ({
        threadId,
        turnId,
        serverName: "fixture",
        message: "Choose",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", title: "Choice", maxLength: 16 } },
          required: ["choice"],
        },
      }),
      response: (interactionId) => ({
        interactionId,
        kind: "codex.mcp_server_form",
        payload: { action: "accept", values: { choice: "selected" } },
      }),
      prepare: (manager) => {
        const tool = new FakeServerRequest("close-form-tool", "mcpServer/elicitation/request", {
          threadId,
          turnId,
          serverName: "fixture",
          mode: "form",
          message: "Allow tool",
          requestedSchema: { type: "object", properties: {} },
          meta: {
            codex_approval_kind: "mcp_tool_call",
            tool_name: "collect",
            tool_params: {},
            persist: "session",
          },
        });
        admit(manager, tool);
        assert.equal(manager.resolve(tool.identity, threadId).kind, "resolved");
      },
    },
  ];

  for (const entry of cases) {
    const manager = new CodexAdapterInteractionManager();
    entry.prepare?.(manager);
    const request = new FakeServerRequest(`close-${entry.label}`, entry.method, entry.params());
    const event = admit(manager, request);
    const response = entry.response(event.snapshot.interactionId);
    const reserved = manager.reserve(event.handle, response);
    assert.equal(reserved.kind, "reserved", entry.label);
    if (reserved.kind !== "reserved") continue;

    manager.close();

    assert.deepEqual(
      await manager.writeReserved(reserved.reservation),
      { kind: "not_sent", effect: "none", code: "closed" },
      entry.label,
    );
    assert.deepEqual(await manager.respond(event.handle, response), {
      kind: "not_sent",
      effect: "none",
      code: "closed",
    });
    assert.equal(manager.resolve(request.identity, threadId).kind, "invalid", entry.label);
    assert.deepEqual(request.responses, [], entry.label);
  }
});

test("connection close preserves an already-started response outcome without permitting a second Provider write", async () => {
  for (const outcome of ["written", "unknown"] as const) {
    const manager = new CodexAdapterInteractionManager();
    const request = new DeferredServerRequest(`write-started-${outcome}`, `write-started-${outcome}`);
    const event = admit(manager, request);
    const reserved = manager.reserve(event.handle, decisionResponse(event));
    assert.equal(reserved.kind, "reserved");
    if (reserved.kind !== "reserved") continue;

    const firstWrite = manager.writeReserved(reserved.reservation);
    assert.deepEqual(request.responses, [{ decision: "accept" }]);
    manager.close();
    assert.deepEqual(await manager.writeReserved(reserved.reservation), {
      kind: "not_sent",
      effect: "none",
      code: "closed",
    });
    assert.deepEqual(request.responses, [{ decision: "accept" }]);

    if (outcome === "written") {
      request.resolveWrite();
      assert.deepEqual(await firstWrite, {
        kind: "write_attempted",
        effect: "unknown",
        providerResolution: "pending",
      });
    } else {
      request.rejectWrite(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
      assert.deepEqual(await firstWrite, {
        kind: "ambiguous",
        effect: "unknown",
        code: "connection_lost",
        providerResolution: "pending",
      });
    }
    assert.deepEqual(request.responses, [{ decision: "accept" }]);
  }
});

test("response reservations reject forged or released wrapper identities without writing", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest("reservation-identity", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "reservation-identity",
    command: "node --version",
    cwd: workspace,
  });
  const event = admit(manager, request);
  const reserved = manager.reserve(event.handle, decisionResponse(event));
  assert.equal(reserved.kind, "reserved");
  if (reserved.kind !== "reserved") return;
  assert.deepEqual(await manager.writeReserved({ token: reserved.reservation.token }), {
    kind: "not_sent",
    effect: "none",
    code: "unknown_handle",
  });
  manager.releaseReservation(reserved.reservation);
  assert.deepEqual(await manager.writeReserved(reserved.reservation), {
    kind: "not_sent",
    effect: "none",
    code: "already_used",
  });
  assert.deepEqual(request.responses, []);
});

test("secret input is unavailable and hostile response objects never reach the provider", async () => {
  const manager = new CodexAdapterInteractionManager();
  const secret = new FakeServerRequest(30, "item/tool/requestUserInput", {
    threadId,
    turnId,
    itemId: "secret-input",
    questions: [
      {
        id: "password",
        header: "Password",
        question: "Enter a password",
        isSecret: true,
        isOther: true,
        options: [
          { label: "one", description: "First" },
          { label: "two", description: "Second" },
        ],
      },
    ],
  });
  const secretEvent = admit(manager, secret);
  assert.equal(secretEvent.snapshot.answerable, false);
  assert.deepEqual(secretEvent.snapshot.display, {
    summary: "A user input request is unavailable.",
    unavailableReason: "secret_input",
  });
  assert.equal(manager.admit(secret, workspace, () => true).protocolFailure, true);

  const command = new FakeServerRequest(31, "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "hostile-response",
    command: "node --version",
    cwd: workspace,
  });
  const event = admit(manager, command);
  let getterReads = 0;
  const accessor = { kind: "codex.command_approval", payload: { decision: "accept" } } as Record<string, unknown>;
  Object.defineProperty(accessor, "interactionId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return event.snapshot.interactionId;
    },
  });
  for (const response of [
    accessor,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile");
        },
      },
    ),
    {
      interactionId: event.snapshot.interactionId,
      kind: "codex.file_change_approval",
      payload: { decision: "accept" },
    },
  ]) {
    assert.deepEqual(await manager.respond(event.handle, response), {
      kind: "not_sent",
      effect: "none",
      code: "invalid_input",
    });
  }
  assert.equal(getterReads, 0);
  assert.equal(command.responses.length, 0);
});

test("MCP form validates current fields and encodes decline without content", async () => {
  const manager = new CodexAdapterInteractionManager();
  const tool = new FakeServerRequest("tool-stage", "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    mode: "form",
    message: "Allow tool",
    requestedSchema: { type: "object", properties: {} },
    meta: { codex_approval_kind: "mcp_tool_call", tool_name: "collect", tool_params: {} },
  });
  admit(manager, tool);
  assert.equal(manager.resolve(tool.identity, threadId).kind, "resolved");

  const form = new FakeServerRequest("form-stage", "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    message: "Enter values",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        requiredValue: { type: "string", maxLength: 4 },
        optionalValue: { type: "string", maxLength: 8 },
      },
      required: ["requiredValue"],
    },
  });
  const event = admit(manager, form);
  const base = { interactionId: event.snapshot.interactionId, kind: "codex.mcp_server_form" as const };
  for (const payload of [
    { action: "accept", values: {} },
    { action: "accept", values: { requiredValue: "12345" } },
    { action: "accept", values: { requiredValue: "ok", unknown: "no" } },
    { action: "decline", values: {} },
  ]) {
    assert.deepEqual(await manager.respond(event.handle, { ...base, payload }), {
      kind: "not_sent",
      effect: "none",
      code: "invalid_input",
    });
  }
  assert.equal(form.responses.length, 0);
  assert.equal(
    (await manager.respond(event.handle, { ...base, payload: { action: "decline" } })).kind,
    "write_attempted",
  );
  assert.deepEqual(form.responses, [{ action: "decline", content: null }]);
});

test("MCP tool scalar persistence hints keep only plain request-scoped decisions answerable", async () => {
  for (const [persist, decision, expected] of [
    ["session", "accept", { action: "accept", content: {} }],
    ["always", "decline", { action: "decline", content: null }],
    ["session", "cancel", { action: "cancel", content: null }],
  ] as const) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(`${persist}-${decision}`, "mcpServer/elicitation/request", {
      threadId,
      turnId,
      serverName: "fixture",
      mode: "form",
      message: "Allow tool",
      requestedSchema: { type: "object", properties: {} },
      meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: "collect",
        tool_params: {},
        persist,
      },
    });
    const event = admit(manager, request);
    assert.equal(event.snapshot.kind, "codex.mcp_tool_approval");
    assert.equal(event.snapshot.answerable, true);
    assert.equal(
      (
        await manager.respond(event.handle, {
          interactionId: event.snapshot.interactionId,
          kind: "codex.mcp_tool_approval",
          payload: { decision },
        })
      ).kind,
      "write_attempted",
    );
    assert.deepEqual(request.responses, [expected]);
  }
});

test("invalid MCP tool persistence hints expose no answerable user-response path or Provider write", async () => {
  for (const persist of [
    [],
    ["future"],
    ["session", "session"],
    ["always", "session"],
    ["session", "always", "future"],
  ]) {
    const manager = new CodexAdapterInteractionManager();
    const request = new FakeServerRequest(
      `invalid-persist-${JSON.stringify(persist)}`,
      "mcpServer/elicitation/request",
      {
        threadId,
        turnId,
        serverName: "fixture",
        mode: "form",
        message: "Allow tool",
        requestedSchema: { type: "object", properties: {} },
        meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_name: "collect",
          tool_params: {},
          persist,
        },
      },
    );
    const admission = manager.admit(request, workspace, () => true);
    assert.equal(admission.event, undefined, JSON.stringify(persist));
    assert.equal(admission.protocolFailure, true, JSON.stringify(persist));
    assert.deepEqual(request.responses, [], JSON.stringify(persist));
  }
});

test("response write certainty distinguishes definite no-write from ambiguous delivery", async () => {
  const noWriteManager = new CodexAdapterInteractionManager();
  const noWrite = new FakeServerRequest(
    40,
    "item/commandExecution/requestApproval",
    { threadId, turnId, itemId: "no-write", command: "node --version", cwd: workspace },
    new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }),
  );
  const noWriteEvent = admit(noWriteManager, noWrite);
  assert.deepEqual(await noWriteManager.respond(noWriteEvent.handle, decisionResponse(noWriteEvent)), {
    kind: "not_sent",
    effect: "none",
    code: "write_rejected",
  });
  assert.deepEqual(await noWriteManager.respond(noWriteEvent.handle, decisionResponse(noWriteEvent)), {
    kind: "not_sent",
    effect: "none",
    code: "already_used",
  });

  const ambiguousManager = new CodexAdapterInteractionManager();
  const ambiguous = new FakeServerRequest(
    41,
    "item/commandExecution/requestApproval",
    { threadId, turnId, itemId: "ambiguous", command: "node --version", cwd: workspace },
    new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }),
  );
  const ambiguousEvent = admit(ambiguousManager, ambiguous);
  assert.deepEqual(await ambiguousManager.respond(ambiguousEvent.handle, decisionResponse(ambiguousEvent)), {
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
    providerResolution: "pending",
  });
});

test("MCP form is unavailable and declined before correlated tool approval resolution", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest(11, "mcpServer/elicitation/request", {
    threadId,
    turnId,
    serverName: "fixture",
    message: "Early form",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: { choice: { type: "string", title: "Choice", maxLength: 8 } },
      required: ["choice"],
    },
  });
  const admission = manager.admit(request, workspace, () => true);
  assert.ok(admission.event);
  assert.equal(admission.interrupt, true);
  assert.deepEqual(admission.event.snapshot.display, {
    summary: "An MCP server form is unavailable.",
    unavailableReason: "unsupported_shape",
  });
  await manager.failClosed(admission.event.handle);
  assert.deepEqual(request.responses, [{ action: "decline", content: null }]);
  assert.deepEqual(await manager.respond(admission.event.handle, {} as never), {
    kind: "not_sent",
    effect: "none",
    code: "already_used",
  });
});

test("resolved and terminal retain bounded stale-handle tombstones while close releases all interaction state", async () => {
  const manager = new CodexAdapterInteractionManager();
  const request = new FakeServerRequest(Number.MAX_SAFE_INTEGER, "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "command-item",
    command: "node --version",
    cwd: workspace,
  });
  const event = admit(manager, request);
  const resolved = manager.resolve(request.identity, threadId);
  assert.equal(resolved.kind, "resolved");
  assert.equal(manager.resolve(request.identity, threadId).kind, "invalid");
  assert.deepEqual(await manager.respond(event.handle, decisionResponse(event)), {
    kind: "not_sent",
    effect: "none",
    code: "resolved",
  });

  const terminalRequest = new FakeServerRequest("terminal", "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "terminal-item",
    command: "node --version",
    cwd: workspace,
  });
  const terminalEvent = admit(manager, terminalRequest);
  manager.completeTurn(threadId, turnId);
  assert.equal((await manager.respond(terminalEvent.handle, decisionResponse(terminalEvent))).kind, "not_sent");

  const closeManager = new CodexAdapterInteractionManager();
  const closeEvent = admit(
    closeManager,
    new FakeServerRequest("close", "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "close-item",
      command: "node --version",
      cwd: workspace,
    }),
  );
  closeManager.close();
  assert.deepEqual(await closeManager.respond(closeEvent.handle, decisionResponse(closeEvent)), {
    kind: "not_sent",
    effect: "none",
    code: "closed",
  });
});

test("unknown, ownerless, oversized, sparse, accessor, and proxy requests fail before write", async () => {
  const manager = new CodexAdapterInteractionManager();
  const cases: FakeServerRequest[] = [
    new FakeServerRequest(20, "future/request", { threadId, turnId }),
    new FakeServerRequest(21, "item/commandExecution/requestApproval", {
      threadId: null,
      turnId,
      itemId: "item",
      command: "node --version",
      cwd: workspace,
    }),
    new FakeServerRequest(22, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "item",
      command: "x".repeat(2_049),
      cwd: workspace,
    }),
  ];
  const sparseQuestions = new Array(2);
  sparseQuestions[0] = { id: "one" };
  cases.push(
    new FakeServerRequest(23, "item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: "item",
      questions: sparseQuestions,
    }),
  );
  const accessor = { threadId, turnId, itemId: "item", cwd: workspace } as Record<string, unknown>;
  Object.defineProperty(accessor, "command", { enumerable: true, get: () => "node --version" });
  cases.push(new FakeServerRequest(24, "item/commandExecution/requestApproval", accessor));
  cases.push(
    new FakeServerRequest(
      25,
      "item/commandExecution/requestApproval",
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile");
          },
        },
      ),
    ),
  );

  for (const request of cases) {
    const admission = manager.admit(request, workspace, () => true);
    if (admission.event !== undefined) {
      assert.equal(admission.event.snapshot.answerable, false);
    }
    assert.equal(request.responses.length, 0);
  }
});

test("pending and aggregate limits fail closed without evicting existing handles", async () => {
  const manager = new CodexAdapterInteractionManager();
  const handles: CodexAdapterInteractionHandle[] = [];
  for (let index = 0; index < 32; index += 1) {
    const request = new FakeServerRequest(index, "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: `item-${index}`,
      command: "node --version",
      cwd: workspace,
    });
    handles.push(admit(manager, request).handle);
  }
  const overflow = new FakeServerRequest(100, "item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "overflow",
    command: "node --version",
    cwd: workspace,
  });
  const admission = manager.admit(overflow, workspace, () => true);
  assert.equal(admission.event, undefined);
  assert.equal(admission.resourceLimit, true);
  await manager.failClosedRequest(overflow);
  assert.deepEqual(overflow.responses, [{ decision: "decline" }]);
  const firstHandle = handles[0] as CodexAdapterInteractionHandle;
  const firstResponse = await manager.respond(firstHandle, {
    interactionId: "wrong",
    kind: "codex.command_approval",
    payload: { decision: "accept" },
  });
  assert.deepEqual(firstResponse, { kind: "not_sent", effect: "none", code: "invalid_input" });
});

test("file observations apply exact prospective count and UTF-8 replacement budgets, then consume and clean up", () => {
  const countManager = new CodexAdapterInteractionManager();
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxInteractionFileObservations; index += 1) {
    assert.equal(
      countManager.observeFileChanges(threadId, turnId, `count-${index}`, [{ path: `src/${index}.ts`, kind: "update" }])
        .kind,
      "observed",
    );
  }
  assert.equal(
    countManager.observeFileChanges(threadId, turnId, "count-overflow", [{ path: "src/overflow.ts", kind: "update" }])
      .kind,
    "resource_limit",
  );
  countManager.completeTurn(threadId, turnId);
  assert.equal(
    countManager.observeFileChanges(threadId, turnId, "count-after-cleanup", [{ path: "src/after.ts", kind: "update" }])
      .kind,
    "observed",
  );

  const changeCountManager = new CodexAdapterInteractionManager();
  const maximumChanges = Array.from({ length: CODEX_ADAPTER_LIMITS.maxInteractionFileChanges }, (_, index) => ({
    path: `src/change-${index}.ts`,
    kind: "update" as const,
  }));
  const observationCount =
    CODEX_ADAPTER_LIMITS.maxInteractionObservedFileChanges / CODEX_ADAPTER_LIMITS.maxInteractionFileChanges;
  for (let index = 0; index < observationCount; index += 1) {
    assert.equal(
      changeCountManager.observeFileChanges(threadId, turnId, `changes-${index}`, maximumChanges).kind,
      "observed",
    );
  }
  assert.equal(
    changeCountManager.observeFileChanges(threadId, turnId, "changes-overflow", [{ path: "src/extra.ts", kind: "add" }])
      .kind,
    "resource_limit",
  );

  const byteManager = new CodexAdapterInteractionManager();
  const exactUtf8Path = "é".repeat(CODEX_ADAPTER_LIMITS.maxInteractionObservedFileChangeBytes / 2);
  assert.equal(
    byteManager.observeFileChanges(threadId, turnId, "bytes", [{ path: exactUtf8Path, kind: "update" }]).kind,
    "observed",
  );
  assert.equal(
    byteManager.observeFileChanges(threadId, turnId, "bytes", [{ path: `${exactUtf8Path}x`, kind: "update" }]).kind,
    "resource_limit",
  );
  const overflowApproval = new FakeServerRequest("bytes-overflow", "item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "bytes",
    grantRoot: null,
  });
  const overflowEvent = admit(byteManager, overflowApproval);
  assert.equal(overflowEvent.snapshot.answerable, false);
  assert.deepEqual(overflowEvent.snapshot.display, {
    summary: "A file change approval request is unavailable.",
    unavailableReason: "resource_limit",
  });
  const consumed = new FakeServerRequest("bytes-consumed", "item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "bytes",
    grantRoot: null,
  });
  const consumedEvent = admit(byteManager, consumed);
  assert.equal(consumedEvent.snapshot.answerable, false);
  assert.deepEqual(consumedEvent.snapshot.display, {
    summary: "A file change approval request is unavailable.",
    unavailableReason: "unsafe_projection",
  });

  const replacementManager = new CodexAdapterInteractionManager();
  assert.equal(
    replacementManager.observeFileChanges(threadId, turnId, "replace", [{ path: exactUtf8Path, kind: "update" }]).kind,
    "observed",
  );
  assert.equal(
    replacementManager.observeFileChanges(threadId, turnId, "replace", [{ path: "src/small.ts", kind: "update" }]).kind,
    "observed",
  );
  assert.equal(
    replacementManager.observeFileChanges(threadId, turnId, "sibling", [
      { path: exactUtf8Path.slice(0, -"src/small.ts".length), kind: "update" },
    ]).kind,
    "observed",
  );
});

test("projection aggregate limit fails closed without evicting earlier interactions", async () => {
  const manager = new CodexAdapterInteractionManager();
  const events: ReturnType<typeof admit>[] = [];
  let overflow: FakeServerRequest | undefined;
  for (let interaction = 0; interaction < 16; interaction += 1) {
    const itemId = `large-file-item-${interaction}`;
    manager.observeFileChanges(
      threadId,
      turnId,
      itemId,
      Array.from({ length: 256 }, (_, index) => ({
        path: `${String(interaction).padStart(2, "0")}-${String(index).padStart(3, "0")}-${"x".repeat(492)}.ts`,
        kind: "update" as const,
      })),
    );
    const request = new FakeServerRequest(200 + interaction, "item/fileChange/requestApproval", {
      threadId,
      turnId,
      itemId,
    });
    const admission = manager.admit(request, workspace, () => true);
    if (admission.event === undefined) {
      assert.equal(admission.resourceLimit, true);
      overflow = request;
      break;
    }
    events.push(admission.event);
  }
  assert.ok(overflow, "expected the interaction transport projection aggregate limit to be reached");
  await manager.failClosedRequest(overflow);
  assert.deepEqual(overflow.responses, [{ decision: "decline" }]);
  const first = events[0];
  assert.ok(first);
  assert.equal(
    (
      await manager.respond(first.handle, {
        interactionId: first.snapshot.interactionId,
        kind: "codex.file_change_approval",
        payload: { decision: "accept" },
      })
    ).kind,
    "write_attempted",
  );
});
