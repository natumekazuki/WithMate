import { types as nodeTypes } from "node:util";

export function snapshotProviderRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError("Provider record is invalid.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Provider record is invalid.");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError("Provider record keys are invalid.");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Provider record is invalid.");
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return Object.freeze(snapshot);
}
