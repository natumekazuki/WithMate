import assert from "node:assert/strict";
import test from "node:test";

import {
  WITHMATE_MEMORY_BINDING_CONTEXT_FILE_ENV,
  WITHMATE_MEMORY_BINDING_REFERENCE_ENV,
  buildProviderMemoryBindingEnv,
  buildProviderMemoryBindingSettingsKey,
  getProviderMemoryBindingCapability,
  mergeDefinedEnv,
  type ProviderMemoryBindingRuntimeProjection,
} from "../../src-electron/provider-memory-binding.js";

const envProjection: ProviderMemoryBindingRuntimeProjection = {
  bindingId: "binding-1",
  bindingReference: "ref-1",
  transport: "env",
  expiresAt: "2026-06-26T00:00:00.000Z",
};

test("Provider Memory binding capability は Codex / Copilot を env injection として固定する", () => {
  assert.equal(getProviderMemoryBindingCapability("codex").transport, "env");
  assert.equal(getProviderMemoryBindingCapability("copilot").transport, "env");
  assert.equal(getProviderMemoryBindingCapability("unknown").transport, "unsupported");
});

test("env projection は opaque reference だけを provider process 用 env に出す", () => {
  assert.deepEqual(buildProviderMemoryBindingEnv(envProjection), {
    [WITHMATE_MEMORY_BINDING_REFERENCE_ENV]: "ref-1",
  });
  assert.deepEqual(buildProviderMemoryBindingEnv({
    ...envProjection,
    transport: "context_file",
    contextFilePath: "C:/runtime/binding.json",
  }), {
    [WITHMATE_MEMORY_BINDING_CONTEXT_FILE_ENV]: "C:/runtime/binding.json",
  });
  assert.deepEqual(buildProviderMemoryBindingEnv(null), {});
});

test("binding settings key は reference 本体を含めず provider cache 分離に使える", () => {
  assert.equal(
    buildProviderMemoryBindingSettingsKey(envProjection),
    buildProviderMemoryBindingSettingsKey({ ...envProjection, bindingReference: "ref-2" }),
  );
  assert.notEqual(
    buildProviderMemoryBindingSettingsKey(envProjection),
    buildProviderMemoryBindingSettingsKey({ ...envProjection, bindingId: "binding-2" }),
  );
});

test("Codex client env 用 merge は undefined を落として binding env を重ねる", () => {
  assert.deepEqual(
    mergeDefinedEnv(
      { PATH: "bin", EMPTY: undefined },
      { [WITHMATE_MEMORY_BINDING_REFERENCE_ENV]: "ref-1" },
    ),
    { PATH: "bin", [WITHMATE_MEMORY_BINDING_REFERENCE_ENV]: "ref-1" },
  );
});
