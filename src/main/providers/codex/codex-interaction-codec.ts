import path from "node:path";

import type {
  ApplicationRunInteraction,
  ApplicationRunInteractionJsonValue,
} from "../../../shared/application-run-model.js";
import {
  CODEX_ADAPTER_COMMAND_DECISIONS,
  CODEX_ADAPTER_LIMITS,
  type CodexAdapterCommandDecision,
  type CodexAdapterInteractionKind,
  isCodexAdapterCommandDecision,
} from "./codex-adapter-contract.js";
import { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";

export const CODEX_INTERACTION_KINDS = Object.freeze([
  "codex.command_approval",
  "codex.file_change_approval",
  "codex.permission_approval",
  "codex.user_input",
  "codex.mcp_tool_approval",
  "codex.mcp_server_form",
] as const satisfies readonly CodexAdapterInteractionKind[]);

export type CodexCanonicalInteractionRequest = Readonly<{
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval"
    | "item/tool/requestUserInput"
    | "mcpServer/elicitation/request";
  interactionKind: CodexAdapterInteractionKind;
  params: Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }>;
}>;

export type CodexInteractionRequestCanonicalization =
  | Readonly<{ kind: "canonical"; request: CodexCanonicalInteractionRequest }>
  | Readonly<{
      kind: "unavailable";
      reason: "resource_limit" | "unsafe_projection" | "unsupported_shape";
      request: CodexCanonicalInteractionRequest;
    }>
  | Readonly<{ kind: "protocol-invalid" }>;

export type CodexInteractionRequestContext = Readonly<{
  workspacePath?: string;
}>;

type CanonicalRequestState = {
  unavailableReason?: Exclude<
    Extract<CodexInteractionRequestCanonicalization, { kind: "unavailable" }>["reason"],
    never
  >;
};

type SafeDisplayTextProfile = "short" | "body";

const CONTROL_BIDI_OR_NONCHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/u;
const PRIVATE_OR_AMBIGUOUS_PATH_LIKE =
  /(?:file:\/\/|(?:^|[^A-Za-z0-9_./-])(?<!http:)(?<!https:)\/{2,}|(?:^|[^A-Za-z0-9_./-])(?:[A-Za-z]:|\\|\/[^\s/]|~[A-Za-z0-9._-]*(?=$|[\\/])))/iu;
const COMMAND_PRIVATE_OR_AMBIGUOUS_PATH_LIKE =
  /(?:file:\/\/|(?:^|[^A-Za-z0-9_./-])(?<!http:)(?<!https:)\/{2,}|(?:^|[^A-Za-z0-9_./-])(?:[A-Za-z]:|(?<!<workspace>)\\|(?<!<workspace>)\/(?!\/)|~[A-Za-z0-9._-]*(?=$|[\\/])))/iu;
const COMMAND_PARENT_PATH_SEGMENT = /(?:^|[\\/\s'"=;|&<>(){}[\]])\.\.(?=$|[\\/\s'"=;|&<>(){}[\]])/u;
const WORKSPACE_DISPLAY_PLACEHOLDER = "<workspace>";
const WORKSPACE_PLACEHOLDER_PREFIX_BOUNDARY = /[\s'"=,:;|&<>(){}[\]]/u;
const COMMAND_TOKEN_BOUNDARY = /[\s;|&<>()]/u;
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/u;

const COMMAND_KEYS = Object.freeze([
  "threadId",
  "turnId",
  "itemId",
  "startedAtMs",
  "approvalId",
  "environmentId",
  "reason",
  "networkApprovalContext",
  "command",
  "cwd",
  "commandActions",
  "additionalPermissions",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
  "availableDecisions",
]);
const FILE_KEYS = Object.freeze(["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"]);
const PERMISSION_KEYS = Object.freeze([
  "threadId",
  "turnId",
  "itemId",
  "startedAtMs",
  "cwd",
  "permissions",
  "environmentId",
  "reason",
]);
const USER_INPUT_KEYS = Object.freeze(["threadId", "turnId", "itemId", "questions", "autoResolutionMs"]);
const MCP_KEYS = Object.freeze([
  "threadId",
  "turnId",
  "serverName",
  "message",
  "mode",
  "requestedSchema",
  "url",
  "elicitationId",
  "meta",
  "_meta",
]);

export function canonicalizeCodexInteractionRequest(
  method: string,
  value: unknown,
  context: CodexInteractionRequestContext = Object.freeze({}),
): CodexInteractionRequestCanonicalization {
  try {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return canonicalizeCommandRequest(value, context);
      case "item/fileChange/requestApproval":
        return canonicalizeFileRequest(value);
      case "item/permissions/requestApproval":
        return canonicalizePermissionRequest(value, context);
      case "item/tool/requestUserInput":
        return canonicalizeUserInputRequest(value);
      case "mcpServer/elicitation/request":
        return canonicalizeMcpRequest(value);
      default:
        return Object.freeze({ kind: "protocol-invalid" });
    }
  } catch (error) {
    if (error instanceof ProtocolInvalid) return Object.freeze({ kind: "protocol-invalid" });
    throw error;
  }
}

export function canonicalizeCodexInteractionSnapshot(value: unknown): ApplicationRunInteraction {
  const snapshot = exactRecord(value, [
    "interactionId",
    "providerId",
    "definitionVersion",
    "kind",
    "answerable",
    "display",
  ]);
  const interactionId = publicIdentifier(snapshot.interactionId);
  if (
    interactionId === undefined ||
    snapshot.providerId !== CODEX_PROVIDER_ID ||
    snapshot.definitionVersion !== CODEX_PROVIDER_DEFINITION_VERSION ||
    !isCodexInteractionKind(snapshot.kind) ||
    typeof snapshot.answerable !== "boolean"
  ) {
    invalidSnapshot();
  }
  const display = inspectRecord(snapshot.display, CODEX_ADAPTER_LIMITS.maxInteractionFormFields + 2);
  if (display === undefined) invalidSnapshot();
  const canonicalDisplay =
    snapshot.answerable === false
      ? canonicalizeUnavailableDisplay(display)
      : canonicalizeAnswerableDisplay(snapshot.kind, display);
  return Object.freeze({
    interactionId,
    providerId: CODEX_PROVIDER_ID,
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    kind: snapshot.kind,
    answerable: snapshot.answerable,
    display: canonicalDisplay,
  });
}

export function canonicalizeWorkspaceRelativePath(value: unknown): string | undefined {
  const decoded = boundedUnicodeString(
    value,
    1,
    CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints,
    CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints * 4,
  );
  if (
    decoded === undefined ||
    CONTROL_BIDI_OR_NONCHARACTER.test(decoded) ||
    decoded.includes(":") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded === "~" ||
    decoded.startsWith("~/") ||
    decoded.endsWith("/") ||
    decoded.includes("//")
  ) {
    return undefined;
  }
  return decoded.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : decoded;
}

export function canonicalizeSafeDisplayText(value: unknown, profile: SafeDisplayTextProfile): string | undefined {
  const short = profile === "short";
  const decoded = boundedUnicodeString(
    value,
    1,
    short ? CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints : CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints,
    short
      ? CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints * 4
      : CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints * 4,
  );
  if (decoded === undefined || CONTROL_BIDI_OR_NONCHARACTER.test(decoded)) return undefined;
  return PRIVATE_OR_AMBIGUOUS_PATH_LIKE.test(decoded) ? undefined : decoded;
}

export function canonicalizeCodexCommandDisplay(value: unknown): string | undefined {
  const decoded = boundedUnicodeString(
    value,
    1,
    CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints,
    CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints * 4,
  );
  if (decoded === undefined || CONTROL_BIDI_OR_NONCHARACTER.test(decoded)) return undefined;
  if (!workspacePlaceholdersAreCanonical(decoded)) return undefined;
  const withoutPlaceholders = decoded.replaceAll(WORKSPACE_DISPLAY_PLACEHOLDER, "workspace");
  if (
    withoutPlaceholders.includes("<workspace") ||
    withoutPlaceholders.includes("workspace>") ||
    COMMAND_PRIVATE_OR_AMBIGUOUS_PATH_LIKE.test(decoded) ||
    COMMAND_PARENT_PATH_SEGMENT.test(decoded)
  ) {
    return undefined;
  }
  return decoded;
}

export function projectCodexCommandDisplay(value: unknown, workspacePath: string | undefined): string | undefined {
  const command = boundedUnicodeString(
    value,
    1,
    CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints,
    CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints * 4,
  );
  if (
    command === undefined ||
    CONTROL_BIDI_OR_NONCHARACTER.test(command) ||
    command.includes(WORKSPACE_DISPLAY_PLACEHOLDER) ||
    typeof workspacePath !== "string" ||
    workspacePath.length === 0 ||
    workspacePath.startsWith("\\") ||
    workspacePath.startsWith("//")
  ) {
    return undefined;
  }

  if (!/^(?:[A-Za-z]:[\\/]|\/[^/])/u.test(workspacePath)) return undefined;
  if (/^(?:[A-Za-z]:[\\/]*|[\\/]+)$/u.test(workspacePath)) return undefined;
  const workspaceRoot = workspacePath.replace(/[\\/]+$/u, "");
  if (workspaceRoot.length === 0) {
    return undefined;
  }
  const variants = [
    ...new Set([workspaceRoot, workspaceRoot.replaceAll("\\", "/"), workspaceRoot.replaceAll("/", "\\")]),
  ]
    .filter((entry) => entry.length > 0)
    .sort((left, right) => right.length - left.length);
  const caseInsensitive = /^[A-Za-z]:[\\/]/u.test(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_./-])(${variants.map(escapeRegExp).join("|")})`,
    caseInsensitive ? "giu" : "gu",
  );
  let invalidOccurrence = false;
  const projected = command.replace(
    pattern,
    (match: string, prefix: string, matchedRoot: string, offset: number, source: string) => {
      const rootStart = offset + prefix.length;
      const rootEnd = rootStart + matchedRoot.length;
      if (!workspacePathOccurrenceIsComplete(source, rootStart, rootEnd)) {
        invalidOccurrence = true;
        return match;
      }
      return `${prefix}${WORKSPACE_DISPLAY_PLACEHOLDER}`;
    },
  );

  if (invalidOccurrence) return undefined;
  if (projected === command && COMMAND_PRIVATE_OR_AMBIGUOUS_PATH_LIKE.test(command)) return undefined;
  return canonicalizeCodexCommandDisplay(projected);
}

function workspacePlaceholdersAreCanonical(value: string): boolean {
  let offset = 0;
  for (;;) {
    const index = value.indexOf(WORKSPACE_DISPLAY_PLACEHOLDER, offset);
    if (index < 0) return true;
    const prefix = index === 0 ? undefined : value[index - 1];
    const suffixIndex = index + WORKSPACE_DISPLAY_PLACEHOLDER.length;
    if (
      (prefix !== undefined && !WORKSPACE_PLACEHOLDER_PREFIX_BOUNDARY.test(prefix)) ||
      !workspacePathOccurrenceIsComplete(value, index, suffixIndex)
    ) {
      return false;
    }
    offset = suffixIndex;
  }
}

function workspacePathOccurrenceIsComplete(value: string, rootStart: number, rootEnd: number): boolean {
  const quote = quoteContextAt(value, rootStart);
  if (quote === "ambiguous") return false;
  if (quote !== undefined) {
    if (rootStart !== quote.start + 1) return false;
    const beforeQuote = quote.start === 0 ? undefined : value[quote.start - 1];
    if (beforeQuote !== undefined && !WORKSPACE_PLACEHOLDER_PREFIX_BOUNDARY.test(beforeQuote)) return false;
    const closingQuote = findClosingQuote(value, quote.kind, rootEnd);
    if (closingQuote < 0) return false;
    const afterRoot = value[rootEnd];
    if (afterRoot !== quote.kind && afterRoot !== "/" && afterRoot !== "\\") return false;
    const afterQuote = value[closingQuote + 1];
    return afterQuote === undefined || COMMAND_TOKEN_BOUNDARY.test(afterQuote);
  }

  const beforeRoot = rootStart === 0 ? undefined : value[rootStart - 1];
  if (beforeRoot === "'" || beforeRoot === '"') return false;
  const occurrence = value.slice(rootStart, rootEnd);
  if (
    occurrence !== WORKSPACE_DISPLAY_PLACEHOLDER &&
    (/['"]/u.test(occurrence) || COMMAND_TOKEN_BOUNDARY.test(occurrence))
  ) {
    return false;
  }
  const afterRoot = value[rootEnd];
  if (afterRoot === undefined) return true;
  if (afterRoot !== "/" && afterRoot !== "\\") return COMMAND_TOKEN_BOUNDARY.test(afterRoot);
  for (let index = rootEnd + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" || character === '"') return false;
    if (COMMAND_TOKEN_BOUNDARY.test(character as string)) return true;
  }
  return true;
}

function quoteContextAt(
  value: string,
  offset: number,
): Readonly<{ kind: "'" | '"'; start: number }> | "ambiguous" | undefined {
  let context: { kind: "'" | '"'; start: number } | undefined;
  let sawClosedQuote = false;
  for (let index = 0; index < offset; index += 1) {
    const character = value[index];
    if (character !== "'" && character !== '"') continue;
    if (quoteIsEscaped(value, index)) return "ambiguous";
    if (context === undefined) context = { kind: character, start: index };
    else if (context.kind === character) {
      context = undefined;
      sawClosedQuote = true;
    }
  }
  return sawClosedQuote ? "ambiguous" : context;
}

function findClosingQuote(value: string, quote: "'" | '"', offset: number): number {
  for (let index = offset; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "'" && character !== '"') continue;
    if (quoteIsEscaped(value, index)) return -1;
    if (character === quote) return index;
  }
  return -1;
}

function quoteIsEscaped(value: string, offset: number): boolean {
  const prefix = offset === 0 ? undefined : value[offset - 1];
  return prefix === "\\" || prefix === "`" || prefix === "^";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function canonicalizeCommandRequest(
  value: unknown,
  context: CodexInteractionRequestContext,
): CodexInteractionRequestCanonicalization {
  const input = exactAllowedRecord(value, COMMAND_KEYS, ["threadId", "turnId", "itemId", "startedAtMs"]);
  const state: CanonicalRequestState = {};
  const output = commonRequestParams(input);
  copyOptionalNullableIdentifier(input, output, "approvalId", state, true);
  copyOptionalNullableIdentifier(input, output, "environmentId", state, true);
  copyOptionalNullableText(input, output, "reason", state, true);
  copyOptionalJsonObject(input, output, "networkApprovalContext", state, true);
  copyOptionalCommandText(input, output, "command", state);
  copyOptionalCommandText(input, output, "cwd", state);
  copyCommandActions(input, output, state);
  copyOptionalJsonObject(input, output, "additionalPermissions", state, true);
  copyOptionalStringArray(input, output, "proposedExecpolicyAmendment", state, false);
  copyOptionalJsonArray(input, output, "proposedNetworkPolicyAmendments", state, true);
  copyAvailableDecisions(input, output, state);

  const command = typeof output.command === "string" ? output.command : undefined;
  const cwd = typeof output.cwd === "string" ? output.cwd : undefined;
  if (command === undefined || cwd === undefined) markUnavailable(state, "unsupported_shape");
  if (command !== undefined && projectCodexCommandDisplay(command, context.workspacePath) === undefined) {
    markUnavailable(state, "unsafe_projection");
  }
  if (cwd !== undefined && unsafeInternalText(cwd)) markUnavailable(state, "unsafe_projection");
  if (!sameAbsolutePath(cwd, context.workspacePath)) markUnavailable(state, "unsupported_shape");
  if (!commandActionsSupportPlainDecision(output.commandActions, command)) {
    markUnavailable(state, "unsupported_shape");
  }

  return requestResult("item/commandExecution/requestApproval", "codex.command_approval", output, state);
}

function canonicalizeFileRequest(value: unknown): CodexInteractionRequestCanonicalization {
  const input = exactAllowedRecord(value, FILE_KEYS, ["threadId", "turnId", "itemId", "startedAtMs"]);
  const state: CanonicalRequestState = {};
  const output = commonRequestParams(input);
  copyOptionalNullableText(input, output, "reason", state, true);
  copyOptionalCommandText(input, output, "grantRoot", state);
  if (typeof output.grantRoot === "string") markUnavailable(state, "unsupported_shape");
  return requestResult("item/fileChange/requestApproval", "codex.file_change_approval", output, state);
}

function canonicalizePermissionRequest(
  value: unknown,
  context: CodexInteractionRequestContext,
): CodexInteractionRequestCanonicalization {
  const input = exactAllowedRecord(value, PERMISSION_KEYS, [
    "threadId",
    "turnId",
    "itemId",
    "startedAtMs",
    "cwd",
    "permissions",
  ]);
  const state: CanonicalRequestState = {};
  const output = commonRequestParams(input);
  const cwd = protocolString(input.cwd, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  output.cwd = cwd;
  if (unsafeInternalText(cwd)) markUnavailable(state, "unsafe_projection");
  if (!sameAbsolutePath(cwd, context.workspacePath)) markUnavailable(state, "unsupported_shape");
  output.permissions = canonicalizePermissionProfile(input.permissions, state);
  if (!permissionSubsetSupported(output.permissions, context.workspacePath)) {
    markUnavailable(state, "unsupported_shape");
  }
  copyOptionalNullableIdentifier(input, output, "environmentId", state, true);
  copyOptionalNullableText(input, output, "reason", state, true);
  return requestResult("item/permissions/requestApproval", "codex.permission_approval", output, state);
}

function canonicalizeUserInputRequest(value: unknown): CodexInteractionRequestCanonicalization {
  const input = exactAllowedRecord(value, USER_INPUT_KEYS, ["threadId", "turnId", "itemId", "questions"]);
  const state: CanonicalRequestState = {};
  const output: Record<string, ApplicationRunInteractionJsonValue> = {
    threadId: protocolIdentifier(input.threadId),
    turnId: protocolIdentifier(input.turnId),
    itemId: protocolIdentifier(input.itemId),
  };
  if (Object.hasOwn(input, "autoResolutionMs")) {
    if (
      input.autoResolutionMs !== null &&
      (!Number.isSafeInteger(input.autoResolutionMs) || (input.autoResolutionMs as number) < 0)
    ) {
      protocolInvalid();
    }
    output.autoResolutionMs = input.autoResolutionMs as number | null;
  }
  const questions = protocolArray(input.questions, CODEX_ADAPTER_LIMITS.maxArrayItems, state);
  if (questions.length === 0) markUnavailable(state, "unsupported_shape");
  if (questions.length > CODEX_ADAPTER_LIMITS.maxInteractionQuestions) markUnavailable(state, "resource_limit");
  const questionIds = new Set<string>();
  output.questions = Object.freeze(
    questions.map((entry) => {
      const question = exactAllowedRecord(
        entry,
        ["id", "header", "question", "isSecret", "isOther", "options"],
        ["id", "header", "question"],
      );
      const id = protocolIdentifier(question.id);
      if (questionIds.has(id)) markUnavailable(state, "unsupported_shape");
      questionIds.add(id);
      const header = protocolString(question.header, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      const prompt = protocolString(question.question, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      const isSecret = Object.hasOwn(question, "isSecret") ? question.isSecret : false;
      const isOther = Object.hasOwn(question, "isOther") ? question.isOther : false;
      if (typeof isSecret !== "boolean" || typeof isOther !== "boolean") protocolInvalid();
      if (
        canonicalizeSafeDisplayText(header, "short") === undefined ||
        canonicalizeSafeDisplayText(prompt, "body") === undefined ||
        isSecret
      ) {
        markUnavailable(state, "unsafe_projection");
      }
      const options =
        question.options === undefined || question.options === null
          ? undefined
          : protocolArray(question.options, CODEX_ADAPTER_LIMITS.maxArrayItems, state);
      if (options === undefined || options.length < 2) markUnavailable(state, "unsupported_shape");
      const canonicalOptionValues = options ?? [];
      if (canonicalOptionValues.length > CODEX_ADAPTER_LIMITS.maxInteractionOptionsPerQuestion) {
        markUnavailable(state, "resource_limit");
      }
      const labels = new Set<string>();
      const canonicalOptions = canonicalOptionValues.map((optionValue) => {
        const option = exactAllowedRecord(optionValue, ["label", "description"], ["label", "description"]);
        const label = protocolString(option.label, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
        if (labels.has(label)) markUnavailable(state, "unsupported_shape");
        labels.add(label);
        const description = protocolString(option.description, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
        if (
          canonicalizeSafeDisplayText(label, "short") === undefined ||
          canonicalizeSafeDisplayText(description, "short") === undefined
        ) {
          markUnavailable(state, "unsafe_projection");
        }
        return Object.freeze({ label, description });
      });
      return Object.freeze({
        id,
        header,
        question: prompt,
        isSecret,
        isOther,
        ...(question.options === undefined
          ? {}
          : { options: question.options === null ? null : Object.freeze(canonicalOptions) }),
      });
    }),
  );
  return requestResult("item/tool/requestUserInput", "codex.user_input", output, state);
}

function canonicalizeMcpRequest(value: unknown): CodexInteractionRequestCanonicalization {
  const input = exactAllowedRecord(value, MCP_KEYS, ["threadId", "turnId", "serverName", "mode"]);
  if (Object.hasOwn(input, "meta") && Object.hasOwn(input, "_meta")) protocolInvalid();
  const state: CanonicalRequestState = {};
  const serverName = protocolString(input.serverName, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  const mode = protocolString(input.mode, 1, 128);
  const output: Record<string, ApplicationRunInteractionJsonValue> = {
    threadId: protocolIdentifier(input.threadId),
    turnId: input.turnId === null ? null : protocolIdentifier(input.turnId),
    serverName,
    mode,
  };
  if (input.turnId === null) markUnavailable(state, "unsupported_shape");
  if (canonicalizeSafeDisplayText(serverName, "short") === undefined) markUnavailable(state, "unsafe_projection");
  const metaKey = Object.hasOwn(input, "meta") ? "meta" : Object.hasOwn(input, "_meta") ? "_meta" : undefined;
  const metaValue = metaKey === undefined ? undefined : canonicalJsonValue(input[metaKey], 0, state);
  if (metaKey !== undefined) output[metaKey] = metaValue as ApplicationRunInteractionJsonValue;

  switch (mode) {
    case "form": {
      assertMcpVariantKeys(input, ["message", "requestedSchema"], ["message", "requestedSchema"]);
      const message = protocolString(input.message, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      output.message = message;
      if (canonicalizeSafeDisplayText(message, "body") === undefined) markUnavailable(state, "unsafe_projection");
      const schema = canonicalizeMcpSchema(input.requestedSchema, state);
      output.requestedSchema = schema;
      const meta = metaRecord(metaValue);
      const discriminator = meta?.codex_approval_kind;
      if (meta !== undefined && discriminator === "mcp_tool_call") {
        if (!mcpToolRequestSupported(mode, schema, meta, state)) markUnavailable(state, "unsupported_shape");
        return requestResult("mcpServer/elicitation/request", "codex.mcp_tool_approval", output, state);
      }
      if (discriminator !== undefined) markUnavailable(state, "unsupported_shape");
      return requestResult("mcpServer/elicitation/request", "codex.mcp_server_form", output, state);
    }
    case "openai/form": {
      assertMcpVariantKeys(input, ["message", "requestedSchema"], ["message", "requestedSchema"]);
      output.message = protocolString(input.message, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      output.requestedSchema = canonicalJsonValue(input.requestedSchema, 0, state);
      markUnavailable(state, "unsupported_shape");
      return requestResult("mcpServer/elicitation/request", "codex.mcp_server_form", output, state);
    }
    case "url": {
      assertMcpVariantKeys(input, ["message", "url", "elicitationId"], ["message", "url", "elicitationId"]);
      output.message = protocolString(input.message, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      output.url = protocolString(input.url, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
      output.elicitationId = protocolIdentifier(input.elicitationId);
      markUnavailable(state, "unsupported_shape");
      return requestResult("mcpServer/elicitation/request", "codex.mcp_server_form", output, state);
    }
    default:
      return protocolInvalid();
  }
}

function canonicalizeMcpSchema(
  value: unknown,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const schema = exactAllowedRecord(value, ["$schema", "type", "properties", "required"], ["type", "properties"]);
  if (schema.type !== "object") protocolInvalid();
  const properties = protocolRecord(schema.properties, CODEX_ADAPTER_LIMITS.maxObjectProperties, state);
  if (Object.keys(properties).length > CODEX_ADAPTER_LIMITS.maxInteractionFormFields) {
    markUnavailable(state, "resource_limit");
  }
  const canonicalProperties: Record<string, ApplicationRunInteractionJsonValue> = {};
  for (const [fieldId, fieldValue] of Object.entries(properties)) {
    protocolIdentifier(fieldId);
    canonicalProperties[fieldId] = canonicalizeMcpPrimitiveSchema(fieldValue, state);
  }
  const output: Record<string, ApplicationRunInteractionJsonValue> = {
    type: "object",
    properties: Object.freeze(canonicalProperties),
  };
  if (Object.hasOwn(schema, "$schema")) {
    output.$schema = protocolString(schema.$schema, 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
    markUnavailable(state, "unsupported_shape");
  }
  if (Object.hasOwn(schema, "required")) {
    const requiredEntries = protocolArray(schema.required, CODEX_ADAPTER_LIMITS.maxArrayItems, state);
    if (requiredEntries.length > CODEX_ADAPTER_LIMITS.maxInteractionFormFields) {
      markUnavailable(state, "resource_limit");
    }
    const required = requiredEntries.map((entry) => protocolIdentifier(entry));
    if (new Set(required).size !== required.length || required.some((id) => !Object.hasOwn(properties, id))) {
      markUnavailable(state, "unsupported_shape");
    }
    output.required = Object.freeze(required);
  }
  return Object.freeze(output);
}

function canonicalizeMcpPrimitiveSchema(
  value: unknown,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const candidate = inspectRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (candidate === undefined || typeof candidate.type !== "string") protocolInvalid();
  switch (candidate.type) {
    case "string":
      return canonicalizeMcpStringSchema(candidate, state);
    case "number":
    case "integer":
      return canonicalizeMcpNumberSchema(candidate, state);
    case "boolean":
      return canonicalizeMcpBooleanSchema(candidate, state);
    case "array":
      return canonicalizeMcpArraySchema(candidate, state);
    default:
      return protocolInvalid();
  }
}

function canonicalizeMcpStringSchema(
  value: Readonly<Record<string, unknown>>,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const hasEnum = Object.hasOwn(value, "enum") || Object.hasOwn(value, "enumNames");
  const hasOneOf = Object.hasOwn(value, "oneOf");
  if (hasEnum && hasOneOf) protocolInvalid();
  const allowed = hasEnum
    ? ["type", "title", "description", "enum", "enumNames", "default"]
    : hasOneOf
      ? ["type", "title", "description", "oneOf", "default"]
      : ["type", "title", "description", "minLength", "maxLength", "format", "default"];
  const required = hasEnum ? ["type", "enum"] : hasOneOf ? ["type", "oneOf"] : ["type"];
  const field = exactAllowedRecord(value, allowed, required);
  const output: Record<string, ApplicationRunInteractionJsonValue> = { type: "string" };
  copyMcpSchemaText(field, output, "title", state, "short");
  copyMcpSchemaText(field, output, "description", state, "body");
  for (const key of ["minLength", "maxLength"] as const) {
    if (!Object.hasOwn(field, key)) continue;
    if (!Number.isSafeInteger(field[key]) || (field[key] as number) < 0) protocolInvalid();
    output[key] = field[key] as number;
  }
  if (Object.hasOwn(field, "format")) {
    if (field.format !== "email" && field.format !== "uri" && field.format !== "date" && field.format !== "date-time") {
      protocolInvalid();
    }
    output.format = field.format;
  }
  if (Object.hasOwn(field, "enum")) output.enum = canonicalizeMcpStringArray(field.enum, state);
  if (Object.hasOwn(field, "enumNames")) output.enumNames = canonicalizeMcpStringArray(field.enumNames, state);
  if (Object.hasOwn(field, "oneOf")) output.oneOf = canonicalizeMcpConstOptions(field.oneOf, state);
  if (Object.hasOwn(field, "default")) {
    output.default = protocolString(field.default, 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  }
  const supportedKeys = ["type", "title", "maxLength"];
  if (Object.keys(field).some((key) => !supportedKeys.includes(key))) markUnavailable(state, "unsupported_shape");
  if (
    typeof output.maxLength === "number" &&
    (output.maxLength < 1 || output.maxLength > CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints)
  ) {
    markUnavailable(
      state,
      output.maxLength > CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints
        ? "resource_limit"
        : "unsupported_shape",
    );
  }
  return Object.freeze(output);
}

function canonicalizeMcpNumberSchema(
  value: Readonly<Record<string, unknown>>,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const field = exactAllowedRecord(value, ["type", "title", "description", "minimum", "maximum", "default"], ["type"]);
  const output: Record<string, ApplicationRunInteractionJsonValue> = { type: field.type as string };
  copyMcpSchemaText(field, output, "title", state, "short");
  copyMcpSchemaText(field, output, "description", state, "body");
  for (const key of ["minimum", "maximum", "default"] as const) {
    if (!Object.hasOwn(field, key)) continue;
    if (typeof field[key] !== "number" || !Number.isFinite(field[key])) protocolInvalid();
    output[key] = field[key];
  }
  markUnavailable(state, "unsupported_shape");
  return Object.freeze(output);
}

function canonicalizeMcpBooleanSchema(
  value: Readonly<Record<string, unknown>>,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const field = exactAllowedRecord(value, ["type", "title", "description", "default"], ["type"]);
  const output: Record<string, ApplicationRunInteractionJsonValue> = { type: "boolean" };
  copyMcpSchemaText(field, output, "title", state, "short");
  copyMcpSchemaText(field, output, "description", state, "body");
  if (Object.hasOwn(field, "default")) {
    if (typeof field.default !== "boolean") protocolInvalid();
    output.default = field.default;
  }
  markUnavailable(state, "unsupported_shape");
  return Object.freeze(output);
}

function canonicalizeMcpArraySchema(
  value: Readonly<Record<string, unknown>>,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const field = exactAllowedRecord(
    value,
    ["type", "title", "description", "minItems", "maxItems", "items", "default"],
    ["type", "items"],
  );
  const output: Record<string, ApplicationRunInteractionJsonValue> = { type: "array" };
  copyMcpSchemaText(field, output, "title", state, "short");
  copyMcpSchemaText(field, output, "description", state, "body");
  for (const key of ["minItems", "maxItems"] as const) {
    if (!Object.hasOwn(field, key)) continue;
    if (!Number.isSafeInteger(field[key]) || (field[key] as number) < 0) protocolInvalid();
    output[key] = field[key] as number;
  }
  const items = inspectRecord(field.items, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (items === undefined) protocolInvalid();
  if (Object.hasOwn(items, "enum")) {
    rejectKnownVariantFields(items, ["type", "enum"], ["type", "enum", "anyOf", "oneOf"]);
    const canonical = exactAllowedRecord(items, ["type", "enum"], ["type", "enum"]);
    if (canonical.type !== "string") protocolInvalid();
    output.items = Object.freeze({ type: "string", enum: canonicalizeMcpStringArray(canonical.enum, state) });
  } else {
    const canonical = exactAllowedRecord(items, ["anyOf", "oneOf"], []);
    if (Object.keys(canonical).length !== 1) protocolInvalid();
    const key = Object.hasOwn(canonical, "anyOf") ? "anyOf" : "oneOf";
    output.items = Object.freeze({ [key]: canonicalizeMcpConstOptions(canonical[key], state) });
  }
  if (Object.hasOwn(field, "default")) output.default = canonicalizeMcpStringArray(field.default, state);
  markUnavailable(state, "unsupported_shape");
  return Object.freeze(output);
}

function copyMcpSchemaText(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: "title" | "description",
  state: CanonicalRequestState,
  profile: "short" | "body",
): void {
  if (!Object.hasOwn(input, key)) return;
  const text = protocolString(input[key], 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  output[key] = text;
  if (canonicalizeSafeDisplayText(text, profile) === undefined) markUnavailable(state, "unsafe_projection");
}

function canonicalizeMcpStringArray(
  value: unknown,
  state: CanonicalRequestState,
): readonly ApplicationRunInteractionJsonValue[] {
  return Object.freeze(
    protocolArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, state).map((entry) =>
      protocolString(entry, 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    ),
  );
}

function canonicalizeMcpConstOptions(
  value: unknown,
  state: CanonicalRequestState,
): readonly ApplicationRunInteractionJsonValue[] {
  return Object.freeze(
    protocolArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, state).map((entry) => {
      const option = exactAllowedRecord(entry, ["const", "title"], ["const", "title"]);
      return Object.freeze({
        const: protocolString(option.const, 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        title: protocolString(option.title, 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      });
    }),
  );
}

function assertMcpVariantKeys(
  input: Readonly<Record<string, unknown>>,
  variantKeys: readonly string[],
  requiredVariantKeys: readonly string[],
): void {
  const common = ["threadId", "turnId", "serverName", "mode", "meta", "_meta"];
  if (
    Object.keys(input).some((key) => !common.includes(key) && !variantKeys.includes(key)) ||
    requiredVariantKeys.some((key) => !Object.hasOwn(input, key))
  ) {
    protocolInvalid();
  }
}

function metaRecord(
  value: ApplicationRunInteractionJsonValue | undefined,
): Readonly<Record<string, ApplicationRunInteractionJsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, ApplicationRunInteractionJsonValue>>)
    : undefined;
}

function mcpToolRequestSupported(
  mode: string,
  schema: Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }>,
  meta: Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }>,
  state: CanonicalRequestState,
): boolean {
  if (
    Object.keys(meta).some(
      (key) =>
        !["request_type", "codex_approval_kind", "tool_name", "tool_description", "tool_params", "persist"].includes(
          key,
        ),
    ) ||
    meta.codex_approval_kind !== "mcp_tool_call"
  ) {
    return false;
  }
  for (const key of ["request_type", "tool_name", "tool_description"] as const) {
    if (meta[key] !== undefined && typeof meta[key] !== "string") return false;
  }
  if (!mcpToolPersistIsProtocolValid(meta.persist)) protocolInvalid();
  const properties = schema.properties;
  const toolParams = meta.tool_params;
  const tool = meta.tool_name ?? meta.tool_description;
  if (
    mode !== "form" ||
    schema.type !== "object" ||
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties) ||
    Object.keys(properties).length !== 0 ||
    (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
    typeof tool !== "string" ||
    typeof toolParams !== "object" ||
    toolParams === null ||
    Array.isArray(toolParams) ||
    Object.keys(toolParams).length !== 0
  ) {
    return false;
  }
  if (canonicalizeSafeDisplayText(tool, meta.tool_name === undefined ? "body" : "short") === undefined) {
    markUnavailable(state, "unsafe_projection");
  }
  return true;
}

function mcpToolPersistIsProtocolValid(value: ApplicationRunInteractionJsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === "session" ||
    value === "always" ||
    (Array.isArray(value) && value.length === 2 && value[0] === "session" && value[1] === "always")
  );
}

function commonRequestParams(
  input: Readonly<Record<string, unknown>>,
): Record<string, ApplicationRunInteractionJsonValue> {
  const startedAtMs = input.startedAtMs;
  if (!Number.isSafeInteger(startedAtMs) || (startedAtMs as number) < 0) protocolInvalid();
  return {
    threadId: protocolIdentifier(input.threadId),
    turnId: protocolIdentifier(input.turnId),
    itemId: protocolIdentifier(input.itemId),
    startedAtMs: startedAtMs as number,
  };
}

function copyOptionalNullableIdentifier(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
  unsupported: boolean,
): void {
  if (!Object.hasOwn(input, key)) return;
  output[key] = input[key] === null ? null : protocolIdentifier(input[key]);
  if (unsupported && input[key] !== null) markUnavailable(state, "unsupported_shape");
}

function copyOptionalNullableText(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
  unsupported: boolean,
): void {
  if (!Object.hasOwn(input, key)) return;
  output[key] = input[key] === null ? null : protocolString(input[key], 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  if (unsupported && input[key] !== null) markUnavailable(state, "unsupported_shape");
}

function copyOptionalCommandText(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
): void {
  if (!Object.hasOwn(input, key)) return;
  if (input[key] === null) {
    output[key] = null;
    return;
  }
  const decoded = protocolString(input[key], 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  output[key] = decoded;
  if (unsafeInternalText(decoded)) markUnavailable(state, "unsafe_projection");
}

function copyOptionalJsonObject(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
  unsupported: boolean,
): void {
  if (!Object.hasOwn(input, key)) return;
  output[key] = canonicalJsonValue(input[key], 0, state);
  if (unsupported && input[key] !== null) markUnavailable(state, "unsupported_shape");
}

function copyOptionalStringArray(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
  unsupported: boolean,
): void {
  if (!Object.hasOwn(input, key)) return;
  if (input[key] === null) {
    output[key] = null;
    return;
  }
  const entries = protocolArray(input[key], CODEX_ADAPTER_LIMITS.maxArrayItems, state);
  output[key] = Object.freeze(
    entries.map((entry) => protocolString(entry, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes)),
  );
  if (entries.length > 16 || entries.some((entry) => Buffer.byteLength(entry as string, "utf8") > 1_024)) {
    markUnavailable(state, "resource_limit");
  } else if (unsupported) {
    markUnavailable(state, "unsupported_shape");
  }
}

function copyOptionalJsonArray(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
  state: CanonicalRequestState,
  unsupported: boolean,
): void {
  if (!Object.hasOwn(input, key)) return;
  if (input[key] === null) {
    output[key] = null;
    return;
  }
  const entries = protocolArray(input[key], 256, state);
  output[key] = Object.freeze(entries.map((entry) => canonicalJsonValue(entry, 1, state)));
  if (unsupported) markUnavailable(state, "unsupported_shape");
}

function copyCommandActions(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  state: CanonicalRequestState,
): void {
  if (!Object.hasOwn(input, "commandActions")) return;
  if (input.commandActions === null) {
    output.commandActions = null;
    return;
  }
  const actions = protocolArray(input.commandActions, CODEX_ADAPTER_LIMITS.maxArrayItems, state);
  const canonical = actions.map((entry) => canonicalCommandAction(entry, state));
  output.commandActions = Object.freeze(canonical);
}

function canonicalCommandAction(
  value: unknown,
  state: CanonicalRequestState,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  const probe = inspectRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (probe === undefined || typeof probe.type !== "string") protocolInvalid();
  let record: Readonly<Record<string, unknown>>;
  let output: Record<string, ApplicationRunInteractionJsonValue>;
  switch (probe.type) {
    case "read":
      rejectKnownVariantFields(
        probe,
        ["type", "command", "name", "path"],
        ["type", "command", "name", "path", "query"],
      );
      record = exactAllowedRecord(probe, ["type", "command", "name", "path"], ["type", "command", "name", "path"]);
      output = {
        type: "read",
        command: protocolString(record.command, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        name: protocolString(record.name, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        path: protocolString(record.path, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      };
      break;
    case "listFiles":
      rejectKnownVariantFields(probe, ["type", "command", "path"], ["type", "command", "name", "path", "query"]);
      record = exactAllowedRecord(probe, ["type", "command", "path"], ["type", "command"]);
      output = {
        type: "listFiles",
        command: protocolString(record.command, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      };
      copyOptionalNullableProtocolString(record, output, "path");
      break;
    case "search":
      rejectKnownVariantFields(
        probe,
        ["type", "command", "query", "path"],
        ["type", "command", "name", "path", "query"],
      );
      record = exactAllowedRecord(probe, ["type", "command", "query", "path"], ["type", "command"]);
      output = {
        type: "search",
        command: protocolString(record.command, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      };
      copyOptionalNullableProtocolString(record, output, "query");
      copyOptionalNullableProtocolString(record, output, "path");
      break;
    case "unknown":
      rejectKnownVariantFields(probe, ["type", "command"], ["type", "command", "name", "path", "query"]);
      record = exactAllowedRecord(probe, ["type", "command"], ["type", "command"]);
      output = {
        type: "unknown",
        command: protocolString(record.command, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      };
      break;
    default:
      protocolInvalid();
  }
  if (Object.values(output).some((entry) => typeof entry === "string" && unsafeInternalText(entry))) {
    markUnavailable(state, "unsafe_projection");
  }
  return Object.freeze(output);
}

function copyOptionalNullableProtocolString(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  key: string,
): void {
  if (!Object.hasOwn(input, key)) return;
  output[key] = input[key] === null ? null : protocolString(input[key], 0, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
}

function copyAvailableDecisions(
  input: Readonly<Record<string, unknown>>,
  output: Record<string, ApplicationRunInteractionJsonValue>,
  state: CanonicalRequestState,
): void {
  if (!Object.hasOwn(input, "availableDecisions") || input.availableDecisions === null) {
    output.availableDecisions = CODEX_ADAPTER_COMMAND_DECISIONS;
    return;
  }
  const entries = protocolArray(input.availableDecisions, 16, state).map((entry) =>
    canonicalizeCommandApprovalDecision(entry, state),
  );
  output.availableDecisions = Object.freeze(entries);
  const supported = entries.filter((entry): entry is string => typeof entry === "string");
  if (
    entries.length === 0 ||
    new Set(entries.map((entry) => JSON.stringify(entry))).size !== entries.length ||
    supported.length !== entries.length ||
    supported.some((entry) => entry !== "accept" && entry !== "decline" && entry !== "cancel")
  ) {
    markUnavailable(state, "unsupported_shape");
  }
}

function canonicalizeCommandApprovalDecision(
  value: unknown,
  state: CanonicalRequestState,
): ApplicationRunInteractionJsonValue {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return value;
  }
  const decision = exactAllowedRecord(value, ["acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment"], []);
  if (Object.keys(decision).length !== 1) protocolInvalid();
  if (Object.hasOwn(decision, "acceptWithExecpolicyAmendment")) {
    const payload = exactAllowedRecord(
      decision.acceptWithExecpolicyAmendment,
      ["execpolicy_amendment"],
      ["execpolicy_amendment"],
    );
    const command = protocolArray(payload.execpolicy_amendment, CODEX_ADAPTER_LIMITS.maxArrayItems, state).map(
      (entry) => protocolString(entry, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    );
    return Object.freeze({
      acceptWithExecpolicyAmendment: Object.freeze({ execpolicy_amendment: Object.freeze(command) }),
    });
  }
  const payload = exactAllowedRecord(
    decision.applyNetworkPolicyAmendment,
    ["network_policy_amendment"],
    ["network_policy_amendment"],
  );
  const amendment = exactAllowedRecord(payload.network_policy_amendment, ["host", "action"], ["host", "action"]);
  const host = protocolString(amendment.host, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  if (amendment.action !== "allow" && amendment.action !== "deny") protocolInvalid();
  return Object.freeze({
    applyNetworkPolicyAmendment: Object.freeze({
      network_policy_amendment: Object.freeze({ host, action: amendment.action }),
    }),
  });
}

function commandActionsSupportPlainDecision(
  value: ApplicationRunInteractionJsonValue | undefined,
  command: string | undefined,
): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length !== 1 || command === undefined) return false;
  const action = value[0];
  if (typeof action !== "object" || action === null || Array.isArray(action)) return false;
  const actionCommand = action.command;
  return action.type === "unknown" && typeof actionCommand === "string" && actionCommand === command;
}

function permissionSubsetSupported(
  value: ApplicationRunInteractionJsonValue,
  workspacePath: string | undefined,
): boolean {
  if (workspacePath === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const permissions = value as Readonly<Record<string, ApplicationRunInteractionJsonValue>>;
  if (Object.keys(permissions).some((key) => key !== "fileSystem" && key !== "network")) return false;
  let count = 0;
  if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
    const fileSystem = permissions.fileSystem;
    if (typeof fileSystem !== "object" || Array.isArray(fileSystem)) return false;
    const record = fileSystem as Readonly<Record<string, ApplicationRunInteractionJsonValue>>;
    if (Object.keys(record).some((key) => !["entries", "write", "read", "globScanMaxDepth"].includes(key)))
      return false;
    if (record.globScanMaxDepth !== undefined && record.globScanMaxDepth !== null) return false;
    const entries = record.entries === undefined || record.entries === null ? [] : record.entries;
    const writes = record.write === undefined || record.write === null ? [] : record.write;
    const reads = record.read === undefined || record.read === null ? [] : record.read;
    if (!Array.isArray(entries) || !Array.isArray(writes) || !Array.isArray(reads) || reads.length > 0) return false;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const entryRecord = entry as Readonly<Record<string, ApplicationRunInteractionJsonValue>>;
      if (Object.keys(entryRecord).length !== 2 || entryRecord.access !== "write") return false;
      const pathValue = entryRecord.path;
      if (typeof pathValue !== "object" || pathValue === null || Array.isArray(pathValue)) return false;
      const pathRecord = pathValue as Readonly<Record<string, ApplicationRunInteractionJsonValue>>;
      if (
        Object.keys(pathRecord).length !== 2 ||
        pathRecord.type !== "path" ||
        typeof pathRecord.path !== "string" ||
        !sameAbsolutePath(pathRecord.path, workspacePath)
      ) {
        return false;
      }
    }
    if (writes.some((entry) => typeof entry !== "string" || !sameAbsolutePath(entry, workspacePath))) return false;
    if (entries.length + writes.length === 0) return false;
    count += 1;
  }
  if (permissions.network !== undefined && permissions.network !== null) {
    const network = permissions.network;
    if (typeof network !== "object" || Array.isArray(network)) return false;
    const record = network as Readonly<Record<string, ApplicationRunInteractionJsonValue>>;
    if (Object.keys(record).length !== 1 || record.enabled !== true) return false;
    count += 1;
  }
  return count > 0;
}

function canonicalizePermissionProfile(
  value: unknown,
  state: CanonicalRequestState,
): ApplicationRunInteractionJsonValue {
  const profile = exactAllowedRecord(value, ["network", "fileSystem"], []);
  const output: Record<string, ApplicationRunInteractionJsonValue> = {};
  if (Object.hasOwn(profile, "network")) {
    output.network = profile.network === null ? null : canonicalizeAdditionalNetworkPermissions(profile.network);
  }
  if (Object.hasOwn(profile, "fileSystem")) {
    output.fileSystem =
      profile.fileSystem === null ? null : canonicalizeAdditionalFileSystemPermissions(profile.fileSystem, state);
  }
  return Object.freeze(output);
}

function canonicalizeAdditionalNetworkPermissions(value: unknown): ApplicationRunInteractionJsonValue {
  const network = exactAllowedRecord(value, ["enabled"], []);
  if (Object.hasOwn(network, "enabled") && network.enabled !== null && typeof network.enabled !== "boolean") {
    protocolInvalid();
  }
  return Object.freeze(Object.hasOwn(network, "enabled") ? { enabled: network.enabled as boolean | null } : {});
}

function canonicalizeAdditionalFileSystemPermissions(
  value: unknown,
  state: CanonicalRequestState,
): ApplicationRunInteractionJsonValue {
  const fileSystem = exactAllowedRecord(value, ["read", "write", "globScanMaxDepth", "entries"], []);
  const output: Record<string, ApplicationRunInteractionJsonValue> = {};
  for (const key of ["read", "write"] as const) {
    if (!Object.hasOwn(fileSystem, key)) continue;
    output[key] =
      fileSystem[key] === null
        ? null
        : Object.freeze(
            protocolArray(fileSystem[key], CODEX_ADAPTER_LIMITS.maxArrayItems, state).map((entry) =>
              protocolString(entry, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
            ),
          );
  }
  if (Object.hasOwn(fileSystem, "globScanMaxDepth")) {
    if (
      fileSystem.globScanMaxDepth !== null &&
      (!Number.isSafeInteger(fileSystem.globScanMaxDepth) || (fileSystem.globScanMaxDepth as number) < 1)
    ) {
      protocolInvalid();
    }
    output.globScanMaxDepth = fileSystem.globScanMaxDepth as number | null;
  }
  if (Object.hasOwn(fileSystem, "entries")) {
    output.entries =
      fileSystem.entries === null
        ? null
        : Object.freeze(
            protocolArray(fileSystem.entries, CODEX_ADAPTER_LIMITS.maxArrayItems, state).map(
              canonicalizeFileSystemSandboxEntry,
            ),
          );
  }
  return Object.freeze(output);
}

function canonicalizeFileSystemSandboxEntry(value: unknown): ApplicationRunInteractionJsonValue {
  const entry = exactAllowedRecord(value, ["path", "access"], ["path", "access"]);
  if (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny") protocolInvalid();
  return Object.freeze({ path: canonicalizeFileSystemPath(entry.path), access: entry.access });
}

function canonicalizeFileSystemPath(value: unknown): ApplicationRunInteractionJsonValue {
  const pathValue = inspectRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (pathValue === undefined || typeof pathValue.type !== "string") protocolInvalid();
  switch (pathValue.type) {
    case "path": {
      rejectKnownVariantFields(pathValue, ["type", "path"], ["type", "path", "pattern", "value"]);
      const entry = exactAllowedRecord(pathValue, ["type", "path"], ["type", "path"]);
      return Object.freeze({
        type: "path",
        path: protocolString(entry.path, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      });
    }
    case "globPattern": {
      rejectKnownVariantFields(pathValue, ["type", "pattern"], ["type", "path", "pattern", "value"]);
      const entry = exactAllowedRecord(pathValue, ["type", "pattern"], ["type", "pattern"]);
      return Object.freeze({
        type: "globPattern",
        pattern: protocolString(entry.pattern, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      });
    }
    case "special": {
      rejectKnownVariantFields(pathValue, ["type", "value"], ["type", "path", "pattern", "value"]);
      const entry = exactAllowedRecord(pathValue, ["type", "value"], ["type", "value"]);
      return Object.freeze({ type: "special", value: canonicalizeFileSystemSpecialPath(entry.value) });
    }
    default:
      return protocolInvalid();
  }
}

function canonicalizeFileSystemSpecialPath(value: unknown): ApplicationRunInteractionJsonValue {
  const special = inspectRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (special === undefined || typeof special.kind !== "string") protocolInvalid();
  if (
    special.kind === "root" ||
    special.kind === "minimal" ||
    special.kind === "tmpdir" ||
    special.kind === "slash_tmp"
  ) {
    rejectKnownVariantFields(special, ["kind"], ["kind", "path", "subpath"]);
    const entry = exactAllowedRecord(special, ["kind"], ["kind"]);
    return Object.freeze({ kind: entry.kind as string });
  }
  if (special.kind === "project_roots") {
    rejectKnownVariantFields(special, ["kind", "subpath"], ["kind", "path", "subpath"]);
    const entry = exactAllowedRecord(special, ["kind", "subpath"], ["kind"]);
    return Object.freeze({
      kind: "project_roots",
      ...(Object.hasOwn(entry, "subpath")
        ? {
            subpath:
              entry.subpath === null
                ? null
                : protocolString(entry.subpath, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
          }
        : {}),
    });
  }
  if (special.kind === "unknown") {
    const entry = exactAllowedRecord(special, ["kind", "path", "subpath"], ["kind", "path"]);
    return Object.freeze({
      kind: "unknown",
      path: protocolString(entry.path, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
      ...(Object.hasOwn(entry, "subpath")
        ? {
            subpath:
              entry.subpath === null
                ? null
                : protocolString(entry.subpath, 1, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
          }
        : {}),
    });
  }
  return protocolInvalid();
}

function canonicalizeUnavailableDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["summary", "unavailableReason"])) invalidSnapshot();
  const summary = canonicalizeSafeDisplayText(display.summary, "short");
  if (summary === undefined || !isUnavailableReason(display.unavailableReason)) invalidSnapshot();
  return Object.freeze({ summary, unavailableReason: display.unavailableReason });
}

function canonicalizeAnswerableDisplay(
  kind: CodexAdapterInteractionKind,
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  switch (kind) {
    case "codex.command_approval":
      return canonicalCommandDisplay(display);
    case "codex.file_change_approval":
      return canonicalFileChangeDisplay(display);
    case "codex.permission_approval":
      return canonicalPermissionDisplay(display);
    case "codex.user_input":
      return canonicalQuestionsDisplay(display);
    case "codex.mcp_tool_approval":
      return canonicalMcpToolDisplay(display);
    case "codex.mcp_server_form":
      return canonicalMcpFormDisplay(display);
  }
}

function canonicalCommandDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["summary", "command", "availableDecisions"])) invalidSnapshot();
  const summary = canonicalizeSafeDisplayText(display.summary, "short");
  const command = canonicalizeCodexCommandDisplay(display.command);
  const availableDecisions = canonicalCommandDecisionList(display.availableDecisions);
  if (summary === undefined || command === undefined || availableDecisions === undefined) invalidSnapshot();
  return Object.freeze({ summary, command, availableDecisions });
}

function canonicalCommandDecisionList(value: unknown): readonly CodexAdapterCommandDecision[] | undefined {
  const entries = denseArray(value, CODEX_ADAPTER_COMMAND_DECISIONS.length);
  if (entries === undefined || entries.length === 0) return undefined;
  const unique = new Set<CodexAdapterCommandDecision>();
  const output: CodexAdapterCommandDecision[] = [];
  for (const entry of entries) {
    if (!isCodexAdapterCommandDecision(entry) || unique.has(entry)) return undefined;
    unique.add(entry);
    output.push(entry);
  }
  return Object.freeze(output);
}

function canonicalTextDisplay(
  display: Readonly<Record<string, unknown>>,
  bodyKey: string,
  profile: SafeDisplayTextProfile,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["summary", bodyKey])) invalidSnapshot();
  const summary = canonicalizeSafeDisplayText(display.summary, "short");
  const body = canonicalizeSafeDisplayText(display[bodyKey], profile);
  if (summary === undefined || body === undefined) invalidSnapshot();
  return Object.freeze({ summary, [bodyKey]: body });
}

function canonicalFileChangeDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["summary", "changes"])) invalidSnapshot();
  const summary = canonicalizeSafeDisplayText(display.summary, "short");
  const changes = denseArray(display.changes, CODEX_ADAPTER_LIMITS.maxInteractionFileChanges);
  if (summary === undefined || changes === undefined || changes.length === 0) invalidSnapshot();
  const canonical = changes.map((entry) => {
    const change = exactRecord(entry, ["displayPath", "changeKind"]);
    const displayPath = canonicalizeWorkspaceRelativePath(change.displayPath);
    if (
      displayPath === undefined ||
      (change.changeKind !== "add" &&
        change.changeKind !== "update" &&
        change.changeKind !== "delete" &&
        change.changeKind !== "move")
    ) {
      invalidSnapshot();
    }
    return Object.freeze({ displayPath, changeKind: change.changeKind });
  });
  return Object.freeze({ summary, changes: Object.freeze(canonical) });
}

function canonicalPermissionDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["summary", "permissions"])) invalidSnapshot();
  const summary = canonicalizeSafeDisplayText(display.summary, "short");
  const permissions = denseArray(display.permissions, 8);
  if (summary === undefined || permissions === undefined || permissions.length === 0) invalidSnapshot();
  const unique = new Set<string>();
  for (const permission of permissions) {
    if ((permission !== "workspace_write" && permission !== "network") || unique.has(permission)) invalidSnapshot();
    unique.add(permission);
  }
  return Object.freeze({ summary, permissions: Object.freeze([...unique]) });
}

function canonicalQuestionsDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["questions"])) invalidSnapshot();
  const questions = denseArray(display.questions, CODEX_ADAPTER_LIMITS.maxInteractionQuestions);
  if (questions === undefined || questions.length === 0) invalidSnapshot();
  const ids = new Set<string>();
  const canonical = questions.map((entry) => {
    const question = exactRecord(entry, ["questionId", "header", "prompt", "allowOther", "options"]);
    const questionId = publicIdentifier(question.questionId);
    const header = canonicalizeSafeDisplayText(question.header, "short");
    const prompt = canonicalizeSafeDisplayText(question.prompt, "body");
    const options = denseArray(question.options, CODEX_ADAPTER_LIMITS.maxInteractionOptionsPerQuestion);
    if (
      questionId === undefined ||
      ids.has(questionId) ||
      header === undefined ||
      prompt === undefined ||
      typeof question.allowOther !== "boolean" ||
      options === undefined ||
      options.length < 2
    ) {
      invalidSnapshot();
    }
    ids.add(questionId);
    const labels = new Set<string>();
    const canonicalOptions = options.map((optionValue) => {
      const option = optionalExactRecord(optionValue, ["label", "description"], ["label"]);
      const label = canonicalizeSafeDisplayText(option.label, "short");
      const description = Object.hasOwn(option, "description")
        ? canonicalizeSafeDisplayText(option.description, "short")
        : undefined;
      if (
        label === undefined ||
        labels.has(label) ||
        (Object.hasOwn(option, "description") && description === undefined)
      ) {
        invalidSnapshot();
      }
      labels.add(label);
      return Object.freeze({ label, ...(description === undefined ? {} : { description }) });
    });
    return Object.freeze({
      questionId,
      header,
      prompt,
      allowOther: question.allowOther,
      options: Object.freeze(canonicalOptions),
    });
  });
  return Object.freeze({ questions: Object.freeze(canonical) });
}

function canonicalMcpToolDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["server", "tool", "summary"])) invalidSnapshot();
  const server = canonicalizeSafeDisplayText(display.server, "short");
  const tool = canonicalizeSafeDisplayText(display.tool, "short");
  const summary = canonicalizeSafeDisplayText(display.summary, "body");
  if (server === undefined || tool === undefined || summary === undefined) invalidSnapshot();
  return Object.freeze({ server, tool, summary });
}

function canonicalMcpFormDisplay(
  display: Readonly<Record<string, unknown>>,
): Readonly<{ [key: string]: ApplicationRunInteractionJsonValue }> {
  if (!hasExactKeys(display, ["server", "message", "fields"])) invalidSnapshot();
  const server = canonicalizeSafeDisplayText(display.server, "short");
  const message = canonicalizeSafeDisplayText(display.message, "body");
  const fields = denseArray(display.fields, CODEX_ADAPTER_LIMITS.maxInteractionFormFields);
  if (server === undefined || message === undefined || fields === undefined || fields.length === 0) invalidSnapshot();
  const ids = new Set<string>();
  const canonical = fields.map((entry) => {
    const field = exactRecord(entry, ["fieldId", "label", "inputType", "required", "maxLength"]);
    const fieldId = publicIdentifier(field.fieldId);
    const label = canonicalizeSafeDisplayText(field.label, "short");
    if (
      fieldId === undefined ||
      ids.has(fieldId) ||
      label === undefined ||
      field.inputType !== "string" ||
      typeof field.required !== "boolean" ||
      !Number.isSafeInteger(field.maxLength) ||
      (field.maxLength as number) < 1 ||
      (field.maxLength as number) > CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints
    ) {
      invalidSnapshot();
    }
    ids.add(fieldId);
    return Object.freeze({
      fieldId,
      label,
      inputType: "string",
      required: field.required,
      maxLength: field.maxLength as number,
    });
  });
  return Object.freeze({ server, message, fields: Object.freeze(canonical) });
}

function requestResult(
  method: CodexCanonicalInteractionRequest["method"],
  interactionKind: CodexCanonicalInteractionRequest["interactionKind"],
  params: Record<string, ApplicationRunInteractionJsonValue>,
  state: CanonicalRequestState,
): CodexInteractionRequestCanonicalization {
  const request = Object.freeze({ method, interactionKind, params: Object.freeze(params) });
  return state.unavailableReason === undefined
    ? Object.freeze({ kind: "canonical", request })
    : Object.freeze({ kind: "unavailable", reason: state.unavailableReason, request });
}

function markUnavailable(
  state: CanonicalRequestState,
  reason: Extract<CodexInteractionRequestCanonicalization, { kind: "unavailable" }>["reason"],
): void {
  if (state.unavailableReason === "resource_limit") return;
  if (state.unavailableReason === "unsafe_projection" && reason === "unsupported_shape") return;
  state.unavailableReason = reason;
}

function protocolIdentifier(value: unknown): string {
  return protocolString(value, 1, CODEX_ADAPTER_LIMITS.maxIdentifierBytes);
}

function protocolString(value: unknown, minimumCodePoints: number, maximumBytes: number): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) protocolInvalid();
  const points = [...value].length;
  if (points < minimumCodePoints || Buffer.byteLength(value, "utf8") > maximumBytes) protocolInvalid();
  return value;
}

function publicIdentifier(value: unknown): string | undefined {
  const decoded = boundedUnicodeString(
    value,
    1,
    CODEX_ADAPTER_LIMITS.maxInteractionIdCharacters,
    CODEX_ADAPTER_LIMITS.maxInteractionIdCharacters * 4,
  );
  return decoded !== undefined && IDENTIFIER.test(decoded) ? decoded : undefined;
}

function boundedUnicodeString(
  value: unknown,
  minimumCodePoints: number,
  maximumCodePoints: number,
  maximumBytes: number,
): string | undefined {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return undefined;
  const points = [...value].length;
  return points >= minimumCodePoints && points <= maximumCodePoints && Buffer.byteLength(value, "utf8") <= maximumBytes
    ? value
    : undefined;
}

function unsafeInternalText(value: string): boolean {
  return hasUnpairedSurrogate(value) || CONTROL_BIDI_OR_NONCHARACTER.test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function sameAbsolutePath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function canonicalJsonValue(
  value: unknown,
  depth: number,
  state: CanonicalRequestState,
): ApplicationRunInteractionJsonValue {
  if (depth > CODEX_ADAPTER_LIMITS.maxObjectDepth) protocolInvalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (
      typeof value === "string" &&
      (hasUnpairedSurrogate(value) || Buffer.byteLength(value, "utf8") > CODEX_ADAPTER_LIMITS.maxShortStringBytes)
    ) {
      protocolInvalid();
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) protocolInvalid();
    return value;
  }
  if (Array.isArray(value)) {
    const entries = protocolArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, state);
    return Object.freeze(entries.map((entry) => canonicalJsonValue(entry, depth + 1, state)));
  }
  const record = protocolRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties, state);
  const output: Record<string, ApplicationRunInteractionJsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    output[key] = canonicalJsonValue(record[key], depth + 1, state);
  }
  return Object.freeze(output);
}

function exactAllowedRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value, CODEX_ADAPTER_LIMITS.maxObjectProperties);
  if (record === undefined || required.some((key) => !Object.hasOwn(record, key))) protocolInvalid();
  const projected = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    if (Object.hasOwn(record, key)) projected[key] = record[key];
  }
  return Object.freeze(projected);
}

function rejectKnownVariantFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  knownUnionFields: readonly string[],
): void {
  if (knownUnionFields.some((key) => !allowed.includes(key) && Object.hasOwn(record, key))) protocolInvalid();
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value, keys.length);
  if (record === undefined || !hasExactKeys(record, keys)) invalidSnapshot();
  return record;
}

function optionalExactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value, allowed.length);
  if (
    record === undefined ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    invalidSnapshot();
  }
  return record;
}

function inspectRecord(value: unknown, maximumKeys: number): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value as unknown;
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function protocolRecord(
  value: unknown,
  maximumKeys: number,
  state: CanonicalRequestState,
): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value, maximumKeys);
  if (record !== undefined) return record;
  if (recordKeyCountExceeds(value, maximumKeys)) {
    markUnavailable(state, "resource_limit");
    return Object.freeze(Object.create(null) as Record<string, unknown>);
  }
  return protocolInvalid();
}

function recordKeyCountExceeds(value: unknown, maximumKeys: number): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length > maximumKeys && keys.every((key) => typeof key === "string");
  } catch {
    return false;
  }
}

function protocolArray(value: unknown, maximumItems: number, state?: CanonicalRequestState): readonly unknown[] {
  if (state !== undefined && arrayLengthExceeds(value, maximumItems)) {
    markUnavailable(state, "resource_limit");
    return Object.freeze([]);
  }
  const output = denseArray(value, maximumItems);
  if (output === undefined) protocolInvalid();
  return output;
}

function arrayLengthExceeds(value: unknown, maximumItems: number): boolean {
  try {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length > maximumItems;
  } catch {
    return false;
  }
}

function denseArray(value: unknown, maximumItems: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumItems) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))) {
      return undefined;
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isCodexInteractionKind(value: unknown): value is CodexAdapterInteractionKind {
  return typeof value === "string" && (CODEX_INTERACTION_KINDS as readonly string[]).includes(value);
}

function isUnavailableReason(
  value: unknown,
): value is
  | "unsafe_projection"
  | "unsupported_shape"
  | "secret_input"
  | "resource_limit"
  | "owner_unresolved"
  | "response_admitted" {
  return (
    value === "unsafe_projection" ||
    value === "unsupported_shape" ||
    value === "secret_input" ||
    value === "resource_limit" ||
    value === "owner_unresolved" ||
    value === "response_admitted"
  );
}

class ProtocolInvalid extends Error {}

function protocolInvalid(): never {
  throw new ProtocolInvalid();
}

function invalidSnapshot(): never {
  throw new TypeError("Codex interaction snapshot is invalid.");
}
