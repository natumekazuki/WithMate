import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { projectMessageRenderedSearchText } from "../../../src-shared/session/message-search.js";
import { isValidCodexElicitationField } from "../../../src-shared/session/codex-elicitation-validation.js";
import { ButtonContent } from "../../ui/button-content.js";
import { ComposerIcon } from "../composer/composer-icon.js";
import { QuestionAnswerEditor } from "./question-answer-editor.js";
import type { MessageInlineContent } from "../../ui/markdown/MessageRichText.js";

import type {
  LiveApprovalRequest,
  LiveElicitationField,
  LiveElicitationMultiSelectField,
  LiveElicitationRequest,
  LiveElicitationResponse,
  ElicitationRecord,
} from "../../../src-shared/session/runtime-state.js";

/** 質問フォームの編集中と送信時に扱う、対応する入力型の値。 */
type LiveElicitationFieldValue = string | number | boolean | string[];
/** 再描画でカードが外れても復元できる、要求IDごとの値と自由入力の選択状態。 */
export type LiveElicitationDrafts = Map<
  string,
  {
    fieldValues: Record<string, LiveElicitationFieldValue>;
    freeTextValues: Record<string, string>;
    customFields?: string[];
  }
>;
/** 応答に含める項目名と値の組。 */
type LiveElicitationContentEntry = readonly [string, LiveElicitationFieldValue];

/** 質問の既定値を優先し、未設定なら項目型に合う初期値を返す。 */
function createLiveElicitationFieldValue(
  field: LiveElicitationField,
): LiveElicitationFieldValue {
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

/** 質問を開いたときに使う項目名ごとの初期値を作る。 */
function createLiveElicitationFormState(
  request: LiveElicitationRequest,
): Record<string, LiveElicitationFieldValue> {
  return Object.fromEntries(
    request.fields.map((field) => [
      field.name,
      createLiveElicitationFieldValue(field),
    ]),
  );
}

/** 項目の型に応じて必須、長さ、数値範囲などの条件を確認し、最初の違反を返す。 */
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
      if (
        field.minLength !== undefined &&
        normalized.length < field.minLength
      ) {
        return `${field.title} must be at least ${field.minLength} characters.`;
      }
      if (
        field.maxLength !== undefined &&
        normalized.length > field.maxLength
      ) {
        return `${field.title} must be at most ${field.maxLength} characters.`;
      }
      return null;
    }
    case "select": {
      const text = typeof value === "string" ? value : "";
      if (field.required && !text.trim()) {
        return field.allowFreeText
          ? `Enter ${field.title}.`
          : `Select ${field.title}.`;
      }
      if (!field.required && !text.trim()) return null;
      if (field.minLength !== undefined && text.length < field.minLength)
        return `${field.title} must be at least ${field.minLength} characters.`;
      if (field.maxLength !== undefined && text.length > field.maxLength)
        return `${field.title} must be at most ${field.maxLength} characters.`;
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
        return `Enter a valid email address for ${field.title}.`;
      if (field.format === "uri" && !URL.canParse(text))
        return `Enter a valid URI for ${field.title}.`;
      if (field.format === "date") {
        const date = new Date(`${text}T00:00:00.000Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !== text
        )
          return `Enter a valid date for ${field.title}.`;
      }
      if (
        field.format === "date-time" &&
        Number.isNaN(new Date(text).getTime())
      )
        return `Enter a valid date and time for ${field.title}.`;
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

/** 要求に含まれる項目だけから応答を作り、省略可能な空欄と型の合わない値を除く。 */
function buildLiveElicitationResponseContent(
  request: LiveElicitationRequest,
  fieldValues: Record<string, LiveElicitationFieldValue>,
): Record<string, LiveElicitationFieldValue> {
  const entries = request.fields.flatMap<LiveElicitationContentEntry>(
    (field) => {
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
    },
  );

  return Object.fromEntries(entries);
}

/** Codex フォームの制約を用い、違反があれば値を修正するための文を返す。 */
function codexFormFieldError(
  field: LiveElicitationField,
  value: LiveElicitationFieldValue | undefined,
): string | null {
  if (isValidCodexElicitationField(field, value)) return null;
  if (value === undefined) return `${field.title} is required.`;
  if (field.type === "text" && typeof value === "string") {
    if (field.required && !value.trim()) return `${field.title} is required.`;
    const length = [...value].length;
    if (field.minLength !== undefined && length < field.minLength)
      return `${field.title} must be at least ${field.minLength} characters.`;
    if (field.maxLength !== undefined && length > field.maxLength)
      return `${field.title} must be at most ${field.maxLength} characters.`;
    if (field.format === "date-time")
      return `Enter ${field.title} as an ISO date and time with a time zone (Z or +09:00).`;
    if (field.format === "date")
      return `Enter a valid date (YYYY-MM-DD) for ${field.title}.`;
    if (field.format === "email")
      return `Enter a valid email address for ${field.title}.`;
    if (field.format === "uri") return `Enter a valid URI for ${field.title}.`;
  }
  return (
    validateLiveElicitationField(field, value) ??
    `Enter a valid answer for ${field.title}.`
  );
}

/** テキスト入力欄には文字列だけを渡し、それ以外は空欄として扱う。 */
function liveElicitationTextValue(
  value: LiveElicitationFieldValue | undefined,
): string {
  return typeof value === "string" ? value : "";
}

/** 複数選択欄の値が配列でない場合は未選択として扱う。 */
function liveElicitationMultiSelectValue(
  value: LiveElicitationFieldValue | undefined,
): string[] {
  return Array.isArray(value) ? value : [];
}

/** 自由入力を許す場合は、候補にない既定値も個別に編集できる選択肢として追加する。 */
function liveElicitationMultiSelectOptions(
  field: LiveElicitationMultiSelectField,
) {
  const options = [...field.options];
  if (field.allowFreeText) {
    for (const value of field.defaultValue ?? []) {
      if (!options.some((option) => option.value === value))
        options.push({ value, label: value });
    }
  }
  return options;
}

/** 複数選択を許す自由入力欄について、空白を除いた非重複の自由回答を末尾に加える。 */
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
    answers[field.name] =
      freeText && !selected.includes(freeText)
        ? [...selected, freeText]
        : selected;
  }
  return answers;
}

/** 一つの質問の表示・送信状態、回答の下書き、添付の宛先。 */
type LiveElicitationCardProps = {
  sessionId?: string;
  workspacePath?: string | null;
  disabled?: boolean;
  request: LiveElicitationRequest;
  elicitationActionRequestId: string | null;
  elicitationAction?: LiveElicitationResponse["action"] | null;
  onResolveLiveElicitation: (
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ) => void;
  onOpenPath?: (target: string) => void;
  inputAvailable?: boolean;
  drafts?: LiveElicitationDrafts;
};

/** 質問の既定値または下書きを編集できる形で表示し、回答・拒否・取り消しを扱う。 */
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
  const customDefaults = Object.fromEntries(
    request.fields.flatMap((field) =>
      field.type === "select" &&
      field.allowFreeText &&
      field.defaultValue !== undefined &&
      !field.options.some((option) => option.value === field.defaultValue)
        ? [[field.name, field.defaultValue]]
        : [],
    ),
  );
  const [fieldValues, setFieldValues] = useState<
    Record<string, LiveElicitationFieldValue>
  >(
    () =>
      drafts?.get(request.requestId)?.fieldValues ??
      createLiveElicitationFormState(request),
  );
  const [freeTextValues, setFreeTextValues] = useState<Record<string, string>>(
    () => drafts?.get(request.requestId)?.freeTextValues ?? customDefaults,
  );
  const [customFields, setCustomFields] = useState<string[]>(
    () =>
      drafts?.get(request.requestId)?.customFields ??
      Object.keys(customDefaults),
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const pendingAttachments = useRef(new Set<string>());
  const [attachingFields, setAttachingFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const answerFields =
    request.mode === "form"
      ? request.fields.filter((field) =>
          field.type === "text"
            ? !field.secret && !field.format
            : (field.type === "select" || field.type === "multi-select") &&
              field.allowFreeText,
        )
      : [];
  const [attachmentField, setAttachmentField] = useState(
    () => answerFields[0]?.name,
  );
  const [attachmentTarget, setAttachmentTarget] =
    useState<HTMLDivElement | null>(null);
  const fieldIdPrefix = useId();

  useEffect(() => {
    drafts?.set(request.requestId, {
      fieldValues,
      freeTextValues,
      customFields,
    });
  }, [drafts, request.requestId, fieldValues, freeTextValues, customFields]);

  const isSubmitting = elicitationActionRequestId === request.requestId;
  const submittedAction = isSubmitting ? elicitationAction : null;
  const isActionPending = disabled || elicitationActionRequestId !== null;
  const isEditingDisabled = disabled || isSubmitting;
  const acceptDisabled =
    isActionPending ||
    attachingFields.size > 0 ||
    (request.delivery === "user-message" && !inputAvailable);

  /** 添付と回答待機を検査し、回答送信では検証した値と表示用の選択・自由回答を区別して渡す。 */
  const handleSubmit = (action: LiveElicitationResponse["action"]) => {
    if (
      isActionPending ||
      (action === "accept" &&
        (acceptDisabled || pendingAttachments.current.size > 0))
    )
      return;
    if (action === "accept") {
      const answers = mergeFreeTextAnswers(
        request,
        fieldValues,
        freeTextValues,
      );
      for (const field of request.fields) {
        if (
          field.type === "select" &&
          field.allowFreeText &&
          customFields.includes(field.name)
        )
          answers[field.name] = freeTextValues[field.name] ?? "";
      }
      const content = buildLiveElicitationResponseContent(request, answers);
      const codexForm =
        request.provider === "codex" && request.kind !== "question";
      for (const field of request.fields) {
        const validation = codexForm
          ? codexFormFieldError(
              field,
              Object.hasOwn(content, field.name)
                ? content[field.name]
                : undefined,
            )
          : validateLiveElicitationField(field, answers[field.name] ?? "");
        if (validation) {
          setValidationMessage(validation);
          return;
        }
      }

      setValidationMessage(null);
      const answerEntries: Array<
        [string, { selected: number[]; text: string[] }]
      > = [];
      if (request.kind === "question")
        for (const field of request.fields) {
          if (
            field.type === "text" &&
            !field.secret &&
            typeof content[field.name] === "string"
          ) {
            answerEntries.push([
              field.name,
              { selected: [], text: [content[field.name] as string] },
            ]);
          } else if (
            (field.type === "number" &&
              typeof content[field.name] === "number") ||
            (field.type === "boolean" &&
              typeof content[field.name] === "boolean")
          ) {
            answerEntries.push([
              field.name,
              { selected: [], text: [String(content[field.name])] },
            ]);
          } else if (
            field.type === "select" &&
            typeof content[field.name] === "string"
          ) {
            const value = content[field.name] as string;
            const index = customFields.includes(field.name)
              ? -1
              : field.options.findIndex((option) => option.value === value);
            answerEntries.push([
              field.name,
              {
                selected: index < 0 ? [] : [index],
                text: index < 0 ? [value] : [],
              },
            ]);
          } else if (
            field.type === "multi-select" &&
            Array.isArray(content[field.name])
          ) {
            const values = liveElicitationMultiSelectValue(
              fieldValues[field.name],
            );
            const selected = values.flatMap((value) => {
              const index = field.options.findIndex(
                (option) => option.value === value,
              );
              return index < 0 ? [] : [index];
            });
            const text = (content[field.name] as string[]).filter(
              (value) =>
                !values.includes(value) ||
                !field.options.some((option) => option.value === value),
            );
            answerEntries.push([field.name, { selected, text }]);
          }
        }
      onResolveLiveElicitation(request, {
        action,
        ...(Object.keys(content).length > 0 ? { content } : {}),
        ...(answerEntries.length > 0
          ? { answerPresentation: Object.fromEntries(answerEntries) }
          : {}),
      });
      return;
    }

    setValidationMessage(null);
    onResolveLiveElicitation(request, { action });
  };

  /** 自由記述欄の添付先を現在の項目に接続し、添付中の項目を送信制御へ伝える。 */
  const renderAnswerEditor = (
    field: LiveElicitationField,
    index: number,
    value: string,
    onChange: (value: string) => void,
    custom = false,
  ) => (
    <QuestionAnswerEditor
      label={custom ? `${field.title} Custom Answer` : field.title}
      describedBy={
        field.description ? `${fieldIdPrefix}-description-${index}` : undefined
      }
      value={value}
      onChange={onChange}
      disabled={isEditingDisabled}
      sessionId={sessionId}
      workspacePath={workspacePath}
      attachmentTarget={
        attachmentField === field.name ? attachmentTarget : null
      }
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
      data-live-request-id={request.requestId}
      role="group"
      aria-label={
        request.blocking === false ? "Input requested" : "Input required"
      }
      aria-busy={isSubmitting || undefined}
    >
      {request.kind !== "question" ? (
        <p className="live-elicitation-message">{request.message}</p>
      ) : null}
      {request.source ? (
        <p className="live-elicitation-source">{request.source}</p>
      ) : null}
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
            <div
              key={field.name}
              className="live-elicitation-field"
              onFocusCapture={() => {
                if (
                  answerFields.some(
                    (answerField) => answerField.name === field.name,
                  )
                )
                  setAttachmentField(field.name);
              }}
            >
              <span
                className="live-elicitation-label"
                id={
                  request.kind === "question" && field.description
                    ? `${fieldIdPrefix}-description-${index}`
                    : undefined
                }
              >
                {request.kind === "question"
                  ? field.description || field.title
                  : field.title}
                {field.required && request.kind !== "question" ? (
                  <strong> *</strong>
                ) : null}
              </span>
              {field.description && request.kind !== "question" ? (
                <span
                  id={`${fieldIdPrefix}-description-${index}`}
                  className="live-elicitation-description"
                >
                  {field.description}
                </span>
              ) : null}
              {field.type === "text" ? (
                !field.secret && !field.format ? (
                  renderAnswerEditor(
                    field,
                    index,
                    liveElicitationTextValue(fieldValues[field.name]),
                    (value) =>
                      setFieldValues((current) => ({
                        ...current,
                        [field.name]: value,
                      })),
                  )
                ) : (
                  <input
                    type={
                      field.secret
                        ? "password"
                        : field.format === "email"
                          ? "email"
                          : field.format === "uri"
                            ? "url"
                            : field.format === "date"
                              ? "date"
                              : "text"
                    }
                    aria-label={field.title}
                    aria-describedby={
                      field.description
                        ? `${fieldIdPrefix}-description-${index}`
                        : undefined
                    }
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) =>
                      setFieldValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    disabled={isEditingDisabled}
                  />
                )
              ) : null}
              {field.type === "number" ? (
                <input
                  type="number"
                  aria-label={field.title}
                  aria-describedby={
                    field.description
                      ? `${fieldIdPrefix}-description-${index}`
                      : undefined
                  }
                  step={field.numberKind === "integer" ? "1" : "any"}
                  value={
                    typeof fieldValues[field.name] === "number"
                      ? String(fieldValues[field.name])
                      : ""
                  }
                  onChange={(event) =>
                    setFieldValues((current) => ({
                      ...current,
                      [field.name]:
                        event.target.value === ""
                          ? ""
                          : Number(event.target.value),
                    }))
                  }
                  disabled={isEditingDisabled}
                />
              ) : null}
              {field.type === "boolean" ? (
                <span className="live-elicitation-checkbox">
                  <input
                    type="checkbox"
                    aria-label={field.title}
                    aria-describedby={
                      field.description
                        ? `${fieldIdPrefix}-description-${index}`
                        : undefined
                    }
                    checked={fieldValues[field.name] === true}
                    onChange={(event) =>
                      setFieldValues((current) => ({
                        ...current,
                        [field.name]: event.target.checked,
                      }))
                    }
                    disabled={isEditingDisabled}
                  />
                  <span>Enabled</span>
                </span>
              ) : null}
              {field.type === "select" ? (
                field.allowFreeText ? (
                  <div
                    className="live-elicitation-options"
                    role="radiogroup"
                    aria-label={field.title}
                  >
                    {field.options.map((option) => (
                      <label
                        key={option.value}
                        className="live-elicitation-option"
                      >
                        <input
                          type="radio"
                          name={`${fieldIdPrefix}-${index}`}
                          value={option.value}
                          checked={
                            !customFields.includes(field.name) &&
                            fieldValues[field.name] === option.value
                          }
                          onChange={() => {
                            setCustomFields((current) =>
                              current.filter((name) => name !== field.name),
                            );
                            setFieldValues((current) => ({
                              ...current,
                              [field.name]: option.value,
                            }));
                          }}
                          disabled={
                            isEditingDisabled || attachingFields.has(field.name)
                          }
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                    <div className="live-elicitation-option live-elicitation-custom-option">
                      <input
                        type="radio"
                        name={`${fieldIdPrefix}-${index}`}
                        aria-label={`${field.title} Custom Answer`}
                        checked={customFields.includes(field.name)}
                        onChange={() =>
                          setCustomFields((current) => [
                            ...current.filter((name) => name !== field.name),
                            field.name,
                          ])
                        }
                        disabled={
                          isEditingDisabled || attachingFields.has(field.name)
                        }
                      />
                      {renderAnswerEditor(
                        field,
                        index,
                        freeTextValues[field.name] ?? "",
                        (value) => {
                          setCustomFields((current) =>
                            current.includes(field.name)
                              ? current
                              : [...current, field.name],
                          );
                          setFreeTextValues((current) => ({
                            ...current,
                            [field.name]: value,
                          }));
                        },
                        true,
                      )}
                    </div>
                  </div>
                ) : (
                  <select
                    aria-label={field.title}
                    aria-describedby={
                      field.description
                        ? `${fieldIdPrefix}-description-${index}`
                        : undefined
                    }
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) =>
                      setFieldValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    disabled={isEditingDisabled}
                  >
                    <option value="" disabled={field.required}>
                      No Selection
                    </option>
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
                  aria-describedby={
                    field.description
                      ? `${fieldIdPrefix}-description-${index}`
                      : undefined
                  }
                >
                  {liveElicitationMultiSelectOptions(field).map((option) => {
                    const selectedValues = liveElicitationMultiSelectValue(
                      fieldValues[field.name],
                    );
                    const checked = selectedValues.includes(option.value);
                    return (
                      <label
                        key={option.value}
                        className="live-elicitation-option"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setFieldValues((current) => {
                              const currentValues =
                                liveElicitationMultiSelectValue(
                                  current[field.name],
                                );
                              return {
                                ...current,
                                [field.name]: event.target.checked
                                  ? [...currentValues, option.value]
                                  : currentValues.filter(
                                      (value) => value !== option.value,
                                    ),
                              };
                            });
                          }}
                          disabled={isEditingDisabled}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                  {field.allowFreeText
                    ? renderAnswerEditor(
                        field,
                        index,
                        freeTextValues[field.name] ?? "",
                        (value) =>
                          setFreeTextValues((current) => ({
                            ...current,
                            [field.name]: value,
                          })),
                        true,
                      )
                    : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {validationMessage ? (
        <p className="live-approval-warning" role="alert">
          {validationMessage}
        </p>
      ) : null}
      <div className="live-approval-actions">
        {answerFields.length > 0 ? (
          <div
            className="question-answer-attachment-actions"
            ref={setAttachmentTarget}
          />
        ) : null}
        {isSubmitting ? (
          <span className="visually-hidden" role="status">
            Processing input request
          </span>
        ) : null}
        {request.kind !== "question" ? (
          <button
            className="drawer-toggle secondary"
            type="button"
            onClick={() => handleSubmit("decline")}
            disabled={isActionPending}
            aria-busy={
              (isSubmitting && submittedAction === "decline") || undefined
            }
          >
            <ButtonContent busy={isSubmitting && submittedAction === "decline"}>
              Reject
            </ButtonContent>
          </button>
        ) : null}
        <button
          className={`drawer-toggle secondary${request.kind === "question" ? " composer-icon-button" : ""}`}
          type="button"
          aria-label="Close"
          title="Close"
          onClick={() => handleSubmit("cancel")}
          disabled={isActionPending}
          aria-busy={
            (isSubmitting && submittedAction === "cancel") || undefined
          }
        >
          <ButtonContent busy={isSubmitting && submittedAction === "cancel"}>
            {request.kind === "question" ? (
              <>
                <ComposerIcon name="close" />
                <span className="visually-hidden">Close</span>
              </>
            ) : (
              "Close"
            )}
          </ButtonContent>
        </button>
        <button
          type="button"
          className={
            request.kind === "question" ? "composer-icon-button" : undefined
          }
          aria-label={request.mode === "url" ? "Complete" : "Submit"}
          title={request.mode === "url" ? "Complete" : "Submit"}
          onClick={() => handleSubmit("accept")}
          disabled={acceptDisabled}
          aria-busy={
            (isSubmitting && submittedAction === "accept") || undefined
          }
        >
          <ButtonContent busy={isSubmitting && submittedAction === "accept"}>
            {request.kind === "question" ? (
              <>
                <ComposerIcon name="send" />
                <span className="visually-hidden">Submit</span>
              </>
            ) : request.mode === "url" ? (
              "Complete"
            ) : (
              "Submit"
            )}
          </ButtonContent>
        </button>
      </div>
    </section>
  );
}

/** 解決済みの質問と回答を表示し、本文がすでに担う質問文や選択肢の重複を省く。 */
export function ElicitationRecords({
  records,
  sourceText,
  responseProvider,
  highlightedChoices,
}: {
  records?: readonly ElicitationRecord[];
  sourceText?: string;
  responseProvider?: string;
  highlightedChoices?: ReadonlySet<string>;
}) {
  const source =
    sourceText === undefined
      ? undefined
      : projectMessageRenderedSearchText(sourceText, responseProvider);
  // ブロックまたはリスト項目全体が一致するときだけ既存の選択肢とみなす。部分文字列の一致は含めない。
  const sourceChoices = new Set(
    sourceText === undefined
      ? []
      : fromMarkdown(sourceText).children.flatMap((node) =>
          (node.type === "list" ? node.children : [node]).map((block) =>
            projectMessageRenderedSearchText(
              sourceText.slice(
                block.position?.start.offset,
                block.position?.end.offset,
              ),
              responseProvider,
            ).trim(),
          ),
        ),
  );
  return records?.map((record) => {
    const fields = record.fields
      .map((field) => {
        const question =
          record.kind === "question"
            ? field.description || field.title
            : field.title;
        return {
          question: source?.includes(question) ? undefined : question,
          description:
            record.kind !== "question" ? field.description : undefined,
          options: field.options
            ?.map((option, index) => ({
              label: option,
              selected: field.answer?.selected.includes(index) ?? false,
            }))
            .filter(
              (option) =>
                !sourceChoices.has(option.label.trim()) ||
                (option.selected &&
                  !highlightedChoices?.has(option.label.trim())),
            ),
          answerText: field.answer?.text ?? [],
        };
      })
      .filter(
        (field) =>
          field.question ||
          field.description ||
          field.options?.length ||
          field.answerText.length,
      );
    if (record.kind === "question" && fields.length === 0) return null;
    return (
      <div className="elicitation-record" key={record.requestId}>
        {record.kind !== "question" ? <p>{record.message}</p> : null}
        <div className="live-elicitation-form">
          {fields.map((field, index) => (
            <div className="live-elicitation-field" key={index}>
              {field.question ? <p>{field.question}</p> : null}
              {field.description ? <p>{field.description}</p> : null}
              {field.options?.length ? (
                <ul className="elicitation-record-options">
                  {field.options.map((option, optionIndex) => (
                    <li
                      key={optionIndex}
                      className={
                        option.selected
                          ? "elicitation-record-selected"
                          : undefined
                      }
                    >
                      {option.selected ? (
                        <>
                          <span aria-hidden="true">✓ </span>
                          <span className="visually-hidden">Selected: </span>
                        </>
                      ) : null}
                      {option.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {field.answerText.map((answer, answerIndex) => (
                <p className="elicitation-record-answer" key={answerIndex}>
                  <span className="visually-hidden">Answer: </span>
                  {answer}
                </p>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  });
}

/** 回答で選ばれた候補が本文の単一ブロックと完全一致する場合だけ、その強調範囲を返す。 */
function selectedSourceRanges(
  source: string,
  record: ElicitationRecord,
  responseProvider?: string,
) {
  const blocks = fromMarkdown(source).children.flatMap((node) =>
    node.type === "list" ? node.children : [node],
  );
  const selected = new Set(
    record.fields.flatMap(
      (field) =>
        field.answer?.selected
          .map((index) => field.options?.[index]?.trim())
          .filter((value): value is string => Boolean(value)) ?? [],
    ),
  );
  const ranges: Array<{ start: number; end: number }> = [];
  const labels = new Set<string>();
  for (const value of selected) {
    const matches = blocks.filter(
      (block) =>
        block.position &&
        projectMessageRenderedSearchText(
          source.slice(block.position.start.offset, block.position.end.offset),
          responseProvider,
        ).trim() === value,
    );
    if (
      matches.length !== 1 ||
      matches[0].position?.start.offset === undefined ||
      matches[0].position?.end.offset === undefined
    )
      continue;
    ranges.push({
      start: matches[0].position.start.offset,
      end: matches[0].position.end.offset,
    });
    labels.add(value);
  }
  return { ranges, labels };
}

/** 未解決の質問を対応する本文範囲に置き、解決後は本文を戻して記録で不足部分を補う。 */
export function InlineResponseContent({
  text,
  records = [],
  requests = [],
  renderText,
  responseProvider,
  inlineContent,
  ...cardProps
}: {
  text: string;
  responseProvider?: string;
  records?: readonly ElicitationRecord[];
  requests?: readonly LiveElicitationRequest[];
  inlineContent?: MessageInlineContent | readonly MessageInlineContent[];
  renderText: (
    text: string,
    key: string,
    sourceStart: number,
    inlineContent?: readonly MessageInlineContent[],
    selectedRanges?: Array<{ start: number; end: number }>,
  ) => ReactNode;
} & Omit<LiveElicitationCardProps, "request">) {
  const entries = records.map((record) => ({
    record,
    request: requests.find((request) => request.requestId === record.requestId),
  }));
  for (const request of requests) {
    if (
      !entries.some((entry) => entry.record.requestId === request.requestId)
    ) {
      entries.push({
        request,
        record: {
          requestId: request.requestId,
          message: request.message,
          fields: [],
          status: "pending",
        },
      });
    }
  }
  const fragments: ReactNode[] = [];
  let offset = 0;
  const contents = (
    inlineContent
      ? Array.isArray(inlineContent)
        ? inlineContent
        : [inlineContent as MessageInlineContent]
      : []
  )
    .slice()
    .sort((a, b) => a.position - b.position);
  let nextContent = 0;
  /** 本文を現在の区間で描画し、挿入要素と選択強調の位置を区間内の座標へ変換する。 */
  const appendText = (
    end: number,
    key: string,
    selectedRanges?: Array<{ start: number; end: number }>,
  ) => {
    const selected: MessageInlineContent[] = [];
    while (
      nextContent < contents.length &&
      Math.min(contents[nextContent].position, text.length) <= end
    ) {
      const content = contents[nextContent++];
      selected.push({
        ...content,
        position: Math.max(0, content.position - offset),
      });
    }
    const owner =
      selected.find((content) => content.stableOwner) ?? selected[0];
    if (end > offset || selected.length)
      fragments.push(
        renderText(
          text.slice(offset, end),
          owner?.key ?? key,
          offset,
          selected.length ? selected : undefined,
          selectedRanges?.map((range) => ({
            start: range.start - offset,
            end: range.end - offset,
          })),
        ),
      );
  };
  for (const { record, request } of entries.sort(
    (a, b) =>
      (a.record.textRange?.start ?? text.length) -
      (b.record.textRange?.start ?? text.length),
  )) {
    const range = record.textRange;
    const valid =
      range &&
      range.start >= offset &&
      range.end >= range.start &&
      range.end <= text.length;
    // 元の本文を残し、そこにない質問内容だけを補う。
    const sourceText =
      !request && valid && range.end > range.start
        ? text.slice(range.start, range.end)
        : undefined;
    const selected =
      sourceText !== undefined
        ? selectedSourceRanges(sourceText, record, responseProvider)
        : undefined;
    const start = valid
      ? sourceText !== undefined
        ? range.end
        : range.start
      : text.length;
    const end = valid ? range.end : start;
    appendText(
      start,
      `text-${offset}-${start}-${record.requestId}`,
      selected?.ranges.map((entry) => ({
        start: entry.start + range!.start,
        end: entry.end + range!.start,
      })),
    );
    fragments.push(
      <Fragment key={`${cardProps.sessionId ?? ""}:${record.requestId}`}>
        {request ? (
          <LiveElicitationCard {...cardProps} request={request} />
        ) : (
          <ElicitationRecords
            records={[record]}
            sourceText={sourceText}
            responseProvider={responseProvider}
            highlightedChoices={selected?.labels}
          />
        )}
      </Fragment>,
    );
    offset = end;
  }
  appendText(text.length, `text-${offset}`);
  return <>{fragments}</>;
}

/** 現在の承認と質問、質問記録、および操作を実行機能へ渡すための設定。 */
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
  onResolveLiveApproval: (
    request: LiveApprovalRequest,
    decision: "approve" | "deny",
  ) => void;
  onResolveLiveElicitation: (
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ) => void;
  onOpenPath?: (target: string) => void;
};

/** 承認の概要と詳細を表示し、処理中も内容を残したまま送信操作を止める。 */
function LiveApprovalCard({
  request,
  approvalActionRequestId,
  approvalActionDecision,
  onResolveLiveApproval,
}: { request: LiveApprovalRequest } & Pick<
  LiveRequestSurfaceProps,
  "approvalActionRequestId" | "approvalActionDecision" | "onResolveLiveApproval"
>) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const isApprovalSubmitting = approvalActionRequestId === request.requestId;
  const approvalDecision = isApprovalSubmitting ? approvalActionDecision : null;
  /** 要求の処理がすでに進行中でなければ、許可または拒否を実行機能へ渡す。 */
  const resolveApproval = (decision: "approve" | "deny") => {
    if (isApprovalSubmitting) return;
    onResolveLiveApproval(request, decision);
  };

  return (
    <section
      className="live-approval-card"
      data-live-request-id={request.requestId}
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
            aria-label={
              detailsExpanded
                ? "Hide approval details"
                : "Show approval details"
            }
            title={detailsExpanded ? "Hide details" : "Details"}
          >
            <span aria-hidden="true">{detailsExpanded ? "−" : "i"}</span>
          </button>
        ) : null}
      </div>
      {request.warning ? (
        <p className="live-approval-warning" role="alert">
          {request.warning}
        </p>
      ) : null}
      {request.details ? (
        <pre
          id={detailsId}
          className="live-approval-details"
          hidden={!detailsExpanded}
        >
          {request.details}
        </pre>
      ) : null}
      <div className="live-approval-actions">
        {isApprovalSubmitting ? (
          <span className="visually-hidden" role="status">
            Processing approval request
          </span>
        ) : null}
        <button
          className="drawer-toggle live-approval-allow"
          type="button"
          onClick={() => resolveApproval("approve")}
          disabled={isApprovalSubmitting}
          aria-busy={approvalDecision === "approve" || undefined}
        >
          <ButtonContent busy={approvalDecision === "approve"}>
            Allow Once
          </ButtonContent>
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => resolveApproval("deny")}
          disabled={isApprovalSubmitting}
          aria-busy={approvalDecision === "deny" || undefined}
        >
          <ButtonContent busy={approvalDecision === "deny"}>
            Reject
          </ButtonContent>
        </button>
      </div>
    </section>
  );
}

/** 承認と質問を描画し、同じ要求の入力フォームと回答記録を重複表示しない。 */
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
  const requests =
    liveElicitationRequests ??
    (liveElicitationRequest ? [liveElicitationRequest] : []);
  const visibleRecords = elicitationRecords?.filter(
    (record) =>
      !requests.some((request) => request.requestId === record.requestId),
  );

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
