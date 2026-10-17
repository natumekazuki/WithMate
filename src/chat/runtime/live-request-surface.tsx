import { useEffect, useId, useState } from "react";
import { ButtonContent } from "../../ui/button-content.js";

import type {
  LiveApprovalRequest,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveElicitationResponse,
  ElicitationRecord,
} from "../../../src-shared/session/runtime-state.js";

function liveApprovalKindLabel(kind: string): string {
  switch (kind) {
    case "shell":
      return "Shell Command";
    case "write":
      return "File Change";
    case "mcp":
      return "MCP Tool";
    case "custom-tool":
      return "Custom Tool";
    case "url":
      return "URL Fetch";
    case "read":
      return "File Read";
    default:
      return kind;
  }
}

function liveElicitationModeLabel(mode: LiveElicitationRequest["mode"]): string {
  return mode === "url" ? "URL" : "Form";
}

type LiveElicitationFieldValue = string | number | boolean | string[];
export type LiveElicitationDrafts = Map<string, {
  fieldValues: Record<string, LiveElicitationFieldValue>;
  freeTextValues: Record<string, string>;
}>;
type LiveElicitationContentEntry = readonly [string, LiveElicitationFieldValue];

function createLiveElicitationFieldValue(field: LiveElicitationField): LiveElicitationFieldValue {
  switch (field.type) {
    case "boolean":
      return field.defaultValue ?? false;
    case "number":
      return field.defaultValue ?? "";
    case "multi-select":
      return field.defaultValue ?? [];
    case "select":
      return field.defaultValue ?? "";
    case "text":
      return field.defaultValue ?? "";
    default:
      return "";
  }
}

function createLiveElicitationFormState(request: LiveElicitationRequest): Record<string, LiveElicitationFieldValue> {
  return Object.fromEntries(request.fields.map((field) => [field.name, createLiveElicitationFieldValue(field)]));
}

function validateLiveElicitationField(
  field: LiveElicitationField,
  value: LiveElicitationFieldValue,
): string | null {
  switch (field.type) {
    case "text": {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (field.required && !normalized) {
        return `${field.title} is required.`;
      }
      if (field.minLength !== undefined && normalized.length < field.minLength) {
        return `${field.title} must be at least ${field.minLength} characters.`;
      }
      if (field.maxLength !== undefined && normalized.length > field.maxLength) {
        return `${field.title} must be at most ${field.maxLength} characters.`;
      }
      return null;
    }
    case "select": {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (field.required && !normalized) {
        return field.allowFreeText ? `Enter ${field.title}.` : `Select ${field.title}.`;
      }
      return null;
    }
    case "multi-select": {
      const items = Array.isArray(value) ? value : [];
      if ((field.required || (field.minItems ?? 0) > 0) && items.length === 0) {
        return `Select at least 1 ${field.title}.`;
      }
      if (field.minItems !== undefined && items.length < field.minItems) {
        return `${field.title} must have at least ${field.minItems} items.`;
      }
      if (field.maxItems !== undefined && items.length > field.maxItems) {
        return `${field.title} must have at most ${field.maxItems} items.`;
      }
      return null;
    }
    case "number": {
      if (value === "") {
        return field.required ? `${field.title} is required.` : null;
      }
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `Enter a number for ${field.title}.`;
      }
      if (field.numberKind === "integer" && !Number.isInteger(value)) {
        return `Enter an integer for ${field.title}.`;
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return `${field.title} must be at least ${field.minimum}.`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `${field.title} must be at most ${field.maximum}.`;
      }
      return null;
    }
    case "boolean":
      return null;
    default:
      return null;
  }
}

function buildLiveElicitationResponseContent(
  request: LiveElicitationRequest,
  fieldValues: Record<string, LiveElicitationFieldValue>,
): Record<string, LiveElicitationFieldValue> {
  const entries = request.fields.flatMap<LiveElicitationContentEntry>((field) => {
    const value = fieldValues[field.name];
    if (field.type === "text" || field.type === "select") {
      if (typeof value !== "string") {
        return [];
      }
      if (!field.required && !value.trim()) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "multi-select") {
      if (!Array.isArray(value)) {
        return [];
      }
      if (!field.required && value.length === 0) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "number") {
      if (value === "" || typeof value !== "number" || Number.isNaN(value)) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "boolean" && typeof value === "boolean") {
      return [[field.name, value] as const];
    }

    return [];
  });

  return Object.fromEntries(entries);
}

function liveElicitationTextValue(value: LiveElicitationFieldValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function liveElicitationMultiSelectValue(value: LiveElicitationFieldValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function mergeFreeTextAnswers(
  request: LiveElicitationRequest,
  fieldValues: Record<string, LiveElicitationFieldValue>,
  freeTextValues: Record<string, string>,
): Record<string, LiveElicitationFieldValue> {
  const answers = { ...fieldValues };
  for (const field of request.fields) {
    if (field.type !== "multi-select" || !field.allowFreeText) continue;
    const freeText = (freeTextValues[field.name] ?? "").trim();
    const selected = liveElicitationMultiSelectValue(fieldValues[field.name]);
    answers[field.name] = freeText && !selected.includes(freeText) ? [...selected, freeText] : selected;
  }
  return answers;
}

type LiveElicitationCardProps = {
  request: LiveElicitationRequest;
  elicitationActionRequestId: string | null;
  elicitationAction?: LiveElicitationResponse["action"] | null;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
  inputAvailable?: boolean;
  drafts?: LiveElicitationDrafts;
};

function LiveElicitationCard({
  request,
  elicitationActionRequestId,
  elicitationAction,
  onResolveLiveElicitation,
  onOpenPath,
  inputAvailable = true,
  drafts,
}: LiveElicitationCardProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, LiveElicitationFieldValue>>(
    () => drafts?.get(request.requestId)?.fieldValues ?? createLiveElicitationFormState(request),
  );
  const [freeTextValues, setFreeTextValues] = useState<Record<string, string>>(() => drafts?.get(request.requestId)?.freeTextValues ?? {});
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const fieldIdPrefix = useId();

  useEffect(() => {
    drafts?.set(request.requestId, { fieldValues, freeTextValues });
  }, [drafts, request.requestId, fieldValues, freeTextValues]);

  const isSubmitting = elicitationActionRequestId === request.requestId;
  const submittedAction = isSubmitting ? elicitationAction : null;
  const isActionPending = elicitationActionRequestId !== null;
  const acceptDisabled = isActionPending || (request.delivery === "user-message" && !inputAvailable);

  const handleSubmit = (action: LiveElicitationResponse["action"]) => {
    if (isActionPending || (action === "accept" && acceptDisabled)) return;
    if (action === "accept") {
      const answers = mergeFreeTextAnswers(request, fieldValues, freeTextValues);
      for (const field of request.fields) {
        const validation = validateLiveElicitationField(field, answers[field.name] ?? "");
        if (validation) {
          setValidationMessage(validation);
          return;
        }
      }

      setValidationMessage(null);
      const content = buildLiveElicitationResponseContent(request, answers);
      onResolveLiveElicitation(request, {
        action,
        ...(Object.keys(content).length > 0 ? { content } : {}),
      });
      return;
    }

    setValidationMessage(null);
    onResolveLiveElicitation(request, { action });
  };

  return (
    <section
      className="live-elicitation-card"
      role="group"
      aria-label={request.blocking === false ? "Input requested" : "Input required"}
      aria-busy={isSubmitting || undefined}
    >
      <div className="live-approval-head">
        <div className="live-approval-copy">
          <span className="live-approval-badge">{request.blocking === false ? "Input Requested" : "Input Required"}</span>
          <p className="live-approval-title">{request.message}</p>
        </div>
        <span className="live-approval-kind">{liveElicitationModeLabel(request.mode)}</span>
      </div>
      {request.source ? <p className="live-elicitation-source">{request.source}</p> : null}
      {request.mode === "url" && request.url ? (
        <div className="live-elicitation-url">
          <code>{request.url}</code>
          {onOpenPath ? (
            <button
              type="button"
              className="drawer-toggle secondary"
              onClick={() => onOpenPath(request.url!)}
              disabled={isSubmitting}
            >
              Open
            </button>
          ) : null}
        </div>
      ) : null}
      {request.mode === "form" && request.fields.length > 0 ? (
        <div className="live-elicitation-form">
          {request.fields.map((field, index) => (
            <div key={field.name} className="live-elicitation-field">
              <span className="live-elicitation-label">
                {field.title}
                {field.required ? <strong> *</strong> : null}
              </span>
              {field.description ? (
                <span id={`${fieldIdPrefix}-description-${index}`} className="live-elicitation-description">
                  {field.description}
                </span>
              ) : null}
              {field.type === "text" ? (
                !field.secret && field.maxLength !== undefined && field.maxLength > 120 ? (
                  <textarea
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                ) : (
                  <input
                    type={field.secret ? "password" : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                )
              ) : null}
              {field.type === "number" ? (
                <input
                  type="number"
                  aria-label={field.title}
                  aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                  step={field.numberKind === "integer" ? "1" : "any"}
                  value={typeof fieldValues[field.name] === "number" ? String(fieldValues[field.name]) : ""}
                  onChange={(event) =>
                    setFieldValues((current) => ({
                      ...current,
                      [field.name]: event.target.value === "" ? "" : Number(event.target.value),
                    }))}
                  disabled={isSubmitting}
                />
              ) : null}
              {field.type === "boolean" ? (
                <span className="live-elicitation-checkbox">
                  <input
                    type="checkbox"
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    checked={fieldValues[field.name] === true}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                    disabled={isSubmitting}
                  />
                  <span>Enabled</span>
                </span>
              ) : null}
              {field.type === "select" ? (
                field.allowFreeText ? (
                  <>
                    <input
                      type="text"
                      aria-label={field.title}
                      aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                      list={`${fieldIdPrefix}-choices-${index}`}
                      value={liveElicitationTextValue(fieldValues[field.name])}
                      onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                      disabled={isSubmitting}
                    />
                    <datalist id={`${fieldIdPrefix}-choices-${index}`}>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value} label={option.label} />
                      ))}
                    </datalist>
                  </>
                ) : (
                  <select
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  >
                    {!field.required ? <option value="">No Selection</option> : null}
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )
              ) : null}
              {field.type === "multi-select" ? (
                <div
                  className="live-elicitation-options"
                  role="group"
                  aria-label={field.title}
                  aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                >
                  {field.options.map((option) => {
                    const selectedValues = liveElicitationMultiSelectValue(fieldValues[field.name]);
                    const checked = selectedValues.includes(option.value);
                    return (
                      <label key={option.value} className="live-elicitation-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setFieldValues((current) => {
                              const currentValues = liveElicitationMultiSelectValue(current[field.name]);
                              return {
                                ...current,
                                [field.name]: event.target.checked
                                  ? [...currentValues, option.value]
                                  : currentValues.filter((value) => value !== option.value),
                              };
                            });
                          }}
                          disabled={isSubmitting}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                  {field.allowFreeText ? (
                    <label className="live-elicitation-field">
                      <span>Other</span>
                      <input
                        type="text"
                        aria-label={`${field.title} Other`}
                        value={freeTextValues[field.name] ?? ""}
                        onChange={(event) => setFreeTextValues((current) => ({ ...current, [field.name]: event.target.value }))}
                        disabled={isSubmitting}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {validationMessage ? <p className="live-approval-warning" role="alert">{validationMessage}</p> : null}
      <div className="live-approval-actions">
        {isSubmitting ? <span className="visually-hidden" role="status">Processing input request</span> : null}
        <button type="button" onClick={() => handleSubmit("accept")} disabled={acceptDisabled} aria-busy={(isSubmitting && submittedAction === "accept") || undefined}>
          <ButtonContent busy={isSubmitting && submittedAction === "accept"}>{request.mode === "url" ? "Complete" : "Submit"}</ButtonContent>
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("decline")}
          disabled={isActionPending}
          aria-busy={(isSubmitting && submittedAction === "decline") || undefined}
        >
          <ButtonContent busy={isSubmitting && submittedAction === "decline"}>Reject</ButtonContent>
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("cancel")}
          disabled={isActionPending}
          aria-busy={(isSubmitting && submittedAction === "cancel") || undefined}
        >
          <ButtonContent busy={isSubmitting && submittedAction === "cancel"}>Close</ButtonContent>
        </button>
      </div>
    </section>
  );
}

export function ElicitationRecords({ records }: { records?: readonly ElicitationRecord[] }) {
  return records?.map((record) => (
    <section className="live-elicitation-card" key={record.requestId} aria-label="Question record">
      <div className="live-approval-head">
        <div className="live-approval-copy">
          <span className="live-approval-badge">{record.status === "answered" ? "Answer Submitted" : record.status === "pending" ? "Input Requested" : "No Form Response"}</span>
          <p className="live-approval-title">{record.message}</p>
        </div>
      </div>
      <div className="live-elicitation-form">
        {record.fields.map((field, index) => (
          <div className="live-elicitation-field" key={index}>
            <span className="live-elicitation-label">{field.title}</span>
            {field.description ? <span className="live-elicitation-description">{field.description}</span> : null}
            {field.options?.length ? <ul className="elicitation-record-options">{field.options.map((option, optionIndex) => <li key={optionIndex}>{option}</li>)}</ul> : null}
          </div>
        ))}
      </div>
    </section>
  ));
}

export type LiveRequestSurfaceProps = {
  liveApprovalRequest: LiveApprovalRequest | null;
  approvalActionRequestId: string | null;
  approvalActionDecision?: "approve" | "deny" | null;
  liveElicitationRequest: LiveElicitationRequest | null;
  liveElicitationRequests?: readonly LiveElicitationRequest[];
  elicitationRecords?: readonly ElicitationRecord[];
  inputAvailable?: boolean;
  drafts?: LiveElicitationDrafts;
  elicitationActionRequestId: string | null;
  elicitationAction?: LiveElicitationResponse["action"] | null;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
};

export function LiveRequestSurface({
  liveApprovalRequest,
  approvalActionRequestId,
  approvalActionDecision,
  liveElicitationRequest,
  liveElicitationRequests,
  elicitationRecords,
  inputAvailable,
  drafts,
  elicitationActionRequestId,
  elicitationAction,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onOpenPath,
}: LiveRequestSurfaceProps) {
  const requests = liveElicitationRequests ?? (liveElicitationRequest ? [liveElicitationRequest] : []);
  const visibleRecords = elicitationRecords?.filter((record) => !requests.some((request) => request.requestId === record.requestId));
  const isApprovalSubmitting = liveApprovalRequest
    ? approvalActionRequestId === liveApprovalRequest.requestId
    : false;
  const approvalDecision = isApprovalSubmitting ? approvalActionDecision : null;
  const resolveApproval = (decision: "approve" | "deny") => {
    if (!liveApprovalRequest || isApprovalSubmitting) return;
    onResolveLiveApproval(liveApprovalRequest, decision);
  };

  return (
    <>
      {liveApprovalRequest ? (
        <section
          className="live-approval-card"
          role="group"
          aria-label="Approval required"
          aria-busy={isApprovalSubmitting || undefined}
        >
          <div className="live-approval-head">
            <div className="live-approval-copy">
              <span className="live-approval-badge">Approval Required</span>
              <p className="live-approval-title">{liveApprovalRequest.title}</p>
            </div>
            <span className="live-approval-kind">{liveApprovalKindLabel(liveApprovalRequest.kind)}</span>
          </div>
          <pre className="live-approval-summary">{liveApprovalRequest.summary}</pre>
          {liveApprovalRequest.warning ? (
            <p className="live-approval-warning" role="alert">{liveApprovalRequest.warning}</p>
          ) : null}
          {liveApprovalRequest.details ? (
            <details className="live-approval-details">
              <summary>Details</summary>
              <pre>{liveApprovalRequest.details}</pre>
            </details>
          ) : null}
          <div className="live-approval-actions">
            {isApprovalSubmitting ? <span className="visually-hidden" role="status">Processing approval request</span> : null}
            <button
              type="button"
              onClick={() => resolveApproval("approve")}
              disabled={isApprovalSubmitting}
              aria-busy={approvalDecision === "approve" || undefined}
            >
              <ButtonContent busy={approvalDecision === "approve"}>Allow Once</ButtonContent>
            </button>
            <button
              className="drawer-toggle secondary"
              type="button"
              onClick={() => resolveApproval("deny")}
              disabled={isApprovalSubmitting}
              aria-busy={approvalDecision === "deny" || undefined}
            >
              <ButtonContent busy={approvalDecision === "deny"}>Reject</ButtonContent>
            </button>
          </div>
        </section>
      ) : null}
      <ElicitationRecords records={visibleRecords} />
      {requests.map((request) => (
        <LiveElicitationCard
          key={request.requestId}
          request={request}
          inputAvailable={inputAvailable}
          drafts={drafts}
          elicitationActionRequestId={elicitationActionRequestId}
          elicitationAction={elicitationAction}
          onResolveLiveElicitation={onResolveLiveElicitation}
          onOpenPath={onOpenPath}
        />
      ))}
    </>
  );
}
