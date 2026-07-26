import { RUNTIME_IPC_LIMITS, runtimeProtocolFailure } from "./runtime-ipc-common.js";

export type RuntimeWireValue =
  | Readonly<{ tag: "null" }>
  | Readonly<{ tag: "boolean"; value: boolean }>
  | Readonly<{ tag: "number"; value: number }>
  | Readonly<{ tag: "string"; value: string }>
  | Readonly<{ tag: "array"; items: readonly RuntimeWireValue[] }>
  | Readonly<{ tag: "object"; entries: readonly (readonly [string, RuntimeWireValue])[] }>
  | Readonly<{ tag: "bytes"; encoding: "base64"; byteLength: number; data: string }>;

export function encodeRuntimeWireValue(value: unknown): RuntimeWireValue {
  return encodeValue(value, 0);
}

export function snapshotRuntimeWireValue(value: unknown): RuntimeWireValue {
  return encodeRuntimeWireValue(decodeRuntimeWireValue(value));
}

export function decodeRuntimeWireValue(value: unknown): unknown {
  return decodeValue(value, 0);
}

function encodeValue(value: unknown, depth: number): RuntimeWireValue {
  assertDepth(depth);
  if (value === null) return { tag: "null" };
  if (typeof value === "boolean") return { tag: "boolean", value };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw runtimeProtocolFailure("invalid_value");
    return { tag: "number", value };
  }
  if (typeof value === "string") {
    assertBoundedString(value);
    return { tag: "string", value };
  }
  if (value instanceof ArrayBuffer) return encodeBytes(value);
  if (ArrayBuffer.isView(value)) throw runtimeProtocolFailure("invalid_value");
  if (Array.isArray(value)) {
    const items = snapshotDenseArray(value, RUNTIME_IPC_LIMITS.maxArrayItems);
    return { tag: "array", items: items.map((item) => encodeValue(item, depth + 1)) };
  }
  const record = snapshotPlainRecord(value, RUNTIME_IPC_LIMITS.maxObjectEntries);
  const entries = Object.entries(record).map(([key, item]) => [key, encodeValue(item, depth + 1)] as const);
  return { tag: "object", entries };
}

function decodeValue(value: unknown, depth: number): unknown {
  assertDepth(depth);
  const record = snapshotExactRecord(value, ["tag", "value", "items", "entries", "encoding", "byteLength", "data"]);
  switch (record.tag) {
    case "null":
      requireExactKeys(record, ["tag"]);
      return null;
    case "boolean":
      requireExactKeys(record, ["tag", "value"]);
      if (typeof record.value !== "boolean") throw runtimeProtocolFailure("invalid_value");
      return record.value;
    case "number":
      requireExactKeys(record, ["tag", "value"]);
      if (!Number.isSafeInteger(record.value)) throw runtimeProtocolFailure("invalid_value");
      return record.value;
    case "string":
      requireExactKeys(record, ["tag", "value"]);
      if (typeof record.value !== "string") throw runtimeProtocolFailure("invalid_value");
      assertBoundedString(record.value);
      return record.value;
    case "array": {
      requireExactKeys(record, ["tag", "items"]);
      const items = snapshotDenseArray(record.items, RUNTIME_IPC_LIMITS.maxArrayItems);
      return items.map((item) => decodeValue(item, depth + 1));
    }
    case "object": {
      requireExactKeys(record, ["tag", "entries"]);
      const entries = snapshotDenseArray(record.entries, RUNTIME_IPC_LIMITS.maxObjectEntries);
      const output = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      for (const entry of entries) {
        const pair = snapshotDenseArray(entry, 2);
        if (pair.length !== 2 || typeof pair[0] !== "string" || seen.has(pair[0])) {
          throw runtimeProtocolFailure("invalid_value");
        }
        assertObjectKey(pair[0]);
        seen.add(pair[0]);
        output[pair[0]] = decodeValue(pair[1], depth + 1);
      }
      return output;
    }
    case "bytes":
      requireExactKeys(record, ["tag", "encoding", "byteLength", "data"]);
      return decodeBytes(record);
    default:
      throw runtimeProtocolFailure("invalid_value");
  }
}

function encodeBytes(value: ArrayBuffer): RuntimeWireValue {
  if (value.byteLength > RUNTIME_IPC_LIMITS.maxBinaryBytes) {
    throw runtimeProtocolFailure("binary_too_large");
  }
  return {
    tag: "bytes",
    encoding: "base64",
    byteLength: value.byteLength,
    data: Buffer.from(value).toString("base64"),
  };
}

function decodeBytes(record: Readonly<Record<string, unknown>>): ArrayBuffer {
  if (
    record.encoding !== "base64" ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    (record.byteLength as number) > RUNTIME_IPC_LIMITS.maxBinaryBytes ||
    typeof record.data !== "string" ||
    !isCanonicalBase64(record.data)
  ) {
    throw runtimeProtocolFailure("invalid_binary");
  }
  const bytes = Buffer.from(record.data, "base64");
  if (bytes.byteLength !== record.byteLength) throw runtimeProtocolFailure("invalid_binary");
  return Uint8Array.from(bytes).buffer;
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function assertDepth(depth: number): void {
  if (depth > RUNTIME_IPC_LIMITS.maxValueDepth) throw runtimeProtocolFailure("invalid_value");
}

function assertBoundedString(value: string): void {
  if (Buffer.byteLength(value) > RUNTIME_IPC_LIMITS.maxStringBytes) {
    throw runtimeProtocolFailure("invalid_value");
  }
}

function assertObjectKey(value: string): void {
  if (value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > 1_024) {
    throw runtimeProtocolFailure("invalid_value");
  }
}

function snapshotPlainRecord(value: unknown, maxEntries: number): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw runtimeProtocolFailure("invalid_value");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (
    keys.length > maxEntries ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    throw runtimeProtocolFailure("invalid_value");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    assertObjectKey(key);
    snapshot[key] = (descriptors[key] as PropertyDescriptor & { value: unknown }).value;
  }
  return snapshot;
}

function snapshotExactRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = snapshotPlainRecord(value, allowedKeys.length);
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw runtimeProtocolFailure("invalid_value");
  }
  return record;
}

function requireExactKeys(record: Readonly<Record<string, unknown>>, requiredKeys: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== requiredKeys.length || requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    throw runtimeProtocolFailure("invalid_value");
  }
}

function snapshotDenseArray(value: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) throw runtimeProtocolFailure("invalid_value");
  const length = value.length;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1 ||
    ownKeys.some((key, index) => key !== (index === length ? "length" : String(index)))
  ) {
    throw runtimeProtocolFailure("invalid_value");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw runtimeProtocolFailure("invalid_value");
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
