import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";

const VALID_RENDERER_LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
const MAX_RENDERER_LOG_KIND_LENGTH = 128;
const MAX_RENDERER_LOG_MESSAGE_LENGTH = 4096;
const MAX_RENDERER_LOG_URL_LENGTH = 2048;
const MAX_RENDERER_LOG_STRING_LENGTH = 2048;
const MAX_RENDERER_LOG_OBJECT_KEYS = 50;
const MAX_RENDERER_LOG_ARRAY_ITEMS = 50;
const MAX_RENDERER_LOG_DEPTH = 4;

/** renderer が送った値のうち、検証とサイズ制限を経てログに渡せる内容。 */
export type SanitizedRendererLogInput = {
  level: RendererLogInput["level"];
  kind: string;
  message: string;
  correlationId?: string;
  url?: string;
  data?: unknown;
  error?: RendererLogInput["error"];
};

/** ログ用の文字列を指定の UTF-16 コード単位数以内に収める。省略記号は追加しない。 */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** renderer の付加データを、深さ・配列要素数・キー数・文字列長に上限のある値へ変換する。 */
function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string")
    return truncate(value, MAX_RENDERER_LOG_STRING_LENGTH);
  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return truncate(String(value), MAX_RENDERER_LOG_STRING_LENGTH);
  }
  if (depth >= MAX_RENDERER_LOG_DEPTH) return "[truncated]";
  if (Array.isArray(value))
    return value
      .slice(0, MAX_RENDERER_LOG_ARRAY_ITEMS)
      .map((item) => sanitizePayload(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_RENDERER_LOG_OBJECT_KEYS)
      .map(([key, entryValue]) => [
        truncate(key, MAX_RENDERER_LOG_KIND_LENGTH),
        sanitizePayload(entryValue, depth + 1),
      ]),
  );
}

/** 文字列のメッセージを持つエラー情報だけを取り出し、本文・名前・スタックを制限する。 */
function sanitizeError(value: unknown): RendererLogInput["error"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.message !== "string") return undefined;
  return {
    name:
      typeof candidate.name === "string"
        ? truncate(candidate.name, MAX_RENDERER_LOG_STRING_LENGTH)
        : undefined,
    message: truncate(candidate.message, MAX_RENDERER_LOG_MESSAGE_LENGTH),
    stack:
      typeof candidate.stack === "string"
        ? truncate(candidate.stack, MAX_RENDERER_LOG_MESSAGE_LENGTH)
        : undefined,
  };
}

/** 必須のレベル・種別・本文を検証し、不正なら null、正しければサイズを制限したログ入力を返す。 */
export function sanitizeRendererLogInput(
  input: RendererLogInput,
): SanitizedRendererLogInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.level !== "string" ||
    !VALID_RENDERER_LOG_LEVELS.has(raw.level)
  )
    return null;
  if (typeof raw.kind !== "string" || raw.kind.trim().length === 0) return null;
  if (typeof raw.message !== "string") return null;
  return {
    level: raw.level as RendererLogInput["level"],
    kind: truncate(raw.kind, MAX_RENDERER_LOG_KIND_LENGTH),
    message: truncate(raw.message, MAX_RENDERER_LOG_MESSAGE_LENGTH),
    correlationId:
      typeof raw.correlationId === "string"
        ? truncate(raw.correlationId, MAX_RENDERER_LOG_STRING_LENGTH)
        : undefined,
    url:
      typeof raw.url === "string"
        ? truncate(raw.url, MAX_RENDERER_LOG_URL_LENGTH)
        : undefined,
    data: raw.data === undefined ? undefined : sanitizePayload(raw.data),
    error: sanitizeError(raw.error),
  };
}
