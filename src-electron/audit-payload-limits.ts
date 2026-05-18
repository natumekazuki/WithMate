export const AUDIT_TEXT_PREVIEW_LIMIT = 64 * 1024;
export const AUDIT_RAW_ITEMS_JSON_LIMIT = 512 * 1024;

type TruncatedText = {
  text: string;
  truncated: true;
  originalLength: number;
};

export type BoundedAuditRawItem = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

function buildTruncationSuffix(originalLength: number, limit: number): string {
  return `\n...[truncated ${originalLength - limit} chars; originalLength=${originalLength}]`;
}

export function toAuditTextPreview(
  value: string | null | undefined,
  limit = AUDIT_TEXT_PREVIEW_LIMIT,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}${buildTruncationSuffix(value.length, limit)}`;
}

function toTruncatedText(value: string, limit: number): string | TruncatedText {
  const preview = toAuditTextPreview(value, limit);
  if (preview === undefined || preview === value) {
    return value;
  }

  return {
    text: preview,
    truncated: true,
    originalLength: value.length,
  };
}

export function boundAuditValue(value: unknown, limit = AUDIT_TEXT_PREVIEW_LIMIT): unknown {
  if (typeof value === "string") {
    return toTruncatedText(value, limit);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => boundAuditValue(entry, limit));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        boundAuditValue(entry, limit),
      ]),
    );
  }

  return value;
}

export function boundAuditData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, boundAuditValue(value)]),
  );
}

export function stringifyBoundedAuditRawItems(
  items: BoundedAuditRawItem[],
  limit = AUDIT_RAW_ITEMS_JSON_LIMIT,
): string {
  const serializedItems: string[] = [];
  let omittedItems = 0;
  let currentLength = 2;

  for (const item of items) {
    const serializedItem = JSON.stringify(item);
    const nextLength = currentLength === 2
      ? currentLength + serializedItem.length
      : currentLength + 1 + serializedItem.length;
    if (nextLength <= limit) {
      serializedItems.push(serializedItem);
      currentLength = nextLength;
    } else {
      omittedItems += 1;
    }
  }

  if (omittedItems > 0) {
    let marker = JSON.stringify({
      type: "withmate.raw_items_truncated",
      data: {
        omittedItems,
        maxLength: limit,
      },
    });

    while (serializedItems.length > 0) {
      const nextLength = currentLength === 2
        ? currentLength + marker.length
        : currentLength + 1 + marker.length;
      if (nextLength <= limit) {
        break;
      }

      const removed = serializedItems.pop();
      currentLength -= (serializedItems.length === 0 ? 0 : 1) + (removed?.length ?? 0);
      omittedItems += 1;
      marker = JSON.stringify({
        type: "withmate.raw_items_truncated",
        data: {
          omittedItems,
          maxLength: limit,
        },
      });
    }

    serializedItems.push(marker);
  }

  return `[${serializedItems.join(",")}]`;
}
