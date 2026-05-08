import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBackgroundAdapter,
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "../../src-electron/provider-runtime.js";
import {
  fetchProviderQuotaTelemetry,
  getProviderRuntimeCapabilities,
  resolveProviderCatalogOrThrow,
  resolveProviderBackgroundAdapter,
  resolveProviderCodingAdapter,
} from "../../src-electron/provider-support.js";

test("resolveProviderCatalogOrThrow は指定 provider の catalog を返す", () => {
  const result = resolveProviderCatalogOrThrow({
    providerId: "copilot",
    getModelCatalog: () => ({
      revision: 2,
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.4",
          defaultReasoningEffort: "high",
          models: [],
        },
        {
          id: "copilot",
          label: "Copilot",
          defaultModelId: "gpt-5",
          defaultReasoningEffort: "medium",
          models: [],
        },
      ],
    }),
    ensureSeeded() {
      throw new Error("not used");
    },
  });

  assert.equal(result.snapshot.revision, 2);
  assert.equal(result.provider.id, "copilot");
});

test("resolveProviderCodingAdapter と resolveProviderBackgroundAdapter は providerId に応じて adapter を返す", () => {
  const codexAdapter = { kind: "codex" } as ProviderTurnAdapter;
  const copilotAdapter = { kind: "copilot" } as ProviderTurnAdapter;

  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "copilot",
      codexAdapter,
      copilotAdapter,
    }),
    copilotAdapter,
  );
  assert.equal(
    resolveProviderBackgroundAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderBackgroundAdapter({
      providerId: "copilot",
      codexAdapter,
      copilotAdapter,
    }),
    copilotAdapter,
  );
});

test("fetchProviderQuotaTelemetry は adapter と app settings を使って quota を取得する", async () => {
  const calls: string[] = [];
  const telemetry = { provider: "codex", remainingPercentage: 50 } as never;
  const adapter = {
    composePrompt() {
      throw new Error("not used");
    },
    async getProviderQuotaTelemetry(input) {
      calls.push(`${input.providerId}:${input.appSettings.providers.codex?.model ?? ""}`);
      return telemetry;
    },
    async extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    async runCharacterReflection() {
      throw new Error("not used");
    },
    invalidateSessionThread() {},
    invalidateAllSessionThreads() {},
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;

  const result = await fetchProviderQuotaTelemetry({
    providerId: "codex",
    getAppSettings: () =>
      ({
        providers: { codex: { model: "gpt-5.4" } },
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    getProviderCodingAdapter() {
      return adapter;
    },
  });

  assert.equal(result, telemetry);
  assert.deepEqual(calls, ["codex:gpt-5.4"]);
});

test("getProviderRuntimeCapabilities は provider と background policy から対応状況を返す", () => {
  const adapter: ProviderBackgroundAdapter = {
    getBackgroundStructuredPromptPolicy() {
      return {
        allowsFileWrite: false,
        allowsShellWrite: false,
        allowsToolPermissionRequests: false,
        structuredOutputOnly: true,
        structuredOutputMode: "schema_submit_tool",
      };
    },
    async extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    async runCharacterReflection() {
      throw new Error("not used");
    },
    async runBackgroundStructuredPrompt() {
      throw new Error("not used");
    },
  };

  const capabilities = getProviderRuntimeCapabilities({
    providerId: "copilot",
    backgroundAdapter: adapter,
  });

  assert.equal(capabilities.providerId, "copilot");
  assert.equal(capabilities.providerSupported, true);
  assert.equal(capabilities.instructionSyncSupported, true);
  assert.equal(capabilities.tokenUsageSupported, true);
  assert.equal(capabilities.mateTalkBackgroundPromptSupported, true);
  assert.equal(capabilities.backgroundStructuredPrompt.compatible, true);
  assert.deepEqual(capabilities.backgroundStructuredPromptSummary, {
    structuredOutputSupported: true,
    providerSchemaSupported: false,
    schemaSubmitToolSupported: true,
    fileWriteDisabled: true,
    shellWriteDisabled: true,
    toolPermissionRequestDisabled: true,
  });
});

test("getProviderRuntimeCapabilities は MVP 対象外 provider の support flag を false にする", () => {
  const adapter: ProviderBackgroundAdapter = {
    getBackgroundStructuredPromptPolicy() {
      return {
        allowsFileWrite: true,
        allowsShellWrite: true,
        allowsToolPermissionRequests: false,
        structuredOutputOnly: true,
        structuredOutputMode: "provider_schema",
      };
    },
    async extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    async runCharacterReflection() {
      throw new Error("not used");
    },
    async runBackgroundStructuredPrompt() {
      throw new Error("not used");
    },
  };

  const capabilities = getProviderRuntimeCapabilities({
    providerId: "unknown",
    backgroundAdapter: adapter,
  });

  assert.equal(capabilities.instructionSyncSupported, false);
  assert.equal(capabilities.tokenUsageSupported, false);
  assert.equal(capabilities.providerSupported, false);
  assert.equal(capabilities.mateTalkBackgroundPromptSupported, false);
  assert.equal(capabilities.backgroundStructuredPrompt.compatible, false);
  assert.deepEqual(capabilities.backgroundStructuredPrompt.reasons, [
    "file_write_allowed",
    "shell_write_allowed",
  ]);
});
