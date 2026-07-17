import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { normalizeAllowedAdditionalDirectories } from "../src/shared/allowed-additional-directories.js";

test("additional directory containment removal stays bounded at the maximum request size", () => {
  const segment = "x".repeat(3_970);
  const directories = Array.from({ length: 1_024 }, (_, index) =>
    path.join(path.parse(process.cwd()).root, `${String(index).padStart(4, "0")}-${segment}`),
  );

  const startedAt = performance.now();
  const normalized = normalizeAllowedAdditionalDirectories(directories);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(normalized?.length, directories.length);
  assert.ok(elapsedMs < 2_000, `directory normalization took ${Math.round(elapsedMs)}ms`);
});
