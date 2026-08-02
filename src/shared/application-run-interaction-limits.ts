export const RUNTIME_IPC_SHARED_LIMITS = Object.freeze({
  maxLineBytes: 512 * 1_024,
} as const);

const RUNTIME_INTERACTION_ENVELOPE_RESERVE_BYTES = 128 * 1_024;

export const APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS = Object.freeze({
  maxCollectionWireBytes: RUNTIME_IPC_SHARED_LIMITS.maxLineBytes - RUNTIME_INTERACTION_ENVELOPE_RESERVE_BYTES,
  runtimeEnvelopeReserveBytes: RUNTIME_INTERACTION_ENVELOPE_RESERVE_BYTES,
} as const);

export function applicationRunInteractionWireItemBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(runtimeWireValue(value)), "utf8");
}

export function applicationRunInteractionCollectionWireBytes(itemWireBytes: number, itemCount: number): number {
  if (!Number.isSafeInteger(itemWireBytes) || itemWireBytes < 0) throw new RangeError("Wire byte count is invalid.");
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new RangeError("Wire item count is invalid.");
  if (itemCount === 0 && itemWireBytes !== 0) throw new RangeError("Empty wire collection has item bytes.");
  const separators = Math.max(0, itemCount - 1);
  const total = EMPTY_RUNTIME_WIRE_ARRAY_BYTES + itemWireBytes + separators;
  if (!Number.isSafeInteger(total)) throw new RangeError("Wire collection byte count is invalid.");
  return total;
}

const EMPTY_RUNTIME_WIRE_ARRAY_BYTES = Buffer.byteLength(JSON.stringify({ tag: "array", items: [] }), "utf8");

function runtimeWireValue(value: unknown): unknown {
  if (value === null) return { tag: "null" };
  if (typeof value === "boolean") return { tag: "boolean", value };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Interaction wire number is invalid.");
    return { tag: "number", value };
  }
  if (typeof value === "string") return { tag: "string", value };
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1 ||
      ownKeys.some((key, index) => key !== (index === value.length ? "length" : String(index)))
    ) {
      throw new TypeError("Interaction wire array is invalid.");
    }
    return { tag: "array", items: value.map((item) => runtimeWireValue(item)) };
  }
  if (typeof value !== "object" || value === null) throw new TypeError("Interaction wire value is invalid.");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Interaction wire object is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError("Interaction wire object is invalid.");
  }
  const entries = keys.map((key) => [key, runtimeWireValue((descriptors[key] as PropertyDescriptor).value)] as const);
  return { tag: "object", entries };
}
