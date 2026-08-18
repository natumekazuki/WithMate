import { APPROVAL_MODE_VALUES, type ApprovalMode } from "./approval-mode.js";
import {
  CODEX_SANDBOX_MODE_VALUES,
  type CodexSandboxMode,
} from "./codex-sandbox-mode.js";
import {
  isModelReasoningEffort,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import type {
  ComposerAttachmentInput,
  RunSessionTurnRequest,
} from "./app-state.js";

export type SessionScheduleTrigger =
  | { type: "once"; localDateTime: string; timeZone: string }
  | { type: "cron"; expression: string; timeZone: string };

export type SessionScheduleState = "active" | "paused" | "completed";
export type SessionScheduleFireState =
  "pending" | "claimed" | "enqueued" | "failed";

export type SessionScheduleTurn = Pick<
  RunSessionTurnRequest,
  | "userMessage"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "customAgentName"
> & {
  provider: "codex" | "copilot";
  attachments?: ComposerAttachmentInput[];
};

export type SessionSchedule = {
  id: string;
  sessionId: string;
  revision: number;
  name: string;
  trigger: SessionScheduleTrigger;
  state: SessionScheduleState;
  turn: SessionScheduleTurn;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionScheduleFire = {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  logicalFireAt: string;
  kind: "scheduled" | "run_now";
  state: SessionScheduleFireState;
  idempotencyKey: string;
  executionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionScheduleProjection = SessionSchedule & {
  latestFire: SessionScheduleFire | null;
};
export type SessionScheduleSummary = Omit<SessionSchedule, "turn"> & {
  latestFire: SessionScheduleFire | null;
};
export type SessionScheduleChangedEvent = {
  sessionId: string;
  scheduleId?: string;
  kind: "created" | "updated" | "paused" | "resumed" | "deleted" | "fired";
};

export type CreateSessionScheduleInput = {
  name: string;
  trigger: SessionScheduleTrigger;
  turn: SessionScheduleTurn;
};

export type UpdateSessionScheduleInput = CreateSessionScheduleInput & {
  scheduleId: string;
  expectedRevision: number;
};

export type SessionScheduleRevisionRequest = {
  scheduleId: string;
  expectedRevision: number;
};

export type RunSessionScheduleNowInput = {
  scheduleId: string;
  requestId: string;
};

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key))
      throw new TypeError(`${label} contains an unknown field.`);
  }
  return record;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${label} is required.`);
  return value;
}

function parseScheduleTurn(value: unknown): SessionScheduleTurn {
  const record = strictRecord(
    value,
    [
      "provider",
      "userMessage",
      "model",
      "reasoningEffort",
      "approvalMode",
      "codexSandboxMode",
      "customAgentName",
      "attachments",
    ],
    "Schedule turn",
  );
  if (record.provider !== "codex" && record.provider !== "copilot")
    throw new TypeError("Schedule turn provider is invalid.");
  const userMessage = nonEmptyString(record.userMessage, "Schedule prompt");
  const model = nonEmptyString(record.model, "Schedule model");
  if (!isModelReasoningEffort(record.reasoningEffort))
    throw new TypeError("Schedule reasoning effort is invalid.");
  const reasoningEffort = record.reasoningEffort;
  if (!APPROVAL_MODE_VALUES.includes(record.approvalMode as ApprovalMode))
    throw new TypeError("Schedule approval mode is invalid.");
  const approvalMode = record.approvalMode as ApprovalMode;
  let codexSandboxMode: SessionScheduleTurn["codexSandboxMode"];
  let customAgentName: string | undefined;
  if (record.provider === "codex") {
    if (
      !CODEX_SANDBOX_MODE_VALUES.includes(
        record.codexSandboxMode as CodexSandboxMode,
      )
    ) {
      throw new TypeError("Schedule sandbox mode is invalid.");
    }
    codexSandboxMode = record.codexSandboxMode as CodexSandboxMode;
    if (
      record.customAgentName !== undefined &&
      record.customAgentName !== null
    ) {
      throw new TypeError("Codex schedule cannot specify a custom agent.");
    }
  } else {
    if (
      record.codexSandboxMode !== undefined &&
      record.codexSandboxMode !== null
    ) {
      throw new TypeError(
        "Copilot schedule cannot specify a Codex sandbox mode.",
      );
    }
    if (typeof record.customAgentName !== "string") {
      throw new TypeError("Copilot schedule custom agent is required.");
    }
    customAgentName = record.customAgentName;
  }
  const attachments =
    record.attachments === undefined ? undefined : record.attachments;
  if (attachments !== undefined && !Array.isArray(attachments))
    throw new TypeError("Schedule attachments are invalid.");
  const normalizedAttachments = attachments?.map((attachment) => {
    const item = strictRecord(
      attachment,
      ["path", "source", "kind"],
      "Schedule attachment",
    );
    const path = nonEmptyString(item.path, "Schedule attachment path");
    if (item.source !== "text" && item.source !== "markdown-image")
      throw new TypeError("Schedule attachment source is invalid.");
    if (
      item.kind !== undefined &&
      item.kind !== "file" &&
      item.kind !== "folder" &&
      item.kind !== "image"
    )
      throw new TypeError("Schedule attachment kind is invalid.");
    return {
      path,
      source: item.source as ComposerAttachmentInput["source"],
      ...(item.kind === undefined
        ? {}
        : { kind: item.kind as ComposerAttachmentInput["kind"] }),
    };
  });
  return {
    provider: record.provider,
    userMessage,
    model,
    reasoningEffort,
    approvalMode,
    codexSandboxMode,
    customAgentName,
    attachments: normalizedAttachments,
  };
}

export function parseCreateSessionScheduleInput(
  value: unknown,
): CreateSessionScheduleInput {
  const record = strictRecord(
    value,
    ["name", "trigger", "turn"],
    "Schedule create request",
  );
  const name = nonEmptyString(record.name, "Schedule name");
  if (name.length > 120) throw new TypeError("Schedule name is too long.");
  return {
    name,
    trigger: parseSessionScheduleTrigger(record.trigger),
    turn: parseScheduleTurn(record.turn),
  };
}

export function parseUpdateSessionScheduleInput(
  value: unknown,
): UpdateSessionScheduleInput {
  const record = strictRecord(
    value,
    ["scheduleId", "expectedRevision", "name", "trigger", "turn"],
    "Schedule update request",
  );
  if (
    !Number.isInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 1
  )
    throw new TypeError("Schedule revision is invalid.");
  const name = nonEmptyString(record.name, "Schedule name");
  if (name.length > 120) throw new TypeError("Schedule name is too long.");
  return {
    scheduleId: nonEmptyString(record.scheduleId, "Schedule ID"),
    expectedRevision: record.expectedRevision as number,
    name,
    trigger: parseSessionScheduleTrigger(record.trigger),
    turn: parseScheduleTurn(record.turn),
  };
}

export function parseSessionScheduleRevisionRequest(
  value: unknown,
): SessionScheduleRevisionRequest {
  const record = strictRecord(
    value,
    ["scheduleId", "expectedRevision"],
    "Schedule mutation request",
  );
  if (
    !Number.isInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 1
  )
    throw new TypeError("Schedule revision is invalid.");
  return {
    scheduleId: nonEmptyString(record.scheduleId, "Schedule ID"),
    expectedRevision: record.expectedRevision as number,
  };
}

export function parseRunSessionScheduleNowInput(
  value: unknown,
): RunSessionScheduleNowInput {
  const record = strictRecord(
    value,
    ["scheduleId", "requestId"],
    "Schedule run-now request",
  );
  return {
    scheduleId: nonEmptyString(record.scheduleId, "Schedule ID"),
    requestId: nonEmptyString(record.requestId, "Schedule request ID"),
  };
}

export function parseSessionScheduleTrigger(
  value: unknown,
): SessionScheduleTrigger {
  const base = strictRecord(
    value,
    ["type", "localDateTime", "expression", "timeZone"],
    "Schedule trigger",
  );
  const v = base as Record<string, unknown>;
  if (typeof v.timeZone !== "string" || !v.timeZone.trim())
    throw new TypeError("Schedule time zone is required.");
  if (
    v.type === "once" &&
    typeof v.localDateTime === "string" &&
    v.expression === undefined
  ) {
    return {
      type: "once",
      localDateTime: v.localDateTime,
      timeZone: v.timeZone,
    };
  }
  if (
    v.type === "cron" &&
    typeof v.expression === "string" &&
    v.localDateTime === undefined
  ) {
    return { type: "cron", expression: v.expression, timeZone: v.timeZone };
  }
  throw new TypeError("Invalid schedule trigger.");
}
