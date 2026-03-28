import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnAdapter } from "../../src-electron/provider-runtime.js";
import {
  fetchProviderQuotaTelemetry,
  resolveProviderCatalogOrThrow,
  resolveProviderTurnAdapter,
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

test("resolveProviderTurnAdapter は providerId に応じて adapter を返す", () => {
  const codexAdapter = { kind: "codex" } as ProviderTurnAdapter;
  const copilotAdapter = { kind: "copilot" } as ProviderTurnAdapter;

  assert.equal(
    resolveProviderTurnAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderTurnAdapter({
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
  } satisfies ProviderTurnAdapter;

  const result = await fetchProviderQuotaTelemetry({
    providerId: "codex",
    getAppSettings: () =>
      ({
        providers: { codex: { model: "gpt-5.4" } },
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    getProviderAdapter() {
      return adapter;
    },
  });

  assert.equal(result, telemetry);
  assert.deepEqual(calls, ["codex:gpt-5.4"]);
});
