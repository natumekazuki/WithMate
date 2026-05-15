import assert from "node:assert/strict";
import test from "node:test";

import { getSandboxOptionsForProvider } from "../../src/provider-runtime-options.js";

test("getSandboxOptionsForProvider は Copilot でも Session と同じ Sandbox 選択肢を返す", () => {
  const codexOptions = getSandboxOptionsForProvider("codex");
  const copilotOptions = getSandboxOptionsForProvider("copilot");

  assert.deepEqual(copilotOptions, codexOptions);
  assert.ok(copilotOptions.some((option) => option.value === "workspace-write"));
});
