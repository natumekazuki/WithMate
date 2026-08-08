import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODEX_PROVIDER_DEFINITION_VERSION,
  CODEX_PROVIDER_ID,
  CODEX_INTERACTION_KINDS,
  CODEX_PROVIDER_INTERACTION_UI,
  CODEX_PROVIDER_SETTINGS_UI,
  canonicalizeCodexProviderSettings,
  codexProviderDefinition,
} from "../src/main/providers/codex/index.js";
import {
  ProviderDefinitionRegistry,
  type ProviderDefinition,
  type ProviderInteractionUiDefinition,
} from "../src/main/providers/provider-definition.js";
import type { RunExecutionSnapshot } from "../src/shared/repository-write-model.js";
import {
  defaultProviderDefinitionRegistry,
  providerInteractionUiDefinitions,
  providerSettingsUiDefinitions,
} from "../src/main/providers/provider-registry.js";

const envelope = {
  providerId: CODEX_PROVIDER_ID,
  definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
  settings: {
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    approvalPolicy: "on-request",
    sandbox: { mode: "workspace-write", networkAccess: false },
  },
} as const;

const interactionId = "interaction-1";

const interactionSnapshots = {
  "codex.command_approval": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.command_approval",
    answerable: true,
    display: {
      summary: "Command",
      command: "node --version",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  },
  "codex.file_change_approval": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.file_change_approval",
    answerable: true,
    display: { summary: "Changes", changes: [{ displayPath: "src/index.ts", changeKind: "update" }] },
  },
  "codex.permission_approval": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.permission_approval",
    answerable: true,
    display: { summary: "Permissions", permissions: ["workspace_write"] },
  },
  "codex.user_input": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.user_input",
    answerable: true,
    display: {
      questions: [
        {
          questionId: "choice",
          header: "Choice",
          prompt: "Choose",
          allowOther: false,
          options: [{ label: "one" }, { label: "two", description: "Second" }],
        },
      ],
    },
  },
  "codex.mcp_tool_approval": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.mcp_tool_approval",
    answerable: true,
    display: { server: "fixture", tool: "collect", summary: "Allow collect" },
  },
  "codex.mcp_server_form": {
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: "codex.mcp_server_form",
    answerable: true,
    display: {
      server: "fixture",
      message: "Enter values",
      fields: [{ fieldId: "optional", label: "Optional", inputType: "string", required: false, maxLength: 4 }],
    },
  },
} as const;

test("Codex Provider definition owns its complete exact settings envelope and UI metadata", () => {
  assert.deepEqual(defaultProviderDefinitionRegistry.canonicalizeEnvelope(envelope), envelope);
  assert.deepEqual(defaultProviderDefinitionRegistry.settingsUi(CODEX_PROVIDER_ID, CODEX_PROVIDER_DEFINITION_VERSION), {
    ...CODEX_PROVIDER_SETTINGS_UI,
  });
  assert.deepEqual(providerSettingsUiDefinitions(), [CODEX_PROVIDER_SETTINGS_UI]);
  assert.deepEqual(
    CODEX_PROVIDER_SETTINGS_UI.fields.find((field) => field.key === "approvalPolicy"),
    {
      key: "approvalPolicy",
      control: "select",
      label: "Approval policy",
      required: true,
      options: [
        { value: "never", label: "Never" },
        { value: "untrusted", label: "Untrusted" },
        { value: "on-request", label: "On request" },
      ],
    },
  );
});

test("Codex Provider definition owns exact interaction UI metadata and activity classification", () => {
  assert.deepEqual(
    defaultProviderDefinitionRegistry.interactionUi(CODEX_PROVIDER_ID, CODEX_PROVIDER_DEFINITION_VERSION),
    CODEX_PROVIDER_INTERACTION_UI,
  );
  assert.deepEqual(providerInteractionUiDefinitions(), [CODEX_PROVIDER_INTERACTION_UI]);
  assert.deepEqual(
    CODEX_PROVIDER_INTERACTION_UI.kinds.map(({ kind, presentation, activity }) => ({
      kind,
      presentation,
      activity,
    })),
    [
      { kind: "codex.command_approval", presentation: "decision", activity: "waiting_approval" },
      { kind: "codex.file_change_approval", presentation: "decision", activity: "waiting_approval" },
      { kind: "codex.permission_approval", presentation: "decision", activity: "waiting_approval" },
      { kind: "codex.user_input", presentation: "questions", activity: "waiting_input" },
      { kind: "codex.mcp_tool_approval", presentation: "decision", activity: "waiting_approval" },
      { kind: "codex.mcp_server_form", presentation: "form", activity: "waiting_input" },
    ],
  );
  for (const entry of CODEX_PROVIDER_INTERACTION_UI.kinds) {
    assert.equal(
      defaultProviderDefinitionRegistry.interactionActivity(
        CODEX_PROVIDER_ID,
        CODEX_PROVIDER_DEFINITION_VERSION,
        entry.kind,
      ),
      entry.activity,
    );
  }
  assert.equal(defaultProviderDefinitionRegistry.interactionUi("unknown", "unknown"), undefined);
  assert.equal(
    defaultProviderDefinitionRegistry.interactionActivity(
      CODEX_PROVIDER_ID,
      CODEX_PROVIDER_DEFINITION_VERSION,
      "codex.unknown",
    ),
    undefined,
  );
});

test("Codex interaction schema kind and owner sets stay aligned with Provider interaction metadata", () => {
  const schema = interactionSchema();
  const metadataKinds = sorted(CODEX_PROVIDER_INTERACTION_UI.kinds.map((entry) => entry.kind));
  const unavailableKinds = sorted(schema.$defs.unavailableSnapshot.properties.kind.enum);
  const snapshotEntries = referencedInteractionEntries(schema, "snapshot", "unavailableSnapshot");
  const responseEntries = referencedInteractionEntries(schema, "response");

  assert.deepEqual(sorted(snapshotEntries.map((entry) => entry.kind)), metadataKinds);
  assert.deepEqual(sorted(responseEntries.map((entry) => entry.kind)), metadataKinds);
  assert.deepEqual(unavailableKinds, metadataKinds);
  assert.deepEqual(sorted(CODEX_INTERACTION_KINDS), metadataKinds);
  const commandDisplaySchema = (
    schema.$defs.commandApprovalSnapshot as Readonly<{
      allOf: readonly [
        unknown,
        Readonly<{
          properties: Readonly<{
            display: Readonly<{
              required: readonly string[];
              properties: Readonly<{
                availableDecisions: Readonly<{
                  minItems: number;
                  maxItems: number;
                  uniqueItems: boolean;
                  items: Readonly<{ enum: readonly string[] }>;
                }>;
              }>;
            }>;
          }>;
        }>,
      ];
    }>
  ).allOf[1].properties.display;
  assert.deepEqual(commandDisplaySchema.required, ["summary", "command", "availableDecisions"]);
  assert.deepEqual(commandDisplaySchema.properties.availableDecisions, {
    type: "array",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: { enum: ["accept", "decline", "cancel"] },
  });
  assert.deepEqual(schema.$defs.permissionPayload, {
    type: "object",
    additionalProperties: false,
    required: ["permissions", "scope"],
    properties: {
      permissions: {
        type: "array",
        maxItems: 2,
        uniqueItems: true,
        items: { enum: ["workspace_write", "network"] },
      },
      scope: { const: "turn" },
    },
  });
  const permissionResponseSchema = schema.$defs.permissionApprovalResponse as Readonly<{
    allOf: readonly [unknown, Readonly<{ properties: Readonly<{ payload: Readonly<{ $ref: string }> }> }>];
  }>;
  assert.equal(permissionResponseSchema.allOf[1].properties.payload.$ref, "#/$defs/permissionPayload");
  for (const entry of snapshotEntries) {
    assert.equal(entry.providerId, CODEX_PROVIDER_ID);
    assert.equal(entry.definitionVersion, CODEX_PROVIDER_DEFINITION_VERSION);
  }
});

test("Codex Provider canonicalizes every response kind before applying current snapshot rules", () => {
  const cases = [
    ["codex.command_approval", { decision: "accept" }, "accept"],
    ["codex.file_change_approval", { decision: "decline" }, "decline"],
    ["codex.permission_approval", { permissions: ["workspace_write"], scope: "turn" }, "accept"],
    ["codex.user_input", { answers: { choice: ["one"] } }, "answer"],
    ["codex.mcp_tool_approval", { decision: "accept" }, "accept"],
    ["codex.mcp_server_form", { action: "accept", values: {} }, "submit"],
  ] as const;

  for (const [kind, payload, semanticAction] of cases) {
    const response = { interactionId, kind, payload };
    const staticCanonical = defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
      CODEX_PROVIDER_ID,
      CODEX_PROVIDER_DEFINITION_VERSION,
      response,
    );
    assert.deepEqual(staticCanonical, { response, semanticAction });
    assert.deepEqual(
      defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(interactionSnapshots[kind], response),
      staticCanonical,
    );
    assert.equal(Object.isFrozen(staticCanonical), true);
    assert.equal(Object.isFrozen(staticCanonical.response), true);
    assert.equal(Object.isFrozen(staticCanonical.response.payload), true);
  }

  for (const action of ["decline", "cancel"] as const) {
    assert.equal(
      defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(interactionSnapshots["codex.mcp_server_form"], {
        interactionId,
        kind: "codex.mcp_server_form",
        payload: { action },
      }).semanticAction,
      action,
    );
  }
});

test("Codex response canonicalization is deterministic without a live snapshot and dynamically exact with one", () => {
  const first = defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
    CODEX_PROVIDER_ID,
    CODEX_PROVIDER_DEFINITION_VERSION,
    {
      interactionId,
      kind: "codex.mcp_server_form",
      payload: { action: "accept", values: { z: "last", a: "first" } },
    },
  );
  const second = defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
    CODEX_PROVIDER_ID,
    CODEX_PROVIDER_DEFINITION_VERSION,
    {
      interactionId,
      kind: "codex.mcp_server_form",
      payload: { values: { a: "first", z: "last" }, action: "accept" },
    },
  );
  assert.deepEqual(first, second);

  const permissionFirst = defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
    CODEX_PROVIDER_ID,
    CODEX_PROVIDER_DEFINITION_VERSION,
    {
      interactionId,
      kind: "codex.permission_approval",
      payload: { permissions: ["network", "workspace_write"], scope: "turn" },
    },
  );
  const permissionSecond = defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
    CODEX_PROVIDER_ID,
    CODEX_PROVIDER_DEFINITION_VERSION,
    {
      interactionId,
      kind: "codex.permission_approval",
      payload: { scope: "turn", permissions: ["workspace_write", "network"] },
    },
  );
  assert.deepEqual(permissionFirst, permissionSecond);
  assert.deepEqual(permissionFirst, {
    response: {
      interactionId,
      kind: "codex.permission_approval",
      payload: { permissions: ["workspace_write", "network"], scope: "turn" },
    },
    semanticAction: "accept",
  });

  const fullPermissionSnapshot = {
    ...interactionSnapshots["codex.permission_approval"],
    display: { summary: "Permissions", permissions: ["network", "workspace_write"] },
  } as const;
  for (const permissions of [[], ["workspace_write"], ["network"], ["network", "workspace_write"]] as const) {
    const canonical = defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(fullPermissionSnapshot, {
      interactionId,
      kind: "codex.permission_approval",
      payload: { permissions, scope: "turn" },
    });
    assert.equal(canonical.semanticAction, permissions.length === 0 ? "decline" : "accept");
  }

  for (const payload of [
    { permissions: ["network"], scope: "turn" },
    { permissions: ["workspace_write", "workspace_write"], scope: "turn" },
    { permissions: ["future"], scope: "turn" },
    { permissions: ["workspace_write"], scope: "session" },
    { permissions: ["workspace_write"], scope: "turn", extra: true },
    { decision: "cancel" },
  ] as const) {
    assert.throws(() =>
      defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(
        interactionSnapshots["codex.permission_approval"],
        { interactionId, kind: "codex.permission_approval", payload },
      ),
    );
  }

  const freeInputSnapshot = {
    ...interactionSnapshots["codex.user_input"],
    display: {
      questions: [
        {
          ...interactionSnapshots["codex.user_input"].display.questions[0],
          allowOther: true,
        },
      ],
    },
  } as const;
  assert.equal(
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(freeInputSnapshot, {
      interactionId,
      kind: "codex.user_input",
      payload: { answers: { choice: ["x".repeat(2_048)] } },
    }).semanticAction,
    "answer",
  );

  for (const [snapshot, response] of [
    [interactionSnapshots["codex.user_input"], { interactionId, kind: "codex.user_input", payload: { answers: {} } }],
    [
      interactionSnapshots["codex.user_input"],
      { interactionId, kind: "codex.user_input", payload: { answers: { choice: ["other"] } } },
    ],
    [
      interactionSnapshots["codex.mcp_server_form"],
      { interactionId, kind: "codex.mcp_server_form", payload: { action: "accept", values: { unknown: "x" } } },
    ],
    [
      { ...interactionSnapshots["codex.command_approval"], answerable: false },
      { interactionId, kind: "codex.command_approval", payload: { decision: "accept" } },
    ],
    [
      { ...interactionSnapshots["codex.command_approval"], definitionVersion: "future" },
      { interactionId, kind: "codex.command_approval", payload: { decision: "accept" } },
    ],
  ] as const) {
    assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(snapshot as never, response));
  }
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(freeInputSnapshot, {
      interactionId,
      kind: "codex.user_input",
      payload: { answers: { choice: ["x".repeat(2_049)] } },
    }),
  );
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape("other", "future", {
      interactionId,
      kind: "codex.command_approval",
      payload: { decision: "accept" },
    }),
  );
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
      CODEX_PROVIDER_ID,
      CODEX_PROVIDER_DEFINITION_VERSION,
      { interactionId, kind: "codex.unknown", payload: { decision: "accept" } },
    ),
  );
});

test("Codex response canonicalization rejects accessors, proxies, sparse arrays, and duplicate dynamic ids", () => {
  let getterReads = 0;
  const accessor = { kind: "codex.command_approval", payload: { decision: "accept" } } as Record<string, unknown>;
  Object.defineProperty(accessor, "interactionId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return interactionId;
    },
  });
  const sparse = new Array<string>(1);
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
    { interactionId, kind: "codex.user_input", payload: { answers: { choice: sparse } } },
  ]) {
    assert.throws(() =>
      defaultProviderDefinitionRegistry.canonicalizeInteractionResponseShape(
        CODEX_PROVIDER_ID,
        CODEX_PROVIDER_DEFINITION_VERSION,
        response,
      ),
    );
  }
  assert.equal(getterReads, 0);

  const duplicateQuestions = {
    ...interactionSnapshots["codex.user_input"],
    display: {
      questions: [
        interactionSnapshots["codex.user_input"].display.questions[0],
        interactionSnapshots["codex.user_input"].display.questions[0],
      ],
    },
  } as const;
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeInteractionResponse(duplicateQuestions, {
      interactionId,
      kind: "codex.user_input",
      payload: { answers: { choice: ["one"] } },
    }),
  );
});

test("Provider registry rejects invalid interaction UI keys, duplicate kinds, and non-plain bounded metadata", () => {
  const firstKind = CODEX_PROVIDER_INTERACTION_UI.kinds[0];
  assert.ok(firstKind);
  assert.throws(
    () =>
      new ProviderDefinitionRegistry([
        definitionWithInteractionUi({ ...CODEX_PROVIDER_INTERACTION_UI, providerId: "other" }),
      ]),
  );
  assert.throws(
    () =>
      new ProviderDefinitionRegistry([
        definitionWithInteractionUi({
          ...CODEX_PROVIDER_INTERACTION_UI,
          kinds: [firstKind, firstKind],
        }),
      ]),
  );
  assert.throws(
    () =>
      new ProviderDefinitionRegistry([
        definitionWithInteractionUi({
          ...CODEX_PROVIDER_INTERACTION_UI,
          kinds: [{ ...firstKind, label: "x".repeat(513) }],
        }),
      ]),
  );
  const inherited = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
    ...firstKind,
  });
  assert.throws(
    () =>
      new ProviderDefinitionRegistry([
        definitionWithInteractionUi({ ...CODEX_PROVIDER_INTERACTION_UI, kinds: [inherited] } as never),
      ]),
  );
});

test("Codex Provider definition rejects partial, unknown, unregistered, and unsupported approval settings", () => {
  for (const value of [
    { ...envelope, extra: true },
    { ...envelope, definitionVersion: "future" },
    { ...envelope, providerId: "other" },
    { ...envelope, settings: { ...envelope.settings, extra: true } },
    {
      ...envelope,
      settings: {
        model: envelope.settings.model,
        reasoningEffort: envelope.settings.reasoningEffort,
        approvalPolicy: envelope.settings.approvalPolicy,
      },
    },
    { ...envelope, settings: { ...envelope.settings, approvalPolicy: "granular" } },
  ]) {
    assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeEnvelope(value));
  }
});

test("Codex Provider settings canonicalization rejects hostile record structures without executing accessors", () => {
  let getterReads = 0;
  const accessorEnvelope = {
    providerId: envelope.providerId,
    definitionVersion: envelope.definitionVersion,
    get settings(): unknown {
      getterReads += 1;
      return envelope.settings;
    },
  };
  assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeEnvelope(accessorEnvelope));
  assert.equal(getterReads, 0);

  const accessorSettings = {
    ...envelope.settings,
    get model(): string {
      getterReads += 1;
      return envelope.settings.model;
    },
  };
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeEnvelope({ ...envelope, settings: accessorSettings }),
  );
  assert.equal(getterReads, 0);

  const proxiedEnvelope = new Proxy({ ...envelope }, {});
  const proxiedSettings = new Proxy({ ...envelope.settings }, {});
  const inheritedSettings = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
    ...envelope.settings,
  });
  assert.throws(() => defaultProviderDefinitionRegistry.canonicalizeEnvelope(proxiedEnvelope));
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeEnvelope({ ...envelope, settings: proxiedSettings }),
  );
  assert.throws(() =>
    defaultProviderDefinitionRegistry.canonicalizeEnvelope({ ...envelope, settings: inheritedSettings }),
  );
});

test("Codex Provider compilation applies Application workspace scope without storing it in Provider settings", () => {
  const compiled = defaultProviderDefinitionRegistry.compileEnvelope(envelope, {
    workspacePath: "C:\\workspace",
    allowedAdditionalDirectories: ["C:\\shared"],
  });
  assert.equal(compiled.kind, "codex");
  assert.deepEqual(compiled.startThread, {
    model: "gpt-5.6-luna",
    modelSelection: "explicit",
    reasoningEffort: "high",
    workspacePath: "C:\\workspace",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    persistence: "persistent",
  });
  assert.deepEqual(compiled.resumeThread, {
    model: "gpt-5.6-luna",
    modelSelection: "explicit",
    reasoningEffort: "high",
    workspacePath: "C:\\workspace",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  });
  assert.deepEqual(compiled.startTurn, {
    workspacePath: "C:\\workspace",
    approvalPolicy: "on-request",
    sandboxPolicy: {
      mode: "workspace-write",
      networkAccess: false,
      writableRoots: ["C:\\workspace", "C:\\shared"],
    },
    model: "gpt-5.6-luna",
    modelSelection: "explicit",
    reasoningEffort: "high",
  });
  assert.equal(Object.hasOwn(canonicalizeCodexProviderSettings(envelope.settings), "workspacePath"), false);
});

test("Codex Provider snapshot compilation preserves inherited model selection provenance", () => {
  const snapshot = {
    providerId: envelope.providerId,
    definitionVersion: envelope.definitionVersion,
    modelSelection: "inherited",
    settings: envelope.settings,
    workspace: {
      key: "workspace-key",
      path: "C:\\workspace",
      allowedAdditionalDirectories: ["C:\\shared"],
    },
    character: null,
  } as unknown as RunExecutionSnapshot;

  const compiled = defaultProviderDefinitionRegistry.compileSnapshot(snapshot);

  assert.equal(compiled.kind, "codex");
  assert.equal(compiled.startThread.modelSelection, "inherited");
  assert.equal(compiled.resumeThread.modelSelection, "inherited");
  assert.equal(compiled.startTurn.modelSelection, "inherited");
  assert.throws(() =>
    defaultProviderDefinitionRegistry.compileSnapshot({ ...snapshot, modelSelection: "future" } as never),
  );
});

test("Codex Provider sandbox variants enforce their exact network field shapes", () => {
  assert.deepEqual(
    canonicalizeCodexProviderSettings({ ...envelope.settings, sandbox: { mode: "danger-full-access" } }),
    { ...envelope.settings, sandbox: { mode: "danger-full-access" } },
  );
  assert.throws(() =>
    canonicalizeCodexProviderSettings({
      ...envelope.settings,
      sandbox: { mode: "danger-full-access", networkAccess: true },
    }),
  );
  assert.throws(() => canonicalizeCodexProviderSettings({ ...envelope.settings, sandbox: { mode: "read-only" } }));
});

type InteractionSchemaEntry = Readonly<{
  providerId: string | undefined;
  definitionVersion: string | undefined;
  kind: string;
}>;

type InteractionSchema = Readonly<{
  $defs: Readonly<
    Record<string, unknown> & {
      unavailableSnapshot: Readonly<{
        properties: Readonly<{ kind: Readonly<{ enum: readonly string[] }> }>;
      }>;
      snapshot: Readonly<{ oneOf: readonly Readonly<{ $ref: string }>[] }>;
      response: Readonly<{ oneOf: readonly Readonly<{ $ref: string }>[] }>;
    }
  >;
}>;

function interactionSchema(): InteractionSchema {
  return JSON.parse(
    readFileSync(new URL("../schema/providers/codex/interaction-v1.schema.json", import.meta.url), "utf8"),
  ) as InteractionSchema;
}

function referencedInteractionEntries(
  schema: InteractionSchema,
  aggregate: "snapshot" | "response",
  excludedDefinition?: string,
): readonly InteractionSchemaEntry[] {
  return schema.$defs[aggregate].oneOf
    .map((reference) => reference.$ref.replace("#/$defs/", ""))
    .filter((definitionName) => definitionName !== excludedDefinition)
    .map((definitionName) => {
      const definition = schema.$defs[definitionName] as Readonly<{
        allOf: readonly [unknown, Readonly<{ properties: Readonly<Record<string, Readonly<{ const: string }>>> }>];
      }>;
      const properties = definition.allOf[1].properties;
      return {
        providerId: properties.providerId?.const,
        definitionVersion: properties.definitionVersion?.const,
        kind: properties.kind?.const ?? "",
      };
    });
}

function definitionWithInteractionUi(interactionUi: ProviderInteractionUiDefinition): ProviderDefinition {
  return { ...codexProviderDefinition, interactionUi };
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}
