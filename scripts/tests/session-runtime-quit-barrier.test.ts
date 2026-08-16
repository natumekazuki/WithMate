import assert from "node:assert/strict";
import { test } from "node:test";

import { closeSessionRuntimeAdmission } from "../../src-electron/session-runtime-quit-barrier.js";

test("Session runtime admission closure reaches execution service without a lazy application service", () => {
  const calls: string[] = [];

  closeSessionRuntimeAdmission({
    executionService: {
      beginShutdown() {
        calls.push("execution");
      },
    },
    applicationService: null,
  });

  assert.deepEqual(calls, ["execution"]);
});
