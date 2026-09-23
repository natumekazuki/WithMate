import { useEffect, useState } from "react";

import type {
  LiveApprovalRequest,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveElicitationResponse,
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
      const normalized = typeof value === "string" ? value : "";
      if (field.required && !normalized) {
        return `Select ${field.title}.`;
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

type LiveElicitationCardProps = {
  request: LiveElicitationRequest;
  elicitationActionRequestId: string | null;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
};

function LiveRequestBusyIndicator({ label }: { label: string }) {
  return (
    <span className="settings-loading-inline" role="status" aria-label={label}>
      <span className="settings-action-spinner" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

function LiveElicitationCard({
  request,
  elicitationActionRequestId,
  onResolveLiveElicitation,
  onOpenPath,
}: LiveElicitationCardProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, LiveElicitationFieldValue>>(
    () => createLiveElicitationFormState(request),
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  useEffect(() => {
    setFieldValues(createLiveElicitationFormState(request));
    setValidationMessage(null);
  }, [request.requestId]);

  const isSubmitting = elicitationActionRequestId === request.requestId;

  const handleSubmit = (action: LiveElicitationResponse["action"]) => {
    if (action === "accept") {
      for (const field of request.fields) {
        const validation = validateLiveElicitationField(field, fieldValues[field.name] ?? "");
        if (validation) {
          setValidationMessage(validation);
          return;
        }
      }

      setValidationMessage(null);
      const content = buildLiveElicitationResponseContent(request, fieldValues);
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
      aria-label="Input required"
      aria-busy={isSubmitting || undefined}
    >
      <div className="live-approval-head">
        <div className="live-approval-copy">
          <span className="live-approval-badge">Input Required</span>
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
          {request.fields.map((field) => (
            <label key={field.name} className="live-elicitation-field">
              <span className="live-elicitation-label">
                {field.title}
                {field.required ? <strong> *</strong> : null}
              </span>
              {field.description ? <span className="live-elicitation-description">{field.description}</span> : null}
              {field.type === "text" ? (
                field.maxLength !== undefined && field.maxLength > 120 ? (
                  <textarea
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                ) : (
                  <input
                    type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                )
              ) : null}
              {field.type === "number" ? (
                <input
                  type="number"
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
                    checked={fieldValues[field.name] === true}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                    disabled={isSubmitting}
                  />
                  <span>Enabled</span>
                </span>
              ) : null}
              {field.type === "select" ? (
                <select
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
              ) : null}
              {field.type === "multi-select" ? (
                <div className="live-elicitation-options">
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
                </div>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}
      {validationMessage ? <p className="live-approval-warning" role="alert">{validationMessage}</p> : null}
      <div className="live-approval-actions">
        {isSubmitting ? <LiveRequestBusyIndicator label="Processing input request" /> : null}
        <button type="button" onClick={() => handleSubmit("accept")} disabled={isSubmitting}>
          {request.mode === "url" ? "Complete" : "Submit"}
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("decline")}
          disabled={isSubmitting}
        >
          Reject
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("cancel")}
          disabled={isSubmitting}
        >
          Close
        </button>
      </div>
    </section>
  );
}

export type LiveRequestSurfaceProps = {
  liveApprovalRequest: LiveApprovalRequest | null;
  approvalActionRequestId: string | null;
  liveElicitationRequest: LiveElicitationRequest | null;
  elicitationActionRequestId: string | null;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
};

export function LiveRequestSurface({
  liveApprovalRequest,
  approvalActionRequestId,
  liveElicitationRequest,
  elicitationActionRequestId,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onOpenPath,
}: LiveRequestSurfaceProps) {
  const isApprovalSubmitting = liveApprovalRequest
    ? approvalActionRequestId === liveApprovalRequest.requestId
    : false;

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
            {isApprovalSubmitting ? <LiveRequestBusyIndicator label="Processing approval request" /> : null}
            <button
              type="button"
              onClick={() => onResolveLiveApproval(liveApprovalRequest, "approve")}
              disabled={isApprovalSubmitting}
            >
              Allow Once
            </button>
            <button
              className="drawer-toggle secondary"
              type="button"
              onClick={() => onResolveLiveApproval(liveApprovalRequest, "deny")}
              disabled={isApprovalSubmitting}
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}
      {liveElicitationRequest ? (
        <LiveElicitationCard
          request={liveElicitationRequest}
          elicitationActionRequestId={elicitationActionRequestId}
          onResolveLiveElicitation={onResolveLiveElicitation}
          onOpenPath={onOpenPath}
        />
      ) : null}
    </>
  );
}
