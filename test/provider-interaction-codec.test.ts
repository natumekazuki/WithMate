import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODEX_PROVIDER_DEFINITION_VERSION,
  CODEX_PROVIDER_ID,
  canonicalizeCodexInteractionRequest,
  canonicalizeSafeDisplayText,
  canonicalizeWorkspaceRelativePath,
} from "../src/main/providers/codex/index.js";
import {
  canonicalizeCodexCommandDisplay,
  projectCodexCommandDisplay,
} from "../src/main/providers/codex/codex-interaction-codec.js";
import { defaultProviderDefinitionRegistry } from "../src/main/providers/provider-registry.js";
import {
  APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS,
  applicationRunInteractionCollectionWireBytes,
  applicationRunInteractionWireItemBytes,
} from "../src/shared/application-run-interaction-limits.js";
import type { ApplicationRunInteraction } from "../src/shared/application-run-model.js";

const workspacePath = "C:\\workspace";
const common = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1,
} as const;

test("Codex request codec separates protocol-invalid, unavailable, and canonical command requests", () => {
  const canonical = canonicalizeCodexInteractionRequest(
    "item/commandExecution/requestApproval",
    {
      ...common,
      command: "node C:\\workspace\\script.js",
      cwd: workspacePath,
      commandActions: [{ type: "unknown", command: "node C:\\workspace\\script.js" }],
      availableDecisions: ["accept", "decline", "cancel"],
    },
    { workspacePath },
  );
  assert.equal(canonical.kind, "canonical");
  if (canonical.kind !== "canonical") return;
  assert.equal(canonical.request.interactionKind, "codex.command_approval");
  assert.equal(Object.isFrozen(canonical.request.params), true);
  assert.deepEqual(canonical.request.params.availableDecisions, ["accept", "decline", "cancel"]);

  for (const availableDecisions of [undefined, null] as const) {
    const params = {
      ...common,
      command: "pwd",
      cwd: workspacePath,
      ...(availableDecisions === undefined ? {} : { availableDecisions }),
    };
    const result = canonicalizeCodexInteractionRequest("item/commandExecution/requestApproval", params, {
      workspacePath,
    });
    assert.equal(result.kind, "canonical");
    if (result.kind === "canonical") {
      assert.deepEqual(result.request.params.availableDecisions, ["accept", "decline", "cancel"]);
    }
  }
  const ordered = canonicalizeCodexInteractionRequest(
    "item/commandExecution/requestApproval",
    { ...common, command: "pwd", cwd: workspacePath, availableDecisions: ["cancel", "decline"] },
    { workspacePath },
  );
  assert.equal(ordered.kind, "canonical");
  if (ordered.kind === "canonical") {
    assert.deepEqual(ordered.request.params.availableDecisions, ["cancel", "decline"]);
  }

  for (const params of [
    { ...common, startedAtMs: "1", command: "pwd", cwd: workspacePath },
    { threadId: common.threadId, turnId: common.turnId, itemId: common.itemId, command: "pwd", cwd: workspacePath },
    { ...common, command: "pwd", cwd: 1 },
    { ...common, command: "pwd", cwd: workspacePath, commandActions: [{ type: "future", command: "pwd" }] },
    { ...common, command: "pwd", cwd: workspacePath, commandActions: [{ type: "unknown" }] },
  ]) {
    assert.deepEqual(
      canonicalizeCodexInteractionRequest("item/commandExecution/requestApproval", params, { workspacePath }),
      { kind: "protocol-invalid" },
    );
  }

  const additive = canonicalizeCodexInteractionRequest(
    "item/commandExecution/requestApproval",
    { ...common, command: "pwd", cwd: workspacePath, extra: true },
    { workspacePath },
  );
  assert.equal(additive.kind, "canonical");
  assert.equal(Object.hasOwn(additive.request.params, "extra"), false);

  for (const params of [
    { ...common, command: "pwd" },
    { ...common, command: "pwd", cwd: "C:\\other" },
    { ...common, command: "pwd\u202e", cwd: workspacePath },
    { ...common, command: "pwd", cwd: workspacePath, reason: "Provider reason" },
    { ...common, command: "pwd", cwd: workspacePath, additionalPermissions: {} },
    { ...common, command: "pwd", cwd: workspacePath, availableDecisions: [] },
    { ...common, command: "pwd", cwd: workspacePath, availableDecisions: ["decline", "decline"] },
    { ...common, command: "pwd", cwd: workspacePath, availableDecisions: ["acceptForSession"] },
    {
      ...common,
      command: "pwd",
      cwd: workspacePath,
      availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } }],
    },
    {
      ...common,
      command: "pwd",
      cwd: workspacePath,
      availableDecisions: [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: "example.test", action: "allow" },
          },
        },
      ],
    },
  ]) {
    assert.equal(
      canonicalizeCodexInteractionRequest("item/commandExecution/requestApproval", params, { workspacePath }).kind,
      "unavailable",
    );
  }

  for (const malformed of [
    { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["pwd"] } },
    { applyNetworkPolicyAmendment: { networkPolicyAmendment: { host: "example.test", action: "allow" } } },
  ]) {
    assert.equal(
      canonicalizeCodexInteractionRequest(
        "item/commandExecution/requestApproval",
        { ...common, command: "pwd", cwd: workspacePath, availableDecisions: [malformed] },
        { workspacePath },
      ).kind,
      "protocol-invalid",
    );
  }
});

test("command approval response must belong to the current Provider snapshot decision set", () => {
  const current = snapshot("codex.command_approval", {
    summary: "Command",
    command: "node --version",
    availableDecisions: ["decline"],
  });
  const response = {
    interactionId: current.interactionId,
    kind: "codex.command_approval",
    payload: { decision: "accept" },
  } as const;
  assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(current, response));
  assert.equal(
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(current, {
      ...response,
      payload: { decision: "decline" },
    }).semanticAction,
    "decline",
  );
});

test("Codex CommandAction variants keep known-field semantics while ignoring additive fields", () => {
  const actions = [
    { type: "read", command: "read file", name: "file", path: "C:\\workspace\\file.txt" },
    { type: "listFiles", command: "list", path: null },
    { type: "search", command: "search", query: "needle", path: "C:\\workspace" },
    { type: "unknown", command: "custom" },
  ] as const;
  for (const action of actions) {
    const result = canonicalizeCodexInteractionRequest(
      "item/commandExecution/requestApproval",
      { ...common, command: action.command, cwd: workspacePath, commandActions: [action] },
      { workspacePath },
    );
    assert.equal(result.kind, action.type === "unknown" ? "canonical" : "unavailable", action.type);
    assert.deepEqual((result.request.params.commandActions as readonly unknown[])[0], action);
  }

  const additiveAction = canonicalizeCodexInteractionRequest(
    "item/commandExecution/requestApproval",
    {
      ...common,
      command: "list",
      cwd: workspacePath,
      commandActions: [{ type: "listFiles", command: "list", path: null, extra: true, anotherExtra: 1 }],
    },
    { workspacePath },
  );
  assert.equal(additiveAction.kind, "unavailable");
  assert.deepEqual(additiveAction.request.params.commandActions, [{ type: "listFiles", command: "list", path: null }]);
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/commandExecution/requestApproval",
      {
        ...common,
        command: "read",
        cwd: workspacePath,
        commandActions: [
          { type: "read", command: "read", name: "file", path: workspacePath, query: "sibling variant field" },
        ],
      },
      { workspacePath },
    ).kind,
    "protocol-invalid",
  );
});

test("Codex file and permission requests enforce required fields before supported-subset availability", () => {
  assert.equal(
    canonicalizeCodexInteractionRequest("item/fileChange/requestApproval", { ...common, grantRoot: null }).kind,
    "canonical",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest("item/fileChange/requestApproval", { ...common, grantRoot: workspacePath })
      .kind,
    "unavailable",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest("item/fileChange/requestApproval", {
      ...common,
      grantRoot: null,
      unknown: true,
    }).kind,
    "canonical",
  );

  const permissions = {
    fileSystem: {
      entries: [{ access: "write", path: { type: "path", path: workspacePath } }],
      read: [],
    },
    network: { enabled: true },
  };
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/permissions/requestApproval",
      { ...common, cwd: workspacePath, permissions },
      { workspacePath },
    ).kind,
    "canonical",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/permissions/requestApproval",
      {
        ...common,
        cwd: workspacePath,
        permissions: {
          fileSystem: {
            entries: [{ access: "write", path: { type: "path", path: workspacePath } }],
            read: null,
            write: null,
          },
          network: null,
        },
      },
      { workspacePath },
    ).kind,
    "canonical",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/permissions/requestApproval",
      { ...common, permissions },
      { workspacePath },
    ).kind,
    "protocol-invalid",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/permissions/requestApproval",
      { ...common, cwd: workspacePath, permissions: { ...permissions, future: true } },
      { workspacePath },
    ).kind,
    "canonical",
  );
  const additivePath = canonicalizeCodexInteractionRequest(
    "item/permissions/requestApproval",
    {
      ...common,
      cwd: workspacePath,
      permissions: {
        fileSystem: {
          entries: [
            {
              access: "write",
              path: { type: "path", path: workspacePath, future: true, anotherFuture: 1 },
            },
          ],
        },
      },
    },
    { workspacePath },
  );
  assert.equal(additivePath.kind, "canonical");
  assert.equal(
    Object.hasOwn(
      (
        ((additivePath.request.params.permissions as Record<string, unknown>).fileSystem as Record<string, unknown>)
          .entries as readonly Record<string, unknown>[]
      )[0]?.path as Record<string, unknown>,
      "future",
    ),
    false,
  );
  assert.equal(
    canonicalizeCodexInteractionRequest(
      "item/permissions/requestApproval",
      {
        ...common,
        cwd: workspacePath,
        permissions: {
          fileSystem: {
            entries: [
              {
                access: "write",
                path: { type: "path", path: workspacePath, pattern: "sibling variant field" },
              },
            ],
          },
        },
      },
      { workspacePath },
    ).kind,
    "protocol-invalid",
  );
});

test("Codex user-input request codec keeps exact safe questions and taints secret or private display", () => {
  const params = {
    threadId: common.threadId,
    turnId: common.turnId,
    itemId: common.itemId,
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Choose one",
        isSecret: false,
        isOther: true,
        options: [
          { label: "one", description: "First" },
          { label: "two", description: "Second" },
        ],
      },
    ],
    autoResolutionMs: null,
  } as const;
  const canonical = canonicalizeCodexInteractionRequest("item/tool/requestUserInput", params);
  assert.equal(canonical.kind, "canonical");
  if (canonical.kind === "canonical") {
    assert.equal(canonical.request.interactionKind, "codex.user_input");
    assert.equal(Object.isFrozen(canonical.request.params.questions), true);
  }
  assert.equal(
    canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...params,
      questions: Array.from({ length: 33 }, (_, index) => ({
        ...params.questions[0],
        id: `choice-${index}`,
      })),
    }).kind,
    "unavailable",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...params,
      questions: [{ ...params.questions[0], isSecret: true }],
    }).kind,
    "unavailable",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...params,
      questions: [{ ...params.questions[0], question: "Read /private/secret" }],
    }).kind,
    "unavailable",
  );
  for (const privateOrAmbiguousPath of [
    "C:private\\secret.txt",
    "\\Users\\alice\\secret.txt",
    "//server/share/secret.txt",
    "///home/alice/secret",
    "~alice/secret",
  ]) {
    assert.equal(
      canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
        ...params,
        questions: [{ ...params.questions[0], question: `Read ${privateOrAmbiguousPath}` }],
      }).kind,
      "unavailable",
      privateOrAmbiguousPath,
    );
  }
  assert.equal(
    canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...params,
      questions: [{ ...params.questions[0], options: null }],
    }).kind,
    "unavailable",
  );
  assert.equal(
    canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...params,
      questions: [
        {
          ...params.questions[0],
          options: [
            { label: "one", description: "First" },
            { label: "one", description: "Again" },
          ],
        },
      ],
    }).kind,
    "unavailable",
  );
  for (const malformed of [
    {
      ...params,
      questions: [
        {
          ...params.questions[0],
          options: [{ label: "one" }, { label: "two", description: "Second" }],
        },
      ],
    },
    { ...params, questions: [{ ...params.questions[0], isOther: "yes" }] },
  ]) {
    assert.deepEqual(canonicalizeCodexInteractionRequest("item/tool/requestUserInput", malformed), {
      kind: "protocol-invalid",
    });
  }
  const additiveQuestion = canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
    ...params,
    questions: [{ ...params.questions[0], extra: true }],
  });
  assert.equal(additiveQuestion.kind, "canonical");
  assert.equal(
    Object.hasOwn((additiveQuestion.request.params.questions as readonly Record<string, unknown>[])[0] ?? {}, "extra"),
    false,
  );
});

test("Codex MCP request codec separates tool confirmation, form, unavailable variants, and malformed schemas", () => {
  const base = {
    threadId: common.threadId,
    turnId: common.turnId,
    serverName: "fixture",
    message: "Approve collect",
    mode: "form",
  } as const;
  const tool = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
    ...base,
    requestedSchema: { type: "object", properties: {} },
    meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "collect",
      tool_params: {},
      persist: ["session", "always"],
    },
  });
  assert.equal(tool.kind, "canonical");
  if (tool.kind === "canonical") assert.equal(tool.request.interactionKind, "codex.mcp_tool_approval");
  const stableMetadataAlias = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
    ...base,
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "collect",
      tool_params: {},
      persist: ["session", "always"],
    },
  });
  assert.equal(stableMetadataAlias.kind, "canonical");

  for (const persist of [undefined, "session", "always"] as const) {
    const scalarPersist = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
      ...base,
      requestedSchema: { type: "object", properties: {} },
      meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: "collect",
        tool_params: {},
        ...(persist === undefined ? {} : { persist }),
      },
    });
    assert.equal(scalarPersist.kind, "canonical", persist ?? "absent");
    if (scalarPersist.kind === "canonical") {
      assert.equal(scalarPersist.request.interactionKind, "codex.mcp_tool_approval");
      const canonicalMeta = scalarPersist.request.params.meta as Readonly<Record<string, unknown>>;
      if (persist === undefined) assert.equal(Object.hasOwn(canonicalMeta, "persist"), false);
      else assert.equal(canonicalMeta.persist, persist);
    }
  }

  for (const metaKey of ["meta", "_meta"] as const) {
    for (const persist of [
      [],
      ["future"],
      ["session", "session"],
      ["always", "session"],
      ["session", "always", "future"],
    ]) {
      assert.deepEqual(
        canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
          ...base,
          requestedSchema: { type: "object", properties: {} },
          [metaKey]: {
            codex_approval_kind: "mcp_tool_call",
            tool_name: "collect",
            tool_params: {},
            persist,
          },
        }),
        { kind: "protocol-invalid" },
        `${metaKey}:${JSON.stringify(persist)}`,
      );
    }
  }

  const form = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
    ...base,
    message: "Choose a value",
    requestedSchema: {
      type: "object",
      properties: { choice: { type: "string", title: "Choice", maxLength: 32 } },
      required: ["choice"],
    },
    _meta: null,
  });
  assert.equal(form.kind, "canonical");
  if (form.kind === "canonical") assert.equal(form.request.interactionKind, "codex.mcp_server_form");

  for (const unavailable of [
    {
      ...base,
      requestedSchema: { type: "object", properties: { contact: { type: "string", format: "email" } } },
    },
    {
      ...base,
      requestedSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            title: "Note",
            description: "A note",
            minLength: 1,
            default: "default",
          },
        },
      },
    },
    {
      ...base,
      requestedSchema: { type: "object", properties: { confirmed: { type: "boolean", default: false } } },
    },
    { ...base, turnId: null, _meta: null, requestedSchema: { type: "object", properties: {} } },
    {
      ...base,
      mode: "openai/form",
      _meta: null,
      requestedSchema: { type: "object", properties: {} },
    },
    {
      threadId: base.threadId,
      turnId: base.turnId,
      serverName: base.serverName,
      mode: "url",
      _meta: null,
      message: "Continue in browser",
      url: "https://example.test/continue",
      elicitationId: "elicitation-1",
    },
    { ...base, message: "Open C:\\private\\secret", requestedSchema: { type: "object", properties: {} } },
    {
      ...base,
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`field-${index}`, { type: "string" }]),
        ),
      },
    },
  ]) {
    assert.equal(canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", unavailable).kind, "unavailable");
  }
  for (const privateOrAmbiguousPath of [
    "C:private\\secret.txt",
    "\\Users\\alice\\secret.txt",
    "//server/share/secret.txt",
    "///home/alice/secret",
    "~alice/secret",
  ]) {
    assert.equal(
      canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
        ...base,
        message: `Open ${privateOrAmbiguousPath}`,
        requestedSchema: { type: "object", properties: {} },
      }).kind,
      "unavailable",
      privateOrAmbiguousPath,
    );
  }
  for (const malformed of [
    { ...base, mode: "future", requestedSchema: { type: "object", properties: {} } },
    {
      ...base,
      requestedSchema: { type: "object", properties: { secret: { type: "string", format: "password" } } },
    },
    { ...base, requestedSchema: { type: "object", properties: [], required: [] } },
    { ...base, requestedSchema: { type: "object", properties: { choice: { type: 1 } } } },
  ]) {
    assert.deepEqual(canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", malformed), {
      kind: "protocol-invalid",
    });
  }
  const additiveSchema = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
    ...base,
    requestedSchema: { type: "object", properties: {}, unknown: true },
  });
  assert.equal(additiveSchema.kind, "canonical");
  assert.equal(
    Object.hasOwn(additiveSchema.request.params.requestedSchema as Readonly<Record<string, unknown>>, "unknown"),
    false,
  );
});

test("protocol-valid interaction collection overflows stay unavailable resource limits", () => {
  const userInputBase = {
    threadId: common.threadId,
    turnId: common.turnId,
    itemId: common.itemId,
  } as const;
  const question = {
    id: "choice",
    header: "Choice",
    question: "Choose one",
    isSecret: false,
    isOther: false,
    options: [
      { label: "one", description: "First" },
      { label: "two", description: "Second" },
    ],
  } as const;
  for (const count of [32, 33] as const) {
    const result = canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...userInputBase,
      questions: Array.from({ length: count }, (_, index) => ({ ...question, id: `choice-${index}` })),
    });
    assert.equal(result.kind, count === 32 ? "canonical" : "unavailable");
    if (result.kind === "unavailable") assert.equal(result.reason, "resource_limit");
  }
  for (const count of [16, 17] as const) {
    const result = canonicalizeCodexInteractionRequest("item/tool/requestUserInput", {
      ...userInputBase,
      questions: [
        {
          ...question,
          options: Array.from({ length: count }, (_, index) => ({
            label: `option-${index}`,
            description: `Option ${index}`,
          })),
        },
      ],
    });
    assert.equal(result.kind, count === 16 ? "canonical" : "unavailable");
    if (result.kind === "unavailable") assert.equal(result.reason, "resource_limit");
  }

  const mcpBase = {
    threadId: common.threadId,
    turnId: common.turnId,
    serverName: "fixture",
    message: "Choose a value",
    mode: "form",
  } as const;
  for (const count of [256, 257] as const) {
    const result = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
      ...mcpBase,
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`field-${index}`, { type: "string" }]),
        ),
      },
    });
    assert.equal(result.kind, "unavailable", `properties=${count}`);
    if (result.kind === "unavailable") assert.equal(result.reason, "resource_limit");
  }
  for (const count of [4_096, 4_097] as const) {
    for (const [label, field] of [
      ["enum", { type: "string", enum: Array.from({ length: count }, (_, index) => `value-${index}`) }],
      [
        "multi-select",
        {
          type: "array",
          items: {
            anyOf: Array.from({ length: count }, (_, index) => ({ const: `value-${index}`, title: `Value ${index}` })),
          },
        },
      ],
    ] as const) {
      const result = canonicalizeCodexInteractionRequest("mcpServer/elicitation/request", {
        ...mcpBase,
        requestedSchema: { type: "object", properties: { choice: field } },
      });
      assert.equal(result.kind, "unavailable", `${label}=${count}`);
      if (result.kind === "unavailable") {
        assert.equal(result.reason, count === 4_096 ? "unsupported_shape" : "resource_limit", `${label}=${count}`);
      }
    }
  }
});

test("Registry canonicalizes six closed public snapshot kinds and unavailable snapshots", () => {
  const snapshots = [
    snapshot("codex.command_approval", {
      summary: "Command",
      command: "node <workspace>/app.js",
      availableDecisions: ["accept", "decline", "cancel"],
    }),
    snapshot("codex.file_change_approval", {
      summary: "Changes",
      changes: [{ displayPath: "src/index.ts", changeKind: "update" }],
    }),
    snapshot("codex.permission_approval", { summary: "Permissions", permissions: ["workspace_write"] }),
    snapshot("codex.user_input", {
      questions: [
        {
          questionId: "choice",
          header: "Choice",
          prompt: "Choose one",
          allowOther: false,
          options: [{ label: "one" }, { label: "two", description: "Second" }],
        },
      ],
    }),
    snapshot("codex.mcp_tool_approval", { server: "fixture", tool: "collect", summary: "Allow collect" }),
    snapshot("codex.mcp_server_form", {
      server: "fixture",
      message: "Enter values",
      fields: [{ fieldId: "value", label: "Value", inputType: "string", required: false, maxLength: 4096 }],
    }),
  ];
  for (const value of snapshots) {
    assert.deepEqual(defaultProviderDefinitionRegistry.canonicalizeInteractionSnapshot(value), value);
  }
  assert.deepEqual(
    defaultProviderDefinitionRegistry.canonicalizeInteractionSnapshot(
      snapshot("codex.permission_approval", {
        summary: "Permissions",
        permissions: ["network", "workspace_write"],
      }),
    ),
    snapshot("codex.permission_approval", {
      summary: "Permissions",
      permissions: ["workspace_write", "network"],
    }),
  );

  const unavailable = {
    ...snapshot("codex.command_approval", {
      summary: "A command approval request is unavailable.",
      unavailableReason: "unsafe_projection",
    }),
    answerable: false,
  } as const;
  assert.deepEqual(defaultProviderDefinitionRegistry.canonicalizeInteractionSnapshot(unavailable), unavailable);

  for (const invalid of [
    { ...snapshots[0], extra: true },
    { ...snapshots[0], display: { ...snapshots[0]?.display, privatePath: "C:\\Users\\name" } },
    { ...snapshots[0], display: { ...snapshots[0]?.display, availableDecisions: [] } },
    {
      ...snapshots[0],
      display: { ...snapshots[0]?.display, availableDecisions: ["decline", "decline"] },
    },
    { ...snapshots[0], display: { ...snapshots[0]?.display, availableDecisions: ["acceptForSession"] } },
    { ...snapshots[0], kind: "codex.future" },
    { ...unavailable, display: { ...unavailable.display, privateRequestId: "provider-1" } },
  ]) {
    assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeInteractionSnapshot(invalid));
  }
});

test("Safe display text and workspace-relative paths fail closed without truncation", () => {
  assert.equal(
    projectCodexCommandDisplay("node C:\\workspace\\script.js", workspacePath),
    "node <workspace>\\script.js",
  );
  assert.equal(projectCodexCommandDisplay('node "C:\\workspace\\a b.js"', workspacePath), 'node "<workspace>\\a b.js"');
  assert.equal(
    projectCodexCommandDisplay('node "C:\\work space\\secret.js"', "C:\\work space"),
    'node "<workspace>\\secret.js"',
  );
  assert.equal(projectCodexCommandDisplay("node C:\\work space\\secret.js", "C:\\work space"), undefined);
  assert.equal(projectCodexCommandDisplay('node "C:\\work space\\secret.js"', "C:\\work"), undefined);
  assert.equal(projectCodexCommandDisplay('cat "/work"space/secret', "/work"), undefined);
  for (const ambiguousQuote of [
    String.raw`cat "foo"C:\workspace\secret`,
    String.raw`cat "foo\"C:\workspace\secret`,
    String.raw`cat "C:\workspace\secret\" tail`,
    'cat "C:\\workspace\\secret`" tail"',
    'cat "C:\\workspace\\secret^" tail"',
  ]) {
    assert.equal(projectCodexCommandDisplay(ambiguousQuote, workspacePath), undefined, ambiguousQuote);
  }
  assert.equal(
    projectCodexCommandDisplay("node C:/workspace/src/a.js C:\\workspace\\src\\b.js", workspacePath),
    "node <workspace>/src/a.js <workspace>\\src\\b.js",
  );
  for (const unsafe of [
    "node C:\\private\\script.js",
    "node C:\\workspace-other\\script.js",
    "node C:\\workspace\\src\\a.js C:\\private\\b.js",
    "node \\\\server\\share\\script.js",
    "node \\\\?\\C:\\workspace\\script.js",
    "node /home/name/script.js",
    "node file:///tmp/private.js",
    "node ~/private.js",
    "node C:\\workspace\\src\\..\\private.js",
    "cd ..",
    "type \\Windows\\System32\\drivers\\etc\\hosts",
    "type C:secret.txt",
    "type C:..\\secret.txt",
    "cat //etc/passwd",
    "cat ~alice/secret",
  ]) {
    assert.equal(projectCodexCommandDisplay(unsafe, workspacePath), undefined, unsafe);
  }
  for (const safe of ["curl https://example.test/a/b", "git diff HEAD~1..HEAD", "node relative/path.js --flag"]) {
    assert.equal(projectCodexCommandDisplay(safe, workspacePath), safe, safe);
    assert.equal(canonicalizeCodexCommandDisplay(safe), safe, safe);
  }
  for (const [workspace, command] of [
    ["\\\\server\\share\\workspace", "node \\\\server\\share\\workspace\\a.js"],
    ["\\\\?\\C:\\workspace", "node \\\\?\\C:\\workspace\\a.js"],
  ] as const) {
    assert.equal(projectCodexCommandDisplay(command, workspace), undefined, workspace);
  }
  for (const unsafe of [
    "prefix<workspace>/x",
    "<workspace>suffix/x",
    "<workspace>/src/../private",
    "cd ..",
    "type \\Windows\\secret.txt",
    "type C:secret.txt",
    "cat //etc/passwd",
    "cat ~alice/secret",
    'cat "<workspace>"space/secret',
  ]) {
    assert.equal(canonicalizeCodexCommandDisplay(unsafe), undefined, unsafe);
  }
  for (const unsafe of [
    "C:\\Users\\name",
    "C:private\\secret.txt",
    "\\Users\\alice\\secret.txt",
    "\\\\server\\share",
    "//server/share/secret.txt",
    "///home/alice/secret",
    "file:///tmp/private",
    "FILE:///tmp/private",
    "File:///tmp/private",
    "fIlE:///tmp/private",
    "/home/name",
    "~/private",
    "~alice/secret",
  ]) {
    assert.equal(canonicalizeSafeDisplayText(unsafe, "body"), undefined, unsafe);
  }
  for (const unsafe of [
    "Location=/home/alice/.ssh/id_rsa",
    "path:C:\\Users\\alice\\secret.txt",
    "server=[\\\\server\\share]",
    "source={file:///tmp/private}",
    "home=~/private",
  ]) {
    assert.equal(canonicalizeSafeDisplayText(unsafe, "body"), undefined, unsafe);
  }
  assert.equal(
    canonicalizeSafeDisplayText("Open https://example.test/docs/path", "body"),
    "Open https://example.test/docs/path",
  );
  assert.equal(
    canonicalizeSafeDisplayText("Open https://example.test/docs//path", "body"),
    "Open https://example.test/docs//path",
  );
  for (const unsafe of ["line\nfeed", "bidi\u202etext", "lone\ud800surrogate"]) {
    assert.equal(canonicalizeSafeDisplayText(unsafe, "body"), undefined);
  }
  assert.equal(canonicalizeSafeDisplayText("😀".repeat(512), "short"), "😀".repeat(512));
  assert.equal(canonicalizeSafeDisplayText("x".repeat(513), "short"), undefined);

  const schema = JSON.parse(
    readFileSync(new URL("../schema/providers/codex/interaction-v1.schema.json", import.meta.url), "utf8"),
  ) as {
    $defs: {
      displayText: { pattern: string };
      commandDisplayText: { pattern: string; allOf: readonly { pattern: string }[] };
      shortDisplayText: { pattern: string };
      workspaceRelativeDisplayPath: { pattern: string };
    };
  };
  for (const definition of [schema.$defs.displayText, schema.$defs.commandDisplayText, schema.$defs.shortDisplayText]) {
    const displayPattern = new RegExp(definition.pattern, "u");
    assert.equal(displayPattern.test("Location=/home/alice/.ssh/id_rsa"), false);
    assert.equal(displayPattern.test("path:C:\\Users\\alice\\secret.txt"), false);
    assert.equal(displayPattern.test("FILE:///tmp/private"), false);
    assert.equal(displayPattern.test("File:///tmp/private"), false);
    assert.equal(displayPattern.test("fIlE:///tmp/private"), false);
    for (const privateOrAmbiguousPath of [
      "C:private\\secret.txt",
      "\\Users\\alice\\secret.txt",
      "//server/share/secret.txt",
      "///home/alice/secret",
      "~alice/secret",
    ]) {
      assert.equal(displayPattern.test(`Open ${privateOrAmbiguousPath}`), false, privateOrAmbiguousPath);
    }
    assert.equal(displayPattern.test("Open https://example.test/docs/path"), true);
    assert.equal(displayPattern.test("Open https://example.test/docs//path"), true);
    assert.equal(displayPattern.test("Compare HEAD~1..HEAD"), true);
  }
  const commandDisplayPatterns = [
    schema.$defs.commandDisplayText.pattern,
    ...schema.$defs.commandDisplayText.allOf.map((definition) => definition.pattern),
  ].map((pattern) => new RegExp(pattern, "u"));
  const commandSchemaAccepts = (candidate: string): boolean =>
    commandDisplayPatterns.every((pattern) => pattern.test(candidate));
  const commandBoundaryCases = [
    ["curl https://example.test/a//b", true],
    ["git diff HEAD~1..HEAD", true],
    ["node relative/path.js --flag", true],
    ["node <workspace>/src/index.js", true],
    ['node "<workspace>\\a b.js"', true],
    ['cd "<workspace>"', true],
    ["cat @<workspace>/secret", false],
    ["cat *<workspace>/secret", false],
    ["cat ?<workspace>/secret", false],
    ["cat +<workspace>/secret", false],
    ["cat <<workspace>/secret", false],
    ["cat <workspace>$suffix/secret", false],
    ["cat <workspace>*suffix/secret", false],
    ["cat <workspace>?suffix/secret", false],
    ["cat <workspace>+suffix/secret", false],
    ["cat <workspace>>suffix/secret", false],
    ['cat "<workspace>"$suffix/secret', false],
    ['cat "<workspace>"*suffix/secret', false],
    ['cat "<workspace>"?suffix/secret', false],
    ['cat "<workspace>"+suffix/secret', false],
    ['cat "<workspace>/child"$suffix/secret', false],
    ['cat *"<workspace>/secret"', false],
    ['cat ?"<workspace>/secret"', false],
    ['cat +"<workspace>/secret"', false],
    [String.raw`cat "foo"<workspace>\secret`, false],
    [String.raw`cat "foo" <workspace>\secret`, false],
    [String.raw`cat "foo\"<workspace>\secret`, false],
    [String.raw`cat "<workspace>\secret\" tail`, false],
    ['cat "<workspace>\\secret`" tail"', false],
    ['cat "<workspace>\\secret^" tail"', false],
    ["cat 'foo <workspace>/child'", false],
    ['cat "foo <workspace>/child"', false],
    ["cat '--file=<workspace>/child'", false],
    ["cat '<workspace>/child", false],
    ["cat <workspace>/child'suffix'", false],
    ['cat <workspace>/child"suffix"', false],
    ["cat '<workspace>\"'", false],
    ["cat '<workspace> '", false],
    ["cat '<workspace>;'", false],
    ['cat "<workspace>\'"', false],
    ['cat "<workspace> "', false],
    ['cat "<workspace>;"', false],
  ] as const;
  for (const [candidate, accepted] of commandBoundaryCases) {
    assert.equal(canonicalizeCodexCommandDisplay(candidate) !== undefined, accepted, `runtime:${candidate}`);
    assert.equal(commandSchemaAccepts(candidate), accepted, `schema:${candidate}`);
  }
  for (const unsafe of [
    "prefix<workspace>/x",
    "<workspace>suffix/x",
    "<workspace>/src/../private",
    "cd ..",
    "type \\Windows\\secret.txt",
    "type C:secret.txt",
    "cat //etc/passwd",
    "cat ~alice/secret",
    'cat "<workspace>"space/secret',
  ]) {
    assert.equal(commandSchemaAccepts(unsafe), false, unsafe);
  }
  const schemaPattern = new RegExp(schema.$defs.workspaceRelativeDisplayPath.pattern, "u");
  const valid = ["src/index.ts", ".config/settings.json", "a:b".replace(":", "-")];
  const invalid = ["~", "~/file", "a:b", "C:/file", "\\\\server\\share", "/absolute", "a/../b", "a//b", "a/"];
  for (const value of valid) {
    assert.equal(canonicalizeWorkspaceRelativePath(value), value);
    assert.equal(schemaPattern.test(value), true, value);
  }
  for (const value of invalid) {
    assert.equal(canonicalizeWorkspaceRelativePath(value), undefined, value);
    assert.equal(schemaPattern.test(value), false, value);
  }
});

test("MCP form value limits remain per value while collection wire accounting remains aggregate", () => {
  const current = snapshot("codex.mcp_server_form", {
    server: "fixture",
    message: "Enter a value",
    fields: [{ fieldId: "value", label: "Value", inputType: "string", required: true, maxLength: 4096 }],
  });
  const response = {
    interactionId: current.interactionId,
    kind: current.kind,
    payload: { action: "accept", values: { value: "x".repeat(4096) } },
  } as const;
  assert.equal(
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(current, response).semanticAction,
    "submit",
  );
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(current, {
      ...response,
      payload: { action: "accept", values: { value: "x".repeat(4097) } },
    }),
  );

  const itemBytes = applicationRunInteractionWireItemBytes(response);
  assert.ok(itemBytes > 4096);
  assert.ok(
    applicationRunInteractionCollectionWireBytes(itemBytes * 32, 32) <
      APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS.maxCollectionWireBytes,
  );
  assert.ok(
    applicationRunInteractionCollectionWireBytes(
      APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS.maxCollectionWireBytes,
      1,
    ) > APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS.maxCollectionWireBytes,
  );
});

function snapshot(kind: string, display: ApplicationRunInteraction["display"]): ApplicationRunInteraction {
  return {
    interactionId: "interaction-1",
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind,
    answerable: true,
    display,
  };
}
