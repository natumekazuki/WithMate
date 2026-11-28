import type { SessionEvent } from "@github/copilot-sdk";
import type {
  LiveElicitationField,
  LiveElicitationRequest,
} from "../../../src-shared/session/runtime-state.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

/** スキーマの名前付きプロパティ集合として、配列と null を除いたオブジェクトを受け付ける。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** SDK の質問を必須回答欄一つに変換する。候補があれば選択欄とし、自由入力は明示的に禁止されていなければ許す。 */
export function buildLiveElicitationRequestFromCopilotUserInput(
  providerId: string,
  event: Extract<SessionEvent, { type: "user_input.requested" }>,
): LiveElicitationRequest {
  const { requestId, question, choices, allowFreeform } = event.data;
  const field = { name: "answer", title: question, required: true };
  return {
    requestId,
    provider: providerId,
    kind: "question",
    mode: "form",
    message: question,
    fields: choices?.length
      ? [
          {
            ...field,
            type: "select",
            options: choices.map((value) => ({ value, label: value })),
            allowFreeText: allowFreeform !== false,
          },
        ]
      : [{ ...field, type: "text" }],
  };
}

/** URL とフォームの要求を区別し、フォームに表現できないフィールドがあれば要求全体を投影しない。 */
export function buildLiveElicitationRequestFromCopilotEvent(
  providerId: string,
  event: Extract<SessionEvent, { type: "elicitation.requested" }>,
): LiveElicitationRequest | null {
  const requiredNames = new Set(
    Array.isArray(event.data.requestedSchema?.required)
      ? event.data.requestedSchema.required
      : [],
  );
  const properties = isRecord(event.data.requestedSchema?.properties)
    ? event.data.requestedSchema.properties
    : {};
  const fields: LiveElicitationField[] = [];
  if (event.data.mode !== "url") {
    for (const [name, schema] of Object.entries(properties)) {
      const field = buildLiveElicitationFieldFromMcpSchema(
        name,
        schema,
        requiredNames.has(name),
      );
      if (!field) return null;
      fields.push(field);
    }
  }
  return {
    requestId: event.data.requestId,
    provider: providerId,
    mode: event.data.mode === "url" ? "url" : "form",
    message: event.data.message,
    source: event.data.elicitationSource,
    fields,
    url: typeof event.data.url === "string" ? event.data.url : undefined,
  };
}
