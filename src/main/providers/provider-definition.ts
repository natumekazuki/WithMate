import type { ProviderSettingsEnvelope, ProviderSettingsJsonValue } from "../../shared/provider-settings.js";
import type {
  ApplicationRunInteraction,
  ApplicationRunInteractionJsonValue,
  ApplicationRunInteractionResponse,
} from "../../shared/application-run-model.js";
import type { RepositoryJsonValue, RunExecutionSnapshot } from "../../shared/repository-write-model.js";
import type {
  CodexResumeThreadInput,
  CodexStartThreadInput,
  CodexStartTurnInput,
} from "./codex/codex-adapter-contract.js";
import { snapshotProviderRecord } from "./provider-record.js";

export type ProviderSettingsUiField =
  | Readonly<{
      key: string;
      control: "text";
      label: string;
      required: true;
      maxLength: number;
    }>
  | Readonly<{
      key: string;
      control: "select";
      label: string;
      required: true;
      options: readonly Readonly<{ value: string; label: string }>[];
    }>
  | Readonly<{
      key: string;
      control: "sandbox";
      label: string;
      required: true;
      modes: readonly Readonly<{
        value: "read-only" | "workspace-write" | "danger-full-access";
        label: string;
        networkAccess: "required" | "forbidden";
      }>[];
    }>;

export type ProviderSettingsUiDefinition = Readonly<{
  providerId: string;
  definitionVersion: string;
  fields: readonly ProviderSettingsUiField[];
}>;

export type ProviderInteractionPresentation = "decision" | "questions" | "form";
export type ProviderInteractionActivity = "waiting_approval" | "waiting_input";

export type ProviderInteractionUiKind = Readonly<{
  kind: string;
  label: string;
  presentation: ProviderInteractionPresentation;
  activity: ProviderInteractionActivity;
}>;

export type ProviderInteractionUiDefinition = Readonly<{
  providerId: string;
  definitionVersion: string;
  kinds: readonly ProviderInteractionUiKind[];
}>;

export type ProviderExecutionScope = Readonly<{
  workspacePath: string;
  allowedAdditionalDirectories: readonly string[];
}>;

export type ProviderModelSelection = "explicit" | "inherited";

export type CompiledCodexProviderExecution = Readonly<{
  kind: "codex";
  providerId: "codex";
  definitionVersion: string;
  startThread: CodexStartThreadInput & Readonly<{ reasoningEffort: string }>;
  resumeThread: Omit<CodexResumeThreadInput, "threadId" | "model" | "modelSelection" | "reasoningEffort"> &
    Readonly<{ model: string; modelSelection: ProviderModelSelection; reasoningEffort: string }>;
  startTurn: Omit<CodexStartTurnInput, "threadId" | "contentBlocks" | "model" | "modelSelection" | "reasoningEffort"> &
    Readonly<{ model: string; modelSelection: ProviderModelSelection; reasoningEffort: string }>;
}>;

export type CompiledProviderExecution = CompiledCodexProviderExecution;

export type ProviderInteractionSemanticAction = "accept" | "decline" | "cancel" | "answer" | "submit";

export type ProviderCanonicalInteractionResponse = Readonly<{
  response: ApplicationRunInteractionResponse;
  semanticAction: ProviderInteractionSemanticAction;
}>;

export type ProviderCanonicalInteractionRequest = Readonly<{
  method: string;
  interactionKind: string;
  params: Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }>;
}>;

export type ProviderInteractionRequestCanonicalization =
  | Readonly<{ kind: "canonical"; request: ProviderCanonicalInteractionRequest }>
  | Readonly<{
      kind: "unavailable";
      reason: "resource_limit" | "unsafe_projection" | "unsupported_shape";
      request: ProviderCanonicalInteractionRequest;
    }>
  | Readonly<{ kind: "protocol-invalid" }>;

export type ProviderInteractionRequestContext = Readonly<{
  workspacePath?: string;
}>;

export interface ProviderDefinition {
  readonly providerId: string;
  readonly definitionVersion: string;
  readonly settingsUi: ProviderSettingsUiDefinition;
  readonly interactionUi: ProviderInteractionUiDefinition;
  canonicalizeSettings(value: unknown): Readonly<{ [key: string]: ProviderSettingsJsonValue }>;
  canonicalizeInteractionRequest(
    method: string,
    value: unknown,
    context?: ProviderInteractionRequestContext,
  ): ProviderInteractionRequestCanonicalization;
  canonicalizeInteractionSnapshot(value: unknown): ApplicationRunInteraction;
  canonicalizeInteractionResponseShape(value: unknown): ProviderCanonicalInteractionResponse;
  canonicalizeInteractionResponse(
    snapshot: ApplicationRunInteraction,
    value: unknown,
  ): ProviderCanonicalInteractionResponse;
  compile(
    settings: unknown,
    scope: ProviderExecutionScope,
    modelSelection: ProviderModelSelection,
  ): CompiledProviderExecution;
}

export class ProviderDefinitionRegistry {
  readonly #definitions: ReadonlyMap<string, ProviderDefinition>;

  constructor(definitions: readonly ProviderDefinition[]) {
    const entries = new Map<string, ProviderDefinition>();
    for (const definition of definitions) {
      const providerId = boundedString(definition.providerId, 1_024);
      const definitionVersion = boundedString(definition.definitionVersion, 1_024);
      const key = definitionKey(providerId, definitionVersion);
      if (entries.has(key)) throw new TypeError("Provider definition key is duplicated.");
      if (
        definition.settingsUi.providerId !== providerId ||
        definition.settingsUi.definitionVersion !== definitionVersion
      ) {
        throw new TypeError("Provider settings UI definition key is invalid.");
      }
      validateInteractionUi(definition.interactionUi, providerId, definitionVersion);
      entries.set(key, definition);
    }
    this.#definitions = entries;
  }

  definition(providerId: string, definitionVersion: string): ProviderDefinition | undefined {
    return this.#definitions.get(definitionKey(providerId, definitionVersion));
  }

  canonicalizeEnvelope(value: unknown): ProviderSettingsEnvelope {
    const envelope = exactRecord(value, ["providerId", "definitionVersion", "settings"]);
    const providerId = boundedString(envelope.providerId, 1_024);
    const definitionVersion = boundedString(envelope.definitionVersion, 1_024);
    const definition = this.definition(providerId, definitionVersion);
    if (definition === undefined) throw new TypeError("Provider definition is not registered.");
    return Object.freeze({
      providerId,
      definitionVersion,
      settings: definition.canonicalizeSettings(envelope.settings),
    });
  }

  compileSnapshot(snapshot: RunExecutionSnapshot): CompiledProviderExecution {
    const canonical = this.canonicalizeEnvelope({
      providerId: snapshot.providerId,
      definitionVersion: snapshot.definitionVersion,
      settings: snapshot.settings,
    });
    const workspace = exactRecord(snapshot.workspace, ["key", "path", "allowedAdditionalDirectories"]);
    return this.compileEnvelope(
      canonical,
      {
        workspacePath: boundedString(workspace.path, 32_768),
        allowedAdditionalDirectories: stringArray(workspace.allowedAdditionalDirectories, 128, 32_768),
      },
      snapshotModelSelection(snapshot),
    );
  }

  compileEnvelope(
    envelope: ProviderSettingsEnvelope,
    scope: ProviderExecutionScope,
    modelSelection: ProviderModelSelection = "explicit",
  ): CompiledProviderExecution {
    const definition = this.definition(envelope.providerId, envelope.definitionVersion);
    if (definition === undefined) throw new TypeError("Provider definition is not registered.");
    return definition.compile(envelope.settings, snapshotScope(scope), modelSelection);
  }

  settingsUi(providerId: string, definitionVersion: string): ProviderSettingsUiDefinition | undefined {
    return this.definition(providerId, definitionVersion)?.settingsUi;
  }

  settingsUiDefinitions(): readonly ProviderSettingsUiDefinition[] {
    return Object.freeze(Array.from(this.#definitions.values(), (definition) => definition.settingsUi));
  }

  interactionUi(providerId: string, definitionVersion: string): ProviderInteractionUiDefinition | undefined {
    return this.definition(providerId, definitionVersion)?.interactionUi;
  }

  interactionUiDefinitions(): readonly ProviderInteractionUiDefinition[] {
    return Object.freeze(Array.from(this.#definitions.values(), (definition) => definition.interactionUi));
  }

  interactionActivity(
    providerId: string,
    definitionVersion: string,
    kind: string,
  ): ProviderInteractionActivity | undefined {
    return this.interactionUi(providerId, definitionVersion)?.kinds.find((entry) => entry.kind === kind)?.activity;
  }

  canonicalizeInteractionRequest(
    providerId: string,
    definitionVersion: string,
    method: string,
    value: unknown,
    context?: ProviderInteractionRequestContext,
  ): ProviderInteractionRequestCanonicalization {
    const definition = this.definition(boundedString(providerId, 1_024), boundedString(definitionVersion, 1_024));
    if (definition === undefined) throw new TypeError("Provider interaction definition is not registered.");
    const canonical = definition.canonicalizeInteractionRequest(
      boundedString(method, 256),
      value,
      context === undefined
        ? undefined
        : Object.freeze({
            ...(context.workspacePath === undefined
              ? {}
              : { workspacePath: boundedString(context.workspacePath, 32_768) }),
          }),
    );
    if (
      canonical.kind !== "protocol-invalid" &&
      !definition.interactionUi.kinds.some((entry) => entry.kind === canonical.request.interactionKind)
    ) {
      throw new TypeError("Provider interaction kind is not registered.");
    }
    return canonical;
  }

  canonicalizeInteractionSnapshot(value: unknown): ApplicationRunInteraction {
    const record = plainExactRecord(value, [
      "interactionId",
      "providerId",
      "definitionVersion",
      "kind",
      "answerable",
      "display",
    ]);
    const providerId = boundedString(record.providerId, 1_024);
    const definitionVersion = boundedString(record.definitionVersion, 1_024);
    const definition = this.definition(providerId, definitionVersion);
    if (definition === undefined) throw new TypeError("Provider interaction definition is not registered.");
    const canonical = definition.canonicalizeInteractionSnapshot(value);
    if (!definition.interactionUi.kinds.some((entry) => entry.kind === canonical.kind)) {
      throw new TypeError("Provider interaction kind is not registered.");
    }
    return canonical;
  }

  canonicalizeInteractionResponse(
    snapshot: ApplicationRunInteraction,
    value: unknown,
  ): ProviderCanonicalInteractionResponse {
    const canonicalSnapshot = this.canonicalizeInteractionSnapshot(snapshot);
    const definition = this.definition(canonicalSnapshot.providerId, canonicalSnapshot.definitionVersion);
    if (definition === undefined) throw new TypeError("Provider interaction definition is not registered.");
    return definition.canonicalizeInteractionResponse(canonicalSnapshot, value);
  }

  canonicalizeInteractionResponseShape(
    providerId: string,
    definitionVersion: string,
    value: unknown,
  ): ProviderCanonicalInteractionResponse {
    const definition = this.definition(boundedString(providerId, 1_024), boundedString(definitionVersion, 1_024));
    if (definition === undefined) throw new TypeError("Provider interaction definition is not registered.");
    const canonical = definition.canonicalizeInteractionResponseShape(value);
    if (!definition.interactionUi.kinds.some((entry) => entry.kind === canonical.response.kind)) {
      throw new TypeError("Provider interaction kind is not registered.");
    }
    return canonical;
  }
}

export function providerRequestJson(
  contentBlocks: readonly Readonly<{ type: "text"; text: string }>[],
  compiled: CompiledProviderExecution,
): Readonly<{ [key: string]: RepositoryJsonValue }> {
  return Object.freeze({
    providerId: compiled.providerId,
    definitionVersion: compiled.definitionVersion,
    contentBlocks: Object.freeze(contentBlocks.map((block) => Object.freeze({ ...block }))),
    startTurn: compiled.startTurn as Readonly<{ [key: string]: RepositoryJsonValue }>,
  });
}

function definitionKey(providerId: string, definitionVersion: string): string {
  return `${providerId}\u0000${definitionVersion}`;
}

function validateInteractionUi(
  value: ProviderInteractionUiDefinition,
  providerId: string,
  definitionVersion: string,
): void {
  const definition = plainExactRecord(value, ["providerId", "definitionVersion", "kinds"]);
  if (definition.providerId !== providerId || definition.definitionVersion !== definitionVersion) {
    throw new TypeError("Provider interaction UI definition key is invalid.");
  }
  if (!Array.isArray(definition.kinds) || definition.kinds.length < 1 || definition.kinds.length > 64) {
    throw new TypeError("Provider interaction UI kinds are invalid.");
  }
  const kinds = new Set<string>();
  for (let index = 0; index < definition.kinds.length; index += 1) {
    if (!Object.hasOwn(definition.kinds, index)) {
      throw new TypeError("Provider interaction UI kinds are invalid.");
    }
    const entry = plainExactRecord(definition.kinds[index], ["kind", "label", "presentation", "activity"]);
    const kind = boundedString(entry.kind, 256);
    boundedString(entry.label, 512);
    if (entry.presentation !== "decision" && entry.presentation !== "questions" && entry.presentation !== "form") {
      throw new TypeError("Provider interaction presentation is invalid.");
    }
    if (entry.activity !== "waiting_approval" && entry.activity !== "waiting_input") {
      throw new TypeError("Provider interaction activity is invalid.");
    }
    if (kinds.has(kind)) throw new TypeError("Provider interaction kind is duplicated.");
    kinds.add(kind);
  }
}

function plainExactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Provider definition record is invalid.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Provider definition record is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError("Provider definition record keys are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Provider definition record is invalid.");
    }
  }
  return record;
}

function snapshotScope(scope: ProviderExecutionScope): ProviderExecutionScope {
  return Object.freeze({
    workspacePath: boundedString(scope.workspacePath, 32_768),
    allowedAdditionalDirectories: Object.freeze(stringArray(scope.allowedAdditionalDirectories, 128, 32_768)),
  });
}

function snapshotModelSelection(snapshot: RunExecutionSnapshot): ProviderModelSelection {
  const modelSelection = snapshot.modelSelection;
  if (modelSelection !== "explicit" && modelSelection !== "inherited") {
    throw new TypeError("Provider model selection provenance is invalid.");
  }
  return modelSelection;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return snapshotProviderRecord(value, keys);
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) {
    throw new TypeError("Provider string is invalid.");
  }
  return value;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError("Provider string array is invalid.");
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("Provider string array is invalid.");
    output.push(boundedString(value[index], maxLength));
  }
  return output;
}
