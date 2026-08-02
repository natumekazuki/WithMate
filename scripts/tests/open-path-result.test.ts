import assert from "node:assert/strict";
import test from "node:test";

import { resolveOpenPathFeedback } from "../../src/open-path-result.js";

test("resolveOpenPathFeedback は opened だけを空 feedback として扱う", async () => {
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({ status: "opened", targetType: "local-path", target: "C:/workspace" }),
      "fallback",
    ),
    "",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "not-found",
        targetType: "local-path",
        target: "C:/missing",
        message: "The local path was not found.",
      }),
      "fallback",
    ),
    "The local path was not found.",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "failed",
        targetType: "local-path",
        target: "C:/workspace/file.txt",
        message: "The default app could not open the file.",
      }),
      "fallback",
    ),
    "The default app could not open the file.",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "revealed",
        targetType: "local-path",
        target: "C:/workspace/file.txt",
        message: "The file was revealed instead.",
      }),
      "fallback",
    ),
    "The file was revealed instead.",
  );
});

test("resolveOpenPathFeedback は rejected operation も同じfeedback境界へ流す", async () => {
  assert.equal(
    await resolveOpenPathFeedback(async () => {
      throw new Error("open rejected");
    }, "fallback"),
    "open rejected",
  );
  assert.equal(
    await resolveOpenPathFeedback(async () => {
      throw "unknown";
    }, "fallback"),
    "fallback",
  );
});
