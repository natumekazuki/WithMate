import { createHash } from "node:crypto";

import { MESSAGE_CONTENT_LIMITS, snapshotMessageContentBlocks } from "../shared/message-content.js";
import type { TextContentBlock } from "../shared/message-content.js";
import { isPlainObject } from "../shared/persistence-runtime-protocol.js";

export type PreparedRunInputIdempotency = Readonly<{
  contentBlocks: readonly TextContentBlock[];
  contentBlocksJson: string;
  fingerprint: string;
}>;

export function prepareRunInputIdempotency(
  input: Readonly<{
    sessionId: string;
    workspaceKey: string;
    runId: string;
    contentBlocks: unknown;
  }>,
): PreparedRunInputIdempotency | undefined {
  const contentBlocks = snapshotMessageContentBlocks(input.contentBlocks);
  if (contentBlocks === undefined) return undefined;
  const contentBlocksJson = JSON.stringify(toCanonicalJson(contentBlocks));
  if (Buffer.byteLength(contentBlocksJson) > MESSAGE_CONTENT_LIMITS.maxJsonBytes) return undefined;
  const fingerprintInput = {
    operation: "run.input.admit",
    sessionId: input.sessionId,
    workspaceKey: input.workspaceKey,
    runId: input.runId,
    contentBlocks: JSON.parse(contentBlocksJson),
  };
  return {
    contentBlocks,
    contentBlocksJson,
    fingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput), "utf8").digest("hex"),
  };
}

function toCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonicalJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalJson(value[key])]),
    );
  }
  throw new TypeError("Run input content is not JSON-compatible.");
}
