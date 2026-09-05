export const SESSION_INTERACTION_PUBLIC_MAX_BYTES = 256 * 1024;
export const SESSION_INTERACTION_PAGE_MAX = 500;

export type SessionInteractionKind = "approval" | "elicitation";
export type SessionInteractionState = "pending" | "answered" | "expired";
export type SessionInteractionDecisionClass = "user_only" | "agent_delegable" | "deny_or_cancel";
export type SessionInteractionResponsePrincipal =
  | { kind: "user" }
  | { kind: "agent"; sessionId: string }
  | { kind: "system" };
export type SessionInteractionExpiryReason =
  | "runtime_restarted"
  | "runtime_shutdown"
  | "execution_canceled"
  | "execution_terminal";

export type SessionInteractionResponseAction =
  | "approve"
  | "deny"
  | "accept"
  | "decline"
  | "cancel";

export type SessionInteractionResponseSummary = {
  action: SessionInteractionResponseAction;
  submittedFields: string[];
};

export type SessionApprovalInteractionPublicPayload = {
  title: string;
  summary: string;
  details?: string;
  warning?: string;
};

export type SessionElicitationChoiceOption = {
  value: string;
  label: string;
};

type SessionElicitationFieldBase = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
};

export type SessionElicitationField = SessionElicitationFieldBase & (
  | {
    type: "select";
    options: SessionElicitationChoiceOption[];
    defaultValue?: string;
  }
  | {
    type: "multi-select";
    options: SessionElicitationChoiceOption[];
    defaultValue?: string[];
    minItems?: number;
    maxItems?: number;
  }
  | {
    type: "boolean";
    defaultValue?: boolean;
  }
  | {
    type: "text";
    defaultValue?: string;
    minLength?: number;
    maxLength?: number;
    format?: "email" | "uri" | "date" | "date-time";
  }
  | {
    type: "number";
    numberKind: "number" | "integer";
    defaultValue?: number;
    minimum?: number;
    maximum?: number;
  }
);

export type SessionElicitationInteractionPublicPayload = {
  mode: "form" | "url";
  message: string;
  fields: SessionElicitationField[];
  url?: string;
};

export type SessionInteractionPublicPayload =
  | SessionApprovalInteractionPublicPayload
  | SessionElicitationInteractionPublicPayload;

type SessionInteractionBase = {
  sequence: number;
  revision: number;
  id: string;
  sessionId: string;
  executionId: string;
  kind: SessionInteractionKind;
  decisionClass: SessionInteractionDecisionClass;
  publicPayload: SessionInteractionPublicPayload;
  createdAt: string;
  updatedAt: string;
};

export type PendingSessionInteraction = SessionInteractionBase & {
  state: "pending";
  response: null;
  expiryReason: null;
  resolvedAt: null;
  resolvedBy: null;
};

export type AnsweredSessionInteraction = SessionInteractionBase & {
  state: "answered";
  response: SessionInteractionResponseSummary;
  expiryReason: null;
  resolvedAt: string;
  resolvedBy: SessionInteractionResponsePrincipal | null;
};

export type ExpiredSessionInteraction = SessionInteractionBase & {
  state: "expired";
  response: null;
  expiryReason: SessionInteractionExpiryReason;
  resolvedAt: string;
  resolvedBy: Extract<SessionInteractionResponsePrincipal, { kind: "system" }>;
};

export type SessionInteraction =
  | PendingSessionInteraction
  | AnsweredSessionInteraction
  | ExpiredSessionInteraction;

export type SessionApprovalInteractionResponse = {
  kind: "approval";
  decision: "approve" | "deny";
};

export type SessionElicitationValue = string | number | boolean | string[];

export type SessionElicitationInteractionResponse =
  | {
    kind: "elicitation";
    action: "accept";
    content: Record<string, SessionElicitationValue>;
  }
  | {
    kind: "elicitation";
    action: "decline" | "cancel";
  };

export type SessionInteractionResponse =
  | SessionApprovalInteractionResponse
  | SessionElicitationInteractionResponse;
