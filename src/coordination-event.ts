import type { SessionRoleBinding } from "./session-role-binding.js";

export const COORDINATION_EVENT_KINDS = [
  "progress",
  "decision",
  "escalation",
  "user_decision_required",
  "blocker",
  "result",
  "correction",
] as const;

export const COORDINATION_EVENT_STATES = [
  "recorded",
  "open",
  "resolved",
  "superseded",
  "cancelled",
] as const;

export const COORDINATION_EVENT_OPEN_KINDS = [
  "escalation",
  "user_decision_required",
  "blocker",
] as const;

export const COORDINATION_EVENT_DEFAULT_LIST_LIMIT = 50;
export const COORDINATION_EVENT_MAX_LIST_LIMIT = 100;
export const COORDINATION_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024;

export type CoordinationEventKind = (typeof COORDINATION_EVENT_KINDS)[number];
export type CoordinationEventState = (typeof COORDINATION_EVENT_STATES)[number];
export type CoordinationEventScope = "self" | "subtree";

export type CoordinationEventOption = {
  id: string;
  label: string;
  description?: string;
};

export type CoordinationEventPayload = {
  summary: string;
  facts?: string[];
  assumptions?: string[];
  impact?: string;
  recommendation?: string;
};

export type CoordinationEventRoleSnapshot = SessionRoleBinding;

export type CoordinationEventAction = {
  sequence: number;
  type: "resolved" | "cancelled" | "superseded";
  actorType: "session" | "trusted_gui";
  actorSessionId: string | null;
  optionId: string | null;
  note: string | null;
  relatedEventId: string | null;
  createdAt: string;
};

export type CoordinationEventSummary = {
  sequence: number;
  eventId: string;
  actorSessionId: string;
  sessionRole: CoordinationEventRoleSnapshot["sessionRole"];
  kind: CoordinationEventKind;
  state: CoordinationEventState;
  summary: string;
  createdAt: string;
};

export type CoordinationEvent = CoordinationEventSummary & {
  roleContractRevision: CoordinationEventRoleSnapshot["roleContractRevision"];
  rootSessionId: string;
  parentSessionId: string | null;
  delegationDepth: number;
  payload: CoordinationEventPayload;
  executionId: string | null;
  targetSessionId: string | null;
  correctedEventId: string | null;
  options: CoordinationEventOption[];
  actions: CoordinationEventAction[];
};

export type CoordinationEventCreateInput = {
  kind: Exclude<CoordinationEventKind, "correction">;
  payload: CoordinationEventPayload;
  executionId?: string;
  targetSessionId?: string;
  options?: CoordinationEventOption[];
  idempotencyKey: string;
};

export type CoordinationEventListInput = {
  scope: CoordinationEventScope;
  kind?: CoordinationEventKind;
  state?: CoordinationEventState;
  limit: number;
  cursor?: string;
};

export type CoordinationEventGetInput =
  | { eventId: string; idempotencyKey?: never }
  | { eventId?: never; idempotencyKey: string };

export type CoordinationEventResolveInput = {
  eventId: string;
  optionId?: string;
  note?: string;
  idempotencyKey: string;
};

export type CoordinationEventCancelInput = {
  eventId: string;
  note?: string;
  idempotencyKey: string;
};

export type CoordinationEventCorrectInput = {
  eventId: string;
  payload: CoordinationEventPayload;
  executionId?: string;
  idempotencyKey: string;
};

export type CoordinationEventListResult = {
  items: CoordinationEventSummary[];
  nextCursor?: string;
};

export type CoordinationEventCorrectionResult = {
  correction: CoordinationEvent;
  superseded: CoordinationEvent;
};

export class CoordinationEventValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean>;

  constructor(message: string, details: Record<string, string | number | boolean> = {}, code = "INVALID_INPUT") {
    super(message);
    this.name = "CoordinationEventValidationError";
    this.code = code;
    this.details = details;
  }
}

export function initialCoordinationEventState(kind: CoordinationEventKind): "recorded" | "open" {
  return COORDINATION_EVENT_OPEN_KINDS.includes(kind as (typeof COORDINATION_EVENT_OPEN_KINDS)[number])
    ? "open"
    : "recorded";
}

export function validateCoordinationEventPayload(value: unknown, field = "payload"): CoordinationEventPayload {
  const record = requireObject(value, field);
  assertKeys(record, ["summary", "facts", "assumptions", "impact", "recommendation"], field);
  const payload: CoordinationEventPayload = {
    summary: requireText(record.summary, `${field}.summary`, 240),
    ...(record.facts === undefined ? {} : { facts: requireTextList(record.facts, `${field}.facts`) }),
    ...(record.assumptions === undefined ? {} : { assumptions: requireTextList(record.assumptions, `${field}.assumptions`) }),
    ...(record.impact === undefined ? {} : { impact: requireText(record.impact, `${field}.impact`, 1_000) }),
    ...(record.recommendation === undefined
      ? {}
      : { recommendation: requireText(record.recommendation, `${field}.recommendation`, 1_000) }),
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (actualBytes > COORDINATION_EVENT_MAX_PAYLOAD_BYTES) {
    throw new CoordinationEventValidationError(
      "Coordination event payload exceeds 16 KiB.",
      { field, actualBytes, maxBytes: COORDINATION_EVENT_MAX_PAYLOAD_BYTES },
      "CONTENT_TOO_LARGE",
    );
  }
  rejectSensitiveText(payload, field);
  return payload;
}

export function validateCoordinationEventOptions(value: unknown, field = "options"): CoordinationEventOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw invalid(field, "Coordination event options must contain 2 to 8 items.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    const record = requireObject(entry, itemField);
    assertKeys(record, ["id", "label", "description"], itemField);
    const id = requireStableId(record.id, `${itemField}.id`);
    if (ids.has(id)) throw invalid(`${itemField}.id`, "Coordination option IDs must be unique.");
    ids.add(id);
    return {
      id,
      label: requireText(record.label, `${itemField}.label`, 120),
      ...(record.description === undefined
        ? {}
        : { description: requireText(record.description, `${itemField}.description`, 500) }),
    };
  });
}

export function validateCoordinationEventNote(value: unknown, field = "note"): string {
  const note = requireText(value, field, 1_000);
  rejectSensitiveValues([note], field);
  return note;
}

function requireTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw invalid(field, "Coordination event list fields contain at most 8 items.");
  }
  return value.map((item, index) => requireText(item, `${field}[${index}]`, 500));
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalid(field, `${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireStableId(value: unknown, field: string): string {
  const id = requireText(value, field, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw invalid(field, `${field} must be a stable identifier.`);
  }
  return id;
}

function rejectSensitiveText(payload: CoordinationEventPayload, field: string): void {
  const values = [
    payload.summary,
    ...(payload.facts ?? []),
    ...(payload.assumptions ?? []),
    payload.impact ?? "",
    payload.recommendation ?? "",
  ];
  rejectSensitiveValues(values, field);
}

function rejectSensitiveValues(values: readonly string[], field: string): void {
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:sk|ghp|github_pat)_[a-z0-9_-]{20,}\b/i,
    /(?:^|\s)(?:[a-z]:\\Users\\|\/Users\/|\/home\/)[^\s]+/i,
    /\b(?:stack trace|traceback \(most recent call last\))\b/i,
    /\b(?:chain[- ]of[- ]thought|provider response|opaque binding|agentRuntimeBinding)\b/i,
    /^diff --git /im,
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m,
    /(?:^|\n)\s*(?:\[[A-Z]{3,}\]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s/m,
  ];
  if (values.some((text) => forbidden.some((pattern) => pattern.test(text)))) {
    throw new CoordinationEventValidationError(
      "Coordination event payload contains content that must not be stored.",
      { field },
      "SENSITIVE_CONTENT_REJECTED",
    );
  }
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`${field}.${unknown}`, `Unknown field: ${field}.${unknown}.`);
}

export function requireNonEmptyString(value: unknown, field: string): string {
  return requireText(value, field, 1_000);
}

export function invalid(field: string, message: string): CoordinationEventValidationError {
  return new CoordinationEventValidationError(message, { field });
}
