import type {
  AuditLogEntry,
  LiveApprovalRequest,
  LiveBackgroundTask,
  LiveElicitationRequest,
  LiveRunStep,
  LiveSessionRunState,
} from "./app-state.js";

type LiveRunAuditOperationSource = Pick<
  LiveSessionRunState,
  "approvalRequest" | "elicitationRequest" | "steps" | "backgroundTasks"
>;

function joinOperationDetails(values: Array<string | null | undefined>): string | undefined {
  const details = values.filter((value) => typeof value === "string" && value.trim().length > 0).join("\n");
  return details || undefined;
}

function buildStepOperation(step: LiveRunStep): AuditLogEntry["operations"][number] {
  return {
    type: step.type,
    summary: step.summary,
    details: joinOperationDetails([step.status, step.details]),
  };
}

function buildBackgroundTaskOperation(task: LiveBackgroundTask): AuditLogEntry["operations"][number] {
  return {
    type: `background-${task.kind}`,
    summary: task.title,
    details: joinOperationDetails([task.status, task.details]),
  };
}

function buildApprovalRequestOperation(request: LiveApprovalRequest): AuditLogEntry["operations"][number] {
  return {
    type: "approval_request",
    summary: request.title,
    details: joinOperationDetails([
      "status:pending",
      `kind:${request.kind}`,
      request.summary,
      request.details,
      request.warning ? `warning:${request.warning}` : "",
    ]),
  };
}

function buildElicitationRequestOperation(request: LiveElicitationRequest): AuditLogEntry["operations"][number] {
  return {
    type: "elicitation_request",
    summary: request.message,
    details: joinOperationDetails([
      "status:pending",
      `mode:${request.mode}`,
      request.source ? `source:${request.source}` : "",
      request.url ? `url:${request.url}` : "",
      ...request.fields.map((field) => `${field.required ? "required" : "optional"}:${field.title}`),
    ]),
  };
}

export function buildLiveRunAuditOperations(state: LiveRunAuditOperationSource): AuditLogEntry["operations"] {
  return [
    ...(state.approvalRequest ? [buildApprovalRequestOperation(state.approvalRequest)] : []),
    ...(state.elicitationRequest ? [buildElicitationRequestOperation(state.elicitationRequest)] : []),
    ...state.steps.map(buildStepOperation),
    ...state.backgroundTasks.map(buildBackgroundTaskOperation),
  ];
}
