import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MATE_MEMORY_GENERATION_OUTPUT_SCHEMA, type MateMemoryGenerationPrompt } from "../../src-electron/mate-memory-generation-prompt.js";
import { createMateMemoryGenerationRunner, type MateMemoryGenerationRunnerDeps } from "../../src-electron/mate-memory-generation-runner.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { ProviderBackgroundAdapter } from "../../src-electron/provider-runtime.js";

function createPrompt(): MateMemoryGenerationPrompt {
  return {
    systemText: "system",
    userText: "user",
    outputSchema: MATE_MEMORY_GENERATION_OUTPUT_SCHEMA,
  };
}

function createLogicalPrompt() {
  return {
    systemText: "logical-system",
    inputText: "logical-input",
    composedText: "logical-composed",
  };
}

function createAdapter(onCall: () => void, result?: { parsedJson?: unknown; rawText: string; threadId?: string | null }): ProviderBackgroundAdapter {
  return {
    extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    runCharacterReflection() {
      throw new Error("not used");
    },
    runBackgroundStructuredPrompt() {
      onCall();
      return Promise.resolve({
        threadId: result?.threadId ?? null,
        rawText: result?.rawText ?? "{}",
        output: null,
        parsedJson: result?.parsedJson,
        rawItemsJson: "{\"type\":\"mock\"}",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
        },
        providerQuotaTelemetry: null,
      });
    },
  };
}

function createErrorAdapter(onCall: () => void, _result?: never, error = new Error("provider failed")): ProviderBackgroundAdapter {
  return {
    extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    runCharacterReflection() {
      throw new Error("not used");
    },
    runBackgroundStructuredPrompt() {
      onCall();
      return Promise.reject(error);
    },
  };
}

function createDeps(overrides: {
  adapters: Map<string, ProviderBackgroundAdapter>;
  appSettings: ReturnType<typeof normalizeAppSettings>;
  onProviderFailure?: MateMemoryGenerationRunnerDeps["onProviderFailure"];
}): MateMemoryGenerationRunnerDeps {
  return {
    getAppSettings() {
      return overrides.appSettings;
    },
    getProviderBackgroundAdapter(providerId) {
      return overrides.adapters.get(providerId) ?? (() => {
        throw new Error(`missing adapter: ${providerId}`);
      })();
    },
    getWorkspacePath() {
      return "C:/workspace";
    },
    onProviderFailure: overrides.onProviderFailure,
  };
}

describe("createMateMemoryGenerationRunner", () => {
  it("有効な第一候補を使う", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(() => {
          called.push("copilot");
        }, {
          parsedJson: { memories: [] },
          rawText: "{\"memories\":[]}",
          threadId: "thread-copilot",
        }),
      ],
      [
        "codex",
        createAdapter(() => {
          called.push("codex");
        }, {
          parsedJson: { memories: [{ foo: "bar" }] },
          rawText: "{\"memories\":[{\"foo\":\"bar\"}]}",
          threadId: "thread-codex",
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "copilot", model: "copilot-1", reasoningEffort: "medium", timeoutSeconds: 31 },
          { provider: "codex", model: "codex-1", reasoningEffort: "high", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
        codex: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(
      createDeps({ adapters, appSettings, onProviderFailure: () => {} }),
    );
    const output = await runner({ prompt: createPrompt(), logicalPrompt: createLogicalPrompt() });

    assert.deepEqual(called, ["copilot"]);
    assert.equal(output.provider, "copilot");
    assert.equal(output.model, "copilot-1");
    assert.deepEqual(output.parsedJson, { memories: [] });
    assert.equal(output.threadId, "thread-copilot");
  });

  it("disabled な候補は skip して次候補を試す", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(() => {
          called.push("copilot");
        }, {
          parsedJson: { memories: [{ foo: "skip" }] },
          rawText: "{\"memories\":[{\"foo\":\"skip\"}]}",
          threadId: "thread-skip",
        }),
      ],
      [
        "codex",
        createAdapter(() => {
          called.push("codex");
        }, {
          parsedJson: { memories: [{ foo: "used" }] },
          rawText: "{\"memories\":[{\"foo\":\"used\"}]}",
          threadId: "thread-used",
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "copilot", model: "copilot-1", reasoningEffort: "low", timeoutSeconds: 31 },
          { provider: "codex", model: "codex-1", reasoningEffort: "high", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        copilot: {
          enabled: false,
          apiKey: "",
          skillRootPath: "",
        },
        codex: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));
    const output = await runner({ prompt: createPrompt(), logicalPrompt: createLogicalPrompt() });

    assert.deepEqual(called, ["codex"]);
    assert.equal(output.provider, "codex");
    assert.equal(output.model, "codex-1");
  });

  it("第一候補の失敗時に次候補へ fallback する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createErrorAdapter(() => {
          called.push("copilot");
        }, undefined, new Error("first failed")),
      ],
      [
        "codex",
        createAdapter(() => {
          called.push("codex");
        }, {
          parsedJson: { memories: [{ foo: "fallback" }] },
          rawText: "{\"memories\":[{\"foo\":\"fallback\"}]}",
          threadId: "thread-codex",
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "copilot", model: "copilot-1", reasoningEffort: "high", timeoutSeconds: 31 },
          { provider: "codex", model: "codex-1", reasoningEffort: "high", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
        codex: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const failures: Array<{ provider: string; model: string }> = [];
    const runner = createMateMemoryGenerationRunner(
      createDeps({
        adapters,
        appSettings,
        onProviderFailure(error, candidate) {
          failures.push(candidate);
          assert.equal(error.message, "first failed");
        },
      }),
    );
    const output = await runner({ prompt: createPrompt(), logicalPrompt: createLogicalPrompt() });

    assert.deepEqual(called, ["copilot", "codex"]);
    assert.deepEqual(failures, [{ provider: "copilot", model: "copilot-1" }]);
    assert.equal(output.provider, "codex");
    assert.equal(output.model, "codex-1");
  });

  it("全候補が unusable なら最後のエラーを throw する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createErrorAdapter(() => {
          called.push("copilot");
        }, undefined, new Error("first failed")),
      ],
      [
        "codex",
        createErrorAdapter(() => {
          called.push("codex");
        }, undefined, new Error("last failed")),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "copilot", model: "copilot-1", reasoningEffort: "medium", timeoutSeconds: 31 },
          { provider: "codex", model: "codex-1", reasoningEffort: "medium", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
        codex: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));

    await assert.rejects(
      () => runner({ prompt: createPrompt(), logicalPrompt: createLogicalPrompt() }),
      /last failed/,
    );
    assert.deepEqual(called, ["copilot", "codex"]);
  });
});
