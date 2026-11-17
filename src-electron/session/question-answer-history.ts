import type { ElicitationRecord, LiveElicitationRequest, LiveElicitationResponse } from "../../src-shared/session/runtime-state.js";

/** Project only answers that correspond to the submitted values, never secret fields. */
export function questionAnswerHistory(
  request: LiveElicitationRequest,
  response: LiveElicitationResponse,
): Array<ElicitationRecord["fields"][number]["answer"]> | undefined {
  if (request.kind !== "question" || request.retainQuestionAnswer === false || response.action !== "accept") return undefined;
  return request.fields.map((field) => {
    if (field.type === "text" && field.secret) return undefined;
    const answer = response.answerPresentation?.[field.name];
    const submitted = response.content?.[field.name];
    if (!answer || !Array.isArray(answer.selected) || !Array.isArray(answer.text)
      || !answer.text.every((value) => typeof value === "string")) return undefined;
    const options = field.type === "select" || field.type === "multi-select" ? field.options : [];
    if (!answer.selected.every((index) => Number.isSafeInteger(index) && index >= 0 && index < options.length)
      || new Set(answer.selected).size !== answer.selected.length) return undefined;
    const values = [...answer.selected.map((index) => options[index].value), ...answer.text];
    const original = Array.isArray(submitted) ? submitted : typeof submitted === "string" || typeof submitted === "number" || typeof submitted === "boolean" ? [String(submitted)] : [];
    const normalizedValues = [...values].sort();
    const normalizedOriginal = [...original].sort();
    if (normalizedValues.length !== normalizedOriginal.length || normalizedValues.some((value, index) => value !== normalizedOriginal[index])) return undefined;
    return { selected: [...answer.selected], text: request.delivery === "user-message" ? answer.text.map((value) => value.trim()) : [...answer.text] };
  });
}
