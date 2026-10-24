import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { projectMessageRenderedSearchText } from "../../../src-shared/session/message-search.js";
import { ButtonContent } from "../../ui/button-content.js";
import { ComposerIcon } from "../composer/composer-icon.js";
import { QuestionAnswerEditor } from "./question-answer-editor.js";
import type { MessageInlineContent } from "../../ui/markdown/MessageRichText.js";

import type {
  LiveApprovalRequest,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveElicitationResponse,
  ElicitationRecord,
} from "../../../src-shared/session/runtime-state.js";

type LiveElicitationFieldValue = string | number | boolean | string[];
export type LiveElicitationDrafts = Map<string, {
  fieldValues: Record<string, LiveElicitationFieldValue>;
  freeTextValues: Record<string, string>;
  customFields?: string[];
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
  sessionId?: string;
  workspacePath?: string | null;
  disabled?: boolean;
  request: LiveElicitationRequest;
  elicitationActionRequestId: string | null;
  elicitationAction?: LiveElicitationResponse["action"] | null;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
  inputAvailable?: boolean;
  drafts?: LiveElicitationDrafts;
};

function LiveElicitationCard({
  sessionId,
  workspacePath,
  disabled = false,
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
  const [customFields, setCustomFields] = useState<string[]>(() => drafts?.get(request.requestId)?.customFields ?? []);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const pendingAttachments = useRef(new Set<string>());
  const [attachingFields, setAttachingFields] = useState<ReadonlySet<string>>(() => new Set());
  const answerFields = request.mode === "form" ? request.fields.filter((field) =>
    field.type === "text" ? !field.secret && !field.format : (field.type === "select" || field.type === "multi-select") && field.allowFreeText,
  ) : [];
  const [attachmentField, setAttachmentField] = useState(() => answerFields[0]?.name);
  const [attachmentTarget, setAttachmentTarget] = useState<HTMLDivElement | null>(null);
  const fieldIdPrefix = useId();

  useEffect(() => {
    drafts?.set(request.requestId, { fieldValues, freeTextValues, customFields });
  }, [drafts, request.requestId, fieldValues, freeTextValues, customFields]);

  const isSubmitting = elicitationActionRequestId === request.requestId;
  const submittedAction = isSubmitting ? elicitationAction : null;
  const isActionPending = disabled || elicitationActionRequestId !== null;
  const isEditingDisabled = disabled || isSubmitting;
  const acceptDisabled = isActionPending || attachingFields.size > 0 || (request.delivery === "user-message" && !inputAvailable);

  const handleSubmit = (action: LiveElicitationResponse["action"]) => {
    if (isActionPending || (action === "accept" && (acceptDisabled || pendingAttachments.current.size > 0))) return;
    if (action === "accept") {
      const answers = mergeFreeTextAnswers(request, fieldValues, freeTextValues);
      for (const field of request.fields) {
        if (field.type === "select" && field.allowFreeText && customFields.includes(field.name)) answers[field.name] = freeTextValues[field.name] ?? "";
      }
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

  const renderAnswerEditor = (field: LiveElicitationField, index: number, value: string, onChange: (value: string) => void, custom = false) => (
    <QuestionAnswerEditor
      label={custom ? `${field.title} Custom Answer` : field.title}
      describedBy={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
      value={value}
      onChange={onChange}
      disabled={isEditingDisabled}
      sessionId={sessionId}
      workspacePath={workspacePath}
      attachmentTarget={attachmentField === field.name ? attachmentTarget : null}
      attachmentLabel={answerFields.length > 1 ? field.title : undefined}
      onSubmit={() => handleSubmit("accept")}
      onBusyChange={(busy) => {
        if (busy) pendingAttachments.current.add(field.name);
        else pendingAttachments.current.delete(field.name);
        setAttachingFields(new Set(pendingAttachments.current));
      }}
    />
  );

  return (
    <section
      className="live-elicitation-card"
      role="group"
      aria-label={request.blocking === false ? "Input requested" : "Input required"}
      aria-busy={isSubmitting || undefined}
    >
      {request.kind !== "question" ? <p className="live-elicitation-message">{request.message}</p> : null}
      {request.source ? <p className="live-elicitation-source">{request.source}</p> : null}
      {request.mode === "url" && request.url ? (
        <div className="live-elicitation-url">
          <code>{request.url}</code>
          {onOpenPath ? (
            <button
              type="button"
              className="drawer-toggle secondary"
              onClick={() => onOpenPath(request.url!)}
              disabled={isEditingDisabled}
            >
              Open
            </button>
          ) : null}
        </div>
      ) : null}
      {request.mode === "form" && request.fields.length > 0 ? (
        <div className="live-elicitation-form">
          {request.fields.map((field, index) => (
            <div key={field.name} className="live-elicitation-field" onFocusCapture={() => {
              if (answerFields.some((answerField) => answerField.name === field.name)) setAttachmentField(field.name);
            }}>
              <span className="live-elicitation-label" id={request.kind === "question" && field.description ? `${fieldIdPrefix}-description-${index}` : undefined}>
                {request.kind === "question" ? field.description || field.title : field.title}
                {field.required && request.kind !== "question" ? <strong> *</strong> : null}
              </span>
              {field.description && request.kind !== "question" ? (
                <span id={`${fieldIdPrefix}-description-${index}`} className="live-elicitation-description">
                  {field.description}
                </span>
              ) : null}
              {field.type === "text" ? (
                !field.secret && !field.format ? renderAnswerEditor(field, index, liveElicitationTextValue(fieldValues[field.name]),
                  (value) => setFieldValues((current) => ({ ...current, [field.name]: value })),
                ) : (
                  <input
                    type={field.secret ? "password" : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isEditingDisabled}
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
                  disabled={isEditingDisabled}
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
                    disabled={isEditingDisabled}
                  />
                  <span>Enabled</span>
                </span>
              ) : null}
              {field.type === "select" ? (
                field.allowFreeText ? (
                  <div className="live-elicitation-options" role="radiogroup" aria-label={field.title}>
                    {field.options.map((option) => (
                      <label key={option.value} className="live-elicitation-option">
                        <input type="radio" name={`${fieldIdPrefix}-${index}`} value={option.value}
                          checked={!customFields.includes(field.name) && fieldValues[field.name] === option.value}
                          onChange={() => {
                            setCustomFields((current) => current.filter((name) => name !== field.name));
                            setFieldValues((current) => ({ ...current, [field.name]: option.value }));
                          }} disabled={isEditingDisabled || attachingFields.has(field.name)} />
                        <span>{option.label}</span>
                      </label>
                    ))}
                    <div className="live-elicitation-option live-elicitation-custom-option">
                      <input type="radio" name={`${fieldIdPrefix}-${index}`} aria-label={`${field.title} Custom Answer`}
                        checked={customFields.includes(field.name)}
                        onChange={() => setCustomFields((current) => [...current.filter((name) => name !== field.name), field.name])}
                        disabled={isEditingDisabled || attachingFields.has(field.name)} />
                      {renderAnswerEditor(field, index, freeTextValues[field.name] ?? "", (value) => {
                        setCustomFields((current) => current.includes(field.name) ? current : [...current, field.name]);
                        setFreeTextValues((current) => ({ ...current, [field.name]: value }));
                      }, true)}
                    </div>
                  </div>
                ) : (
                  <select
                    aria-label={field.title}
                    aria-describedby={field.description ? `${fieldIdPrefix}-description-${index}` : undefined}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isEditingDisabled}
                  >
                    <option value="" disabled={field.required}>No Selection</option>
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
                          disabled={isEditingDisabled}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                  {field.allowFreeText ? renderAnswerEditor(field, index, freeTextValues[field.name] ?? "",
                    (value) => setFreeTextValues((current) => ({ ...current, [field.name]: value })), true) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {validationMessage ? <p className="live-approval-warning" role="alert">{validationMessage}</p> : null}
      <div className="live-approval-actions">
        {answerFields.length > 0 ? <div className="question-answer-attachment-actions" ref={setAttachmentTarget} /> : null}
        {isSubmitting ? <span className="visually-hidden" role="status">Processing input request</span> : null}
        {request.kind !== "question" ? <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("decline")}
          disabled={isActionPending}
          aria-busy={(isSubmitting && submittedAction === "decline") || undefined}
        >
          <ButtonContent busy={isSubmitting && submittedAction === "decline"}>Reject</ButtonContent>
        </button> : null}
        <button
          className={`drawer-toggle secondary${request.kind === "question" ? " composer-icon-button" : ""}`}
          type="button"
          aria-label="Close"
          title="Close"
          onClick={() => handleSubmit("cancel")}
          disabled={isActionPending}
          aria-busy={(isSubmitting && submittedAction === "cancel") || undefined}
        >
          <ButtonContent busy={isSubmitting && submittedAction === "cancel"}>
            {request.kind === "question" ? <><ComposerIcon name="close" /><span className="visually-hidden">Close</span></> : "Close"}
          </ButtonContent>
        </button>
        <button type="button" className={request.kind === "question" ? "composer-icon-button" : undefined}
          aria-label={request.mode === "url" ? "Complete" : "Submit"}
          title={request.mode === "url" ? "Complete" : "Submit"}
          onClick={() => handleSubmit("accept")} disabled={acceptDisabled} aria-busy={(isSubmitting && submittedAction === "accept") || undefined}>
          <ButtonContent busy={isSubmitting && submittedAction === "accept"}>
            {request.kind === "question" ? <><ComposerIcon name="send" /><span className="visually-hidden">Submit</span></> : request.mode === "url" ? "Complete" : "Submit"}
          </ButtonContent>
        </button>
      </div>
    </section>
  );
}

export function ElicitationRecords({ records, sourceText, responseProvider }: { records?: readonly ElicitationRecord[]; sourceText?: string; responseProvider?: string }) {
  const source = sourceText === undefined ? undefined : projectMessageRenderedSearchText(sourceText, responseProvider);
  // A complete block/list item represents an existing choice; a substring does not.
  const sourceChoices = new Set(sourceText === undefined ? [] : fromMarkdown(sourceText).children.flatMap((node) =>
    (node.type === "list" ? node.children : [node]).map((block) =>
      projectMessageRenderedSearchText(sourceText.slice(block.position?.start.offset, block.position?.end.offset), responseProvider).trim(),
    ),
  ));
  return records?.map((record) => {
    const fields = record.fields.map((field) => {
      const question = record.kind === "question" ? field.description || field.title : field.title;
      return {
        question: source?.includes(question) ? undefined : question,
        description: record.kind !== "question" ? field.description : undefined,
        options: field.options?.filter((option) => !sourceChoices.has(option.trim())),
      };
    }).filter((field) => field.question || field.description || field.options?.length);
    if (record.kind === "question" && fields.length === 0) return null;
    return (
      <div className="elicitation-record" key={record.requestId}>
        {record.kind !== "question" ? <p>{record.message}</p> : null}
        <div className="live-elicitation-form">
          {fields.map((field, index) => (
            <div className="live-elicitation-field" key={index}>
              {field.question ? <p>{field.question}</p> : null}
              {field.description ? <p>{field.description}</p> : null}
              {field.options?.length ? <ul className="elicitation-record-options">{field.options.map((option, optionIndex) => <li key={optionIndex}>{option}</li>)}</ul> : null}
            </div>
          ))}
        </div>
      </div>
    );
  });
}

export function InlineResponseContent({ text, records = [], requests = [], renderText, responseProvider, inlineContent, ...cardProps }: {
  text: string;
  responseProvider?: string;
  records?: readonly ElicitationRecord[];
  requests?: readonly LiveElicitationRequest[];
  inlineContent?: MessageInlineContent;
  renderText: (text: string, key: string, sourceStart: number, inlineContent?: MessageInlineContent) => ReactNode;
} & Omit<LiveElicitationCardProps, "request">) {
  const entries = records.map((record) => ({ record, request: requests.find((request) => request.requestId === record.requestId) }));
  for (const request of requests) {
    if (!entries.some((entry) => entry.record.requestId === request.requestId)) {
      entries.push({ request, record: { requestId: request.requestId, message: request.message, fields: [], status: "pending" } });
    }
  }
  const fragments: ReactNode[] = [];
  let offset = 0;
  let contentInserted = false;
  const appendText = (end: number, key: string) => {
    const content = inlineContent && !contentInserted && Math.min(inlineContent.position, text.length) <= end
      ? { ...inlineContent, position: Math.max(0, inlineContent.position - offset) } : undefined;
    if (content) contentInserted = true;
    if (end > offset || content) fragments.push(renderText(text.slice(offset, end), content?.key ?? key, offset, content));
  };
  for (const { record, request } of entries.sort((a, b) => (a.record.textRange?.start ?? text.length) - (b.record.textRange?.start ?? text.length))) {
    const range = record.textRange;
    const valid = range && range.start >= offset && range.end >= range.start && range.end <= text.length;
    // Keep the source body and supplement only question content absent from it.
    const sourceText = !request && valid && range.end > range.start ? text.slice(range.start, range.end) : undefined;
    const start = valid ? (sourceText !== undefined ? range.end : range.start) : text.length;
    const end = valid ? range.end : start;
    appendText(start, `text-${offset}-${start}-${record.requestId}`);
    fragments.push(<Fragment key={`${cardProps.sessionId ?? ""}:${record.requestId}`}>{request
      ? <LiveElicitationCard {...cardProps} request={request} />
      : <ElicitationRecords records={[record]} sourceText={sourceText} responseProvider={responseProvider} />}</Fragment>);
    offset = end;
  }
  appendText(text.length, `text-${offset}`);
  return <>{fragments}</>;
}

export type LiveRequestSurfaceProps = {
  sessionId?: string;
  workspacePath?: string | null;
  disabled?: boolean;
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

function LiveApprovalCard({
  request,
  approvalActionRequestId,
  approvalActionDecision,
  onResolveLiveApproval,
}: { request: LiveApprovalRequest } & Pick<LiveRequestSurfaceProps,
  "approvalActionRequestId" | "approvalActionDecision" | "onResolveLiveApproval">) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const isApprovalSubmitting = approvalActionRequestId === request.requestId;
  const approvalDecision = isApprovalSubmitting ? approvalActionDecision : null;
  const resolveApproval = (decision: "approve" | "deny") => {
    if (isApprovalSubmitting) return;
    onResolveLiveApproval(request, decision);
  };

  return (
    <section
      className="live-approval-card"
      role="group"
      aria-label="Approval required"
      aria-busy={isApprovalSubmitting || undefined}
    >
      <div className="live-approval-summary-row">
        <p className="live-approval-summary">{request.summary}</p>
        {request.details ? (
          <button
            className="artifact-toggle artifact-toggle-icon live-approval-details-toggle"
            type="button"
            onClick={() => setDetailsExpanded((expanded) => !expanded)}
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            aria-label={detailsExpanded ? "Hide approval details" : "Show approval details"}
            title={detailsExpanded ? "Hide details" : "Details"}
          >
            <span aria-hidden="true">{detailsExpanded ? "−" : "i"}</span>
          </button>
        ) : null}
      </div>
      {request.warning ? (
        <p className="live-approval-warning" role="alert">{request.warning}</p>
      ) : null}
      {request.details ? (
        <pre id={detailsId} className="live-approval-details" hidden={!detailsExpanded}>{request.details}</pre>
      ) : null}
      <div className="live-approval-actions">
        {isApprovalSubmitting ? <span className="visually-hidden" role="status">Processing approval request</span> : null}
        <button
          className="drawer-toggle live-approval-allow"
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
  );
}

export function LiveRequestSurface({
  sessionId,
  workspacePath,
  disabled,
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

  return (
    <>
      {liveApprovalRequest ? (
        <LiveApprovalCard
          key={liveApprovalRequest.requestId}
          request={liveApprovalRequest}
          approvalActionRequestId={approvalActionRequestId}
          approvalActionDecision={approvalActionDecision}
          onResolveLiveApproval={onResolveLiveApproval}
        />
      ) : null}
      <ElicitationRecords records={visibleRecords} />
      {requests.map((request) => (
        <LiveElicitationCard
          key={`${sessionId ?? ""}:${request.requestId}`}
          sessionId={sessionId}
          workspacePath={workspacePath}
          disabled={disabled}
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
