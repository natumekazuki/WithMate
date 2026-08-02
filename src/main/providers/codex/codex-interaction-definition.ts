import type { ApplicationRunInteraction } from "../../../shared/application-run-model.js";
import type {
  ProviderCanonicalInteractionResponse,
  ProviderInteractionSemanticAction,
} from "../provider-definition.js";
import {
  CODEX_ADAPTER_COMMAND_DECISIONS,
  CODEX_ADAPTER_LIMITS,
  CODEX_ADAPTER_PERMISSION_CATEGORIES,
  type CodexAdapterCommandDecision,
  type CodexAdapterInteractionKind,
  type CodexAdapterPermissionCategory,
  type CodexAdapterInteractionResponse,
  isCodexAdapterCommandDecision,
} from "./codex-adapter-contract.js";
import {
  CODEX_INTERACTION_KINDS,
  canonicalizeCodexInteractionSnapshot,
  canonicalizeWorkspaceRelativePath,
} from "./codex-interaction-codec.js";
import { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";

export { CODEX_INTERACTION_KINDS } from "./codex-interaction-codec.js";
export { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";

type UserInputQuestion = Readonly<{
  questionId: string;
  allowOther: boolean;
  options: readonly Readonly<{ label: string }>[];
}>;

type McpFormField = Readonly<{
  fieldId: string;
  required: boolean;
  maxLength: number;
}>;

type SnapshotContext =
  | Readonly<{
      interactionId: string;
      kind: Exclude<
        CodexAdapterInteractionKind,
        "codex.command_approval" | "codex.permission_approval" | "codex.user_input" | "codex.mcp_server_form"
      >;
    }>
  | Readonly<{
      interactionId: string;
      kind: "codex.command_approval";
      availableDecisions: readonly CodexAdapterCommandDecision[];
    }>
  | Readonly<{
      interactionId: string;
      kind: "codex.permission_approval";
      permissions: readonly CodexAdapterPermissionCategory[];
    }>
  | Readonly<{ interactionId: string; kind: "codex.user_input"; questions: readonly UserInputQuestion[] }>
  | Readonly<{ interactionId: string; kind: "codex.mcp_server_form"; fields: readonly McpFormField[] }>;

export type CodexCanonicalInteractionResponse = ProviderCanonicalInteractionResponse &
  Readonly<{ response: CodexAdapterInteractionResponse }>;

export function canonicalizeCodexInteractionResponse(
  snapshot: ApplicationRunInteraction,
  value: unknown,
): CodexCanonicalInteractionResponse {
  const canonical = canonicalizeCodexInteractionResponseShape(value);
  const context = snapshotContext(snapshot);
  const response = canonical.response;
  if (response.interactionId !== context.interactionId || response.kind !== context.kind) invalidResponse();

  switch (context.kind) {
    case "codex.command_approval":
      if (response.kind !== context.kind || !context.availableDecisions.includes(response.payload.decision)) {
        invalidResponse();
      }
      return canonical;
    case "codex.file_change_approval":
    case "codex.mcp_tool_approval":
      return canonical;
    case "codex.permission_approval":
      if (
        response.kind !== context.kind ||
        response.payload.permissions.some((permission) => !context.permissions.includes(permission))
      ) {
        invalidResponse();
      }
      return canonical;
    case "codex.user_input": {
      if (response.kind !== context.kind) invalidResponse();
      const answers = response.payload.answers;
      if (Object.keys(answers).length !== context.questions.length) invalidResponse();
      for (const question of context.questions) {
        if (!Object.hasOwn(answers, question.questionId)) invalidResponse();
        const answer = answers[question.questionId]?.[0];
        if (
          answer === undefined ||
          (!question.allowOther && !question.options.some((option) => option.label === answer))
        ) {
          invalidResponse();
        }
      }
      return canonical;
    }
    case "codex.mcp_server_form": {
      if (response.kind !== context.kind || response.payload.action !== "accept") return canonical;
      const values = response.payload.values;
      const fields = new Map(context.fields.map((field) => [field.fieldId, field]));
      if (Object.keys(values).some((key) => !fields.has(key))) invalidResponse();
      for (const field of context.fields) {
        if (field.required && !Object.hasOwn(values, field.fieldId)) invalidResponse();
      }
      for (const [key, value] of Object.entries(values)) {
        const field = fields.get(key);
        if (field === undefined || codePointString(value, 0, field.maxLength) === undefined) invalidResponse();
      }
      return canonical;
    }
  }
}

export function canonicalizeCodexInteractionResponseShape(value: unknown): CodexCanonicalInteractionResponse {
  const response = responseRecord(value);
  if (!isCodexInteractionKind(response.kind)) invalidResponse();
  switch (response.kind) {
    case "codex.command_approval":
    case "codex.file_change_approval":
    case "codex.mcp_tool_approval": {
      const payload = exactRecord(response.payload, ["decision"]);
      const decision = decisionValue(payload.decision);
      return canonicalResult(
        Object.freeze({
          interactionId: response.interactionId,
          kind: response.kind,
          payload: Object.freeze({ decision }),
        }),
        decision,
      );
    }
    case "codex.permission_approval": {
      const payload = exactRecord(response.payload, ["permissions", "scope"]);
      if (payload.scope !== "turn") invalidResponse();
      const permissions = canonicalPermissionCategories(payload.permissions, true);
      return canonicalResult(
        Object.freeze({
          interactionId: response.interactionId,
          kind: response.kind,
          payload: Object.freeze({ permissions, scope: "turn" }),
        }),
        permissions.length === 0 ? "decline" : "accept",
      );
    }
    case "codex.user_input": {
      const payload = exactRecord(response.payload, ["answers"]);
      const answers = inspectRecord(payload.answers, CODEX_ADAPTER_LIMITS.maxInteractionQuestions);
      if (answers === undefined || Object.keys(answers).length === 0) invalidResponse();
      const canonicalAnswers: [string, readonly [string]][] = [];
      for (const [questionIdRaw, answerValue] of Object.entries(answers).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )) {
        const questionId = identifier(questionIdRaw);
        const entries = denseArray(answerValue, 1);
        const answer = entries?.length === 1 ? codePointString(entries[0], 1, 2_048) : undefined;
        if (questionId === undefined || answer === undefined) invalidResponse();
        canonicalAnswers.push([questionId, Object.freeze([answer])]);
      }
      return canonicalResult(
        Object.freeze({
          interactionId: response.interactionId,
          kind: response.kind,
          payload: Object.freeze({ answers: Object.freeze(Object.fromEntries(canonicalAnswers)) }),
        }),
        "answer",
      );
    }
    case "codex.mcp_server_form": {
      const payload = inspectRecord(response.payload, CODEX_ADAPTER_LIMITS.maxInteractionFormFields + 1);
      if (payload === undefined) invalidResponse();
      if (payload.action === "decline" || payload.action === "cancel") {
        if (!hasExactKeys(payload, ["action"])) invalidResponse();
        return canonicalResult(
          Object.freeze({
            interactionId: response.interactionId,
            kind: response.kind,
            payload: Object.freeze({ action: payload.action }),
          }),
          payload.action,
        );
      }
      if (payload.action !== "accept" || !hasExactKeys(payload, ["action", "values"])) invalidResponse();
      const values = inspectRecord(payload.values, CODEX_ADAPTER_LIMITS.maxInteractionFormFields);
      if (values === undefined) invalidResponse();
      const canonicalValues: [string, string][] = [];
      for (const [fieldIdRaw, value] of Object.entries(values).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )) {
        const fieldId = identifier(fieldIdRaw);
        const decoded = codePointString(value, 0, CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints);
        if (fieldId === undefined || decoded === undefined) invalidResponse();
        canonicalValues.push([fieldId, decoded]);
      }
      return canonicalResult(
        Object.freeze({
          interactionId: response.interactionId,
          kind: response.kind,
          payload: Object.freeze({ action: "accept", values: Object.freeze(Object.fromEntries(canonicalValues)) }),
        }),
        "submit",
      );
    }
  }
}

export function encodeCanonicalCodexInteractionResponse(
  response: CodexAdapterInteractionResponse,
  capturedPermissionWire?: unknown,
): unknown {
  switch (response.kind) {
    case "codex.command_approval":
    case "codex.file_change_approval":
      return Object.freeze({ decision: response.payload.decision });
    case "codex.permission_approval":
      return Object.freeze({
        permissions: selectPermissionWireProfile(response.payload.permissions, capturedPermissionWire),
        scope: "turn",
        strictAutoReview: null,
      });
    case "codex.user_input":
      return Object.freeze({
        answers: Object.freeze(
          Object.fromEntries(
            Object.entries(response.payload.answers).map(([questionId, answers]) => [
              questionId,
              Object.freeze({ answers }),
            ]),
          ),
        ),
      });
    case "codex.mcp_tool_approval":
      return Object.freeze({
        action: response.payload.decision,
        content: response.payload.decision === "accept" ? Object.freeze({}) : null,
      });
    case "codex.mcp_server_form":
      return response.payload.action === "accept"
        ? Object.freeze({ action: "accept", content: response.payload.values })
        : Object.freeze({ action: response.payload.action, content: null });
  }
}

function snapshotContext(value: unknown): SnapshotContext {
  const snapshot = exactRecord(canonicalizeCodexInteractionSnapshot(value), [
    "interactionId",
    "providerId",
    "definitionVersion",
    "kind",
    "answerable",
    "display",
  ]);
  const interactionId = identifier(snapshot.interactionId);
  if (
    interactionId === undefined ||
    snapshot.providerId !== CODEX_PROVIDER_ID ||
    snapshot.definitionVersion !== CODEX_PROVIDER_DEFINITION_VERSION ||
    !isCodexInteractionKind(snapshot.kind) ||
    snapshot.answerable !== true
  ) {
    invalidResponse();
  }
  const display = inspectRecord(snapshot.display, CODEX_ADAPTER_LIMITS.maxInteractionFormFields + 2);
  if (display === undefined) invalidResponse();

  switch (snapshot.kind) {
    case "codex.command_approval":
      return Object.freeze({
        interactionId,
        kind: snapshot.kind,
        availableDecisions: validateCommandDisplay(display),
      });
    case "codex.file_change_approval":
      validateFileChangeDisplay(display);
      return Object.freeze({ interactionId, kind: snapshot.kind });
    case "codex.permission_approval":
      return Object.freeze({
        interactionId,
        kind: snapshot.kind,
        permissions: validatePermissionDisplay(display),
      });
    case "codex.user_input":
      return Object.freeze({ interactionId, kind: snapshot.kind, questions: validateQuestionsDisplay(display) });
    case "codex.mcp_tool_approval":
      validateMcpToolDisplay(display);
      return Object.freeze({ interactionId, kind: snapshot.kind });
    case "codex.mcp_server_form":
      return Object.freeze({ interactionId, kind: snapshot.kind, fields: validateMcpFormDisplay(display) });
  }
}

function validateCommandDisplay(display: Readonly<Record<string, unknown>>): readonly CodexAdapterCommandDecision[] {
  validateTextDisplay(display, ["summary", "command", "availableDecisions"], "command");
  const decisions = denseArray(display.availableDecisions, CODEX_ADAPTER_COMMAND_DECISIONS.length);
  if (decisions === undefined || decisions.length === 0) invalidResponse();
  const unique = new Set<CodexAdapterCommandDecision>();
  const output: CodexAdapterCommandDecision[] = [];
  for (const decision of decisions) {
    if (!isCodexAdapterCommandDecision(decision) || unique.has(decision)) {
      invalidResponse();
    }
    unique.add(decision);
    output.push(decision);
  }
  return Object.freeze(output);
}

function validateTextDisplay(
  display: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  bodyKey: string,
): void {
  if (
    !hasExactKeys(display, keys) ||
    codePointString(display.summary, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
    codePointString(display[bodyKey], 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints) === undefined
  ) {
    invalidResponse();
  }
}

function validateFileChangeDisplay(display: Readonly<Record<string, unknown>>): void {
  if (
    !hasExactKeys(display, ["summary", "changes"]) ||
    codePointString(display.summary, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined
  ) {
    invalidResponse();
  }
  const changes = denseArray(display.changes, CODEX_ADAPTER_LIMITS.maxInteractionFileChanges);
  if (changes === undefined || changes.length === 0) invalidResponse();
  for (const changeValue of changes) {
    const change = exactRecord(changeValue, ["displayPath", "changeKind"]);
    if (
      !isSafeWorkspaceRelativePath(change.displayPath) ||
      (change.changeKind !== "add" &&
        change.changeKind !== "update" &&
        change.changeKind !== "delete" &&
        change.changeKind !== "move")
    ) {
      invalidResponse();
    }
  }
}

function validatePermissionDisplay(
  display: Readonly<Record<string, unknown>>,
): readonly CodexAdapterPermissionCategory[] {
  if (
    !hasExactKeys(display, ["summary", "permissions"]) ||
    codePointString(display.summary, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined
  ) {
    invalidResponse();
  }
  return canonicalPermissionCategories(display.permissions, false);
}

function canonicalPermissionCategories(value: unknown, allowEmpty: boolean): readonly CodexAdapterPermissionCategory[] {
  const permissions = denseArray(value, CODEX_ADAPTER_PERMISSION_CATEGORIES.length);
  if (permissions === undefined || (!allowEmpty && permissions.length === 0)) invalidResponse();
  const selected = new Set<CodexAdapterPermissionCategory>();
  for (const permission of permissions) {
    if (
      !(CODEX_ADAPTER_PERMISSION_CATEGORIES as readonly unknown[]).includes(permission) ||
      selected.has(permission as CodexAdapterPermissionCategory)
    ) {
      invalidResponse();
    }
    selected.add(permission as CodexAdapterPermissionCategory);
  }
  return Object.freeze(CODEX_ADAPTER_PERMISSION_CATEGORIES.filter((permission) => selected.has(permission)));
}

function selectPermissionWireProfile(
  selectedPermissions: readonly CodexAdapterPermissionCategory[],
  capturedPermissionWire: unknown,
): Readonly<Record<string, unknown>> {
  if (selectedPermissions.length === 0) return Object.freeze({});
  const captured = inspectRecord(capturedPermissionWire, CODEX_ADAPTER_PERMISSION_CATEGORIES.length);
  if (captured === undefined) invalidResponse();
  const output: Record<string, unknown> = {};
  for (const permission of selectedPermissions) {
    const field = permission === "workspace_write" ? "fileSystem" : "network";
    if (!Object.hasOwn(captured, field) || captured[field] === null || captured[field] === undefined) {
      invalidResponse();
    }
    output[field] = captured[field];
  }
  return Object.freeze(output);
}

function validateQuestionsDisplay(display: Readonly<Record<string, unknown>>): readonly UserInputQuestion[] {
  if (!hasExactKeys(display, ["questions"])) invalidResponse();
  const questions = denseArray(display.questions, CODEX_ADAPTER_LIMITS.maxInteractionQuestions);
  if (questions === undefined || questions.length === 0) invalidResponse();
  const ids = new Set<string>();
  const output: UserInputQuestion[] = [];
  for (const questionValue of questions) {
    const question = exactRecord(questionValue, ["questionId", "header", "prompt", "allowOther", "options"]);
    const questionId = identifier(question.questionId);
    const options = denseArray(question.options, CODEX_ADAPTER_LIMITS.maxInteractionOptionsPerQuestion);
    if (
      questionId === undefined ||
      ids.has(questionId) ||
      codePointString(question.header, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
      codePointString(question.prompt, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints) === undefined ||
      typeof question.allowOther !== "boolean" ||
      options === undefined ||
      options.length < 2
    ) {
      invalidResponse();
    }
    ids.add(questionId);
    const labels = new Set<string>();
    const canonicalOptions: Readonly<{ label: string }>[] = [];
    for (const optionValue of options) {
      const option = inspectRecord(optionValue, 2);
      if (option === undefined || !hasOnlyKeys(option, ["label", "description"]) || !Object.hasOwn(option, "label"))
        invalidResponse();
      const label = codePointString(option.label, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
      if (
        label === undefined ||
        labels.has(label) ||
        (Object.hasOwn(option, "description") &&
          codePointString(option.description, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined)
      ) {
        invalidResponse();
      }
      labels.add(label);
      canonicalOptions.push(Object.freeze({ label }));
    }
    output.push(
      Object.freeze({
        questionId,
        allowOther: question.allowOther,
        options: Object.freeze(canonicalOptions),
      }),
    );
  }
  return Object.freeze(output);
}

function validateMcpToolDisplay(display: Readonly<Record<string, unknown>>): void {
  if (!hasExactKeys(display, ["server", "tool", "summary"])) invalidResponse();
  if (
    codePointString(display.server, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
    codePointString(display.tool, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
    codePointString(display.summary, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints) === undefined
  ) {
    invalidResponse();
  }
}

function validateMcpFormDisplay(display: Readonly<Record<string, unknown>>): readonly McpFormField[] {
  if (!hasExactKeys(display, ["server", "message", "fields"])) invalidResponse();
  if (
    codePointString(display.server, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
    codePointString(display.message, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints) === undefined
  ) {
    invalidResponse();
  }
  const fields = denseArray(display.fields, CODEX_ADAPTER_LIMITS.maxInteractionFormFields);
  if (fields === undefined || fields.length === 0) invalidResponse();
  const ids = new Set<string>();
  const output: McpFormField[] = [];
  for (const fieldValue of fields) {
    const field = exactRecord(fieldValue, ["fieldId", "label", "inputType", "required", "maxLength"]);
    const fieldId = identifier(field.fieldId);
    if (
      fieldId === undefined ||
      ids.has(fieldId) ||
      codePointString(field.label, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints) === undefined ||
      field.inputType !== "string" ||
      typeof field.required !== "boolean" ||
      !Number.isSafeInteger(field.maxLength) ||
      (field.maxLength as number) < 1 ||
      (field.maxLength as number) > CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints
    ) {
      invalidResponse();
    }
    ids.add(fieldId);
    output.push(Object.freeze({ fieldId, required: field.required, maxLength: field.maxLength as number }));
  }
  return Object.freeze(output);
}

function responseRecord(value: unknown): Readonly<{
  interactionId: string;
  kind: string;
  payload: unknown;
}> {
  const record = exactRecord(value, ["interactionId", "kind", "payload"]);
  const interactionId = identifier(record.interactionId);
  if (interactionId === undefined || typeof record.kind !== "string") invalidResponse();
  return Object.freeze({ interactionId, kind: record.kind, payload: record.payload });
}

function canonicalResult(
  response: CodexAdapterInteractionResponse,
  semanticAction: ProviderInteractionSemanticAction,
): CodexCanonicalInteractionResponse {
  return Object.freeze({ response, semanticAction });
}

function decisionValue(value: unknown): "accept" | "decline" | "cancel" {
  if (!isCodexAdapterCommandDecision(value)) invalidResponse();
  return value;
}

function isCodexInteractionKind(value: unknown): value is CodexAdapterInteractionKind {
  return typeof value === "string" && (CODEX_INTERACTION_KINDS as readonly string[]).includes(value);
}

function identifier(value: unknown): string | undefined {
  const decoded = codePointString(value, 1, CODEX_ADAPTER_LIMITS.maxInteractionIdCharacters);
  return decoded !== undefined && /^[A-Za-z0-9_.:-]+$/u.test(decoded) ? decoded : undefined;
}

function isSafeWorkspaceRelativePath(value: unknown): boolean {
  return canonicalizeWorkspaceRelativePath(value) !== undefined;
}

function codePointString(value: unknown, minimum: number, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const length = [...value].length;
  return length >= minimum && length <= maximum ? value : undefined;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value, keys.length);
  if (record === undefined || !hasExactKeys(record, keys)) invalidResponse();
  return record;
}

function inspectRecord(value: unknown, maximumKeys: number): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function denseArray(value: unknown, maximumItems: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumItems)
      return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))))
      return undefined;
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

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[]): boolean {
  return Object.keys(record).length === required.length && required.every((key) => Object.hasOwn(record, key));
}

function invalidResponse(): never {
  throw new TypeError("Codex interaction response is invalid for the current snapshot.");
}
