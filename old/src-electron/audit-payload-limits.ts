export const AUDIT_TEXT_PREVIEW_LIMIT = 64 * 1024;
export const AUDIT_RAW_ITEMS_JSON_LIMIT = 512 * 1024;
export const AUDIT_RAW_ITEM_CLONE_LIMIT = 128 * 1024;

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

type RawItemBudgetState = {
  remaining: number;
  truncated: boolean;
  seen: WeakSet<object>;
};

const RAW_ITEM_TRUNCATION_MARKER = {
  type: "withmate.value_truncated",
  truncated: true,
  reason: "audit raw item budget exceeded",
};
const RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE = 1024;

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

function measureBoundedJson(value: unknown): number {
  return JSON.stringify(value)?.length ?? 4;
}

function consumeRawItemBudget(state: RawItemBudgetState, length: number): boolean {
  if (length > state.remaining) {
    state.remaining = 0;
    state.truncated = true;
    return false;
  }

  state.remaining -= length;
  return true;
}

function cloneStringWithinRawItemBudget(value: string, state: RawItemBudgetState): unknown {
  if (state.remaining <= 0) {
    state.truncated = true;
    return RAW_ITEM_TRUNCATION_MARKER;
  }

  const previewLimit = Math.max(0, Math.min(AUDIT_TEXT_PREVIEW_LIMIT, state.remaining - 256));
  const boundedValue = previewLimit > 0 ? toTruncatedText(value, previewLimit) : RAW_ITEM_TRUNCATION_MARKER;
  if (boundedValue !== value) {
    state.truncated = true;
  }

  const length = measureBoundedJson(boundedValue);
  if (consumeRawItemBudget(state, length)) {
    return boundedValue;
  }

  return RAW_ITEM_TRUNCATION_MARKER;
}

function clonePrimitiveWithinRawItemBudget(value: unknown, state: RawItemBudgetState): unknown {
  const length = measureBoundedJson(value);
  if (consumeRawItemBudget(state, length)) {
    return value;
  }

  return RAW_ITEM_TRUNCATION_MARKER;
}

function cloneArrayWithinRawItemBudget(value: unknown[], state: RawItemBudgetState): unknown[] {
  if (state.seen.has(value)) {
    state.truncated = true;
    return [RAW_ITEM_TRUNCATION_MARKER];
  }

  state.seen.add(value);
  const entries: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (state.remaining <= 0) {
      state.truncated = true;
      break;
    }

    entries.push(cloneValueWithinRawItemBudget(value[index], state));
    if (state.remaining <= 0) {
      break;
    }
  }

  state.seen.delete(value);
  if (entries.length < value.length) {
    state.truncated = true;
    entries.push({
      ...RAW_ITEM_TRUNCATION_MARKER,
      omittedItems: value.length - entries.length,
    });
  }

  return entries;
}

function cloneObjectWithinRawItemBudget(
  value: Record<string, unknown>,
  state: RawItemBudgetState,
): Record<string, unknown> {
  if (state.seen.has(value)) {
    state.truncated = true;
    return { ...RAW_ITEM_TRUNCATION_MARKER };
  }

  state.seen.add(value);
  const output: Record<string, unknown> = {};
  let omittedEntries = 0;

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }

    const keyLength = measureBoundedJson(key);
    if (state.remaining <= keyLength) {
      state.truncated = true;
      omittedEntries += 1;
      continue;
    }

    consumeRawItemBudget(state, keyLength);
    output[key] = cloneValueWithinRawItemBudget(value[key], state);
    if (state.remaining <= 0) {
      state.truncated = true;
      break;
    }
  }

  state.seen.delete(value);
  if (omittedEntries > 0) {
    output.withmateTruncated = {
      ...RAW_ITEM_TRUNCATION_MARKER,
      omittedEntries,
    };
  }

  return output;
}

function cloneValueWithinRawItemBudget(value: unknown, state: RawItemBudgetState): unknown {
  if (typeof value === "string") {
    return cloneStringWithinRawItemBudget(value, state);
  }

  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return clonePrimitiveWithinRawItemBudget(value, state);
  }

  if (Array.isArray(value)) {
    return cloneArrayWithinRawItemBudget(value, state);
  }

  if (value && typeof value === "object") {
    return cloneObjectWithinRawItemBudget(value as Record<string, unknown>, state);
  }

  return undefined;
}

function cloneRawItemWithinBudget(item: BoundedAuditRawItem, budget: number): BoundedAuditRawItem {
  const state: RawItemBudgetState = {
    remaining: Math.max(0, budget),
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const boundedItem = cloneValueWithinRawItemBudget(item, state) as BoundedAuditRawItem;

  if (state.truncated) {
    return {
      type: boundedItem.type ?? item.type,
      timestamp: boundedItem.timestamp,
      data: {
        ...(boundedItem.data ?? {}),
        withmateTruncated: {
          ...RAW_ITEM_TRUNCATION_MARKER,
          maxLength: budget,
        },
      },
    };
  }

  return boundedItem;
}

export function boundAuditRawItem(
  item: BoundedAuditRawItem,
  limit = AUDIT_RAW_ITEM_CLONE_LIMIT,
): BoundedAuditRawItem {
  return cloneRawItemWithinBudget(
    item,
    Math.max(0, limit - RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE),
  );
}

export function stringifyBoundedAuditValue(
  value: unknown,
  limit = AUDIT_TEXT_PREVIEW_LIMIT,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return toAuditTextPreview(value, limit);
  }

  const state: RawItemBudgetState = {
    remaining: Math.max(0, limit - RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE),
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const boundedValue = cloneValueWithinRawItemBudget(value, state);
  const serialized = JSON.stringify(boundedValue);
  return toAuditTextPreview(serialized, limit);
}

export function stringifyBoundedAuditRawItems(
  items: BoundedAuditRawItem[],
  limit = AUDIT_RAW_ITEMS_JSON_LIMIT,
): string {
  const serializedItems: string[] = [];
  let omittedItems = 0;
  let currentLength = 2;

  for (const item of items) {
    const commaLength = currentLength === 2 ? 0 : 1;
    const remainingItemBudget = Math.max(
      0,
      limit - currentLength - commaLength - RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE,
    );
    const serializedItem = JSON.stringify(cloneRawItemWithinBudget(item, remainingItemBudget));
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
