export const MESSAGE_CONTENT_LIMITS = {
  maxBlocks: 10_000,
  maxJsonBytes: 4 * 1024 * 1024,
  inlineMaxBytes: 64 * 1024,
} as const;

export type TextContentBlock = Readonly<{
  type: "text";
  text: string;
}>;

export function snapshotMessageContentBlocks(value: unknown): readonly TextContentBlock[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > MESSAGE_CONTENT_LIMITS.maxBlocks || !isDensePlainArray(value)) {
      return undefined;
    }
    const blocks: TextContentBlock[] = [];
    let minimumJsonBytes = 2;
    for (let index = 0; index < value.length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(value, String(index));
      if (element === undefined || !("value" in element)) return undefined;
      const block = snapshotTextContentBlock(element.value);
      if (block === undefined) return undefined;
      minimumJsonBytes += (index === 0 ? 0 : 1) + 25 + block.text.length;
      if (minimumJsonBytes > MESSAGE_CONTENT_LIMITS.maxJsonBytes) return undefined;
      blocks.push(block);
    }
    if (new TextEncoder().encode(JSON.stringify(blocks)).byteLength > MESSAGE_CONTENT_LIMITS.maxJsonBytes) {
      return undefined;
    }
    return Object.freeze(blocks);
  } catch {
    return undefined;
  }
}

function snapshotTextContentBlock(value: unknown): TextContentBlock | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("text")) return undefined;
  const type = Object.getOwnPropertyDescriptor(value, "type");
  const text = Object.getOwnPropertyDescriptor(value, "text");
  if (
    type === undefined ||
    !("value" in type) ||
    !type.enumerable ||
    type.value !== "text" ||
    text === undefined ||
    !("value" in text) ||
    !text.enumerable ||
    typeof text.value !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ type: "text", text: text.value });
}

function isDensePlainArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length)))) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isArrayIndex(value: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
