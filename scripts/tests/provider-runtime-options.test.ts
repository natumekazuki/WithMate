import assert from "node:assert/strict";
import test from "node:test";

import {
  getSandboxOptionsForProvider,
  getSandboxOptionsForProviderSelection,
} from "../../src/provider-runtime-options.js";

test("getSandboxOptionsForProvider は Codex provider に Sandbox 選択肢を返す", () => {
  const codexOptions = getSandboxOptionsForProvider("codex");

  assert.ok(codexOptions.some((option) => option.value === "workspace-write"));
});

test("getSandboxOptionsForProvider は非 Codex provider では Sandbox 選択肢を返さない", () => {
  assert.deepEqual(getSandboxOptionsForProvider("copilot"), []);
  assert.deepEqual(getSandboxOptionsForProvider(null), []);
});

test("getSandboxOptionsForProviderSelection は非 Codex provider で保存済み値を補完しない", () => {
  assert.deepEqual(getSandboxOptionsForProviderSelection("copilot", "workspace-write"), []);
});

test("getSandboxOptionsForProviderSelection は Codex provider で保存済み値を選択肢に含める", () => {
  const options = getSandboxOptionsForProviderSelection("codex", "workspace-write");

  assert.ok(options.some((option) => option.value === "workspace-write"));
});
