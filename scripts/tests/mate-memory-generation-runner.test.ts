import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MATE_MEMORY_GENERATION_OUTPUT_SCHEMA, type MateMemoryGenerationPrompt } from "../../src-electron/mate-memory-generation-prompt.js";
import { createMateMemoryGenerationRunner, type MateMemoryGenerationRunnerDeps } from "../../src-electron/mate-memory-generation-runner.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { MateGrowthSettings } from "../../src/mate/mate-state.js";
import type {
  ProviderBackgroundAdapter,
  ProviderBackgroundStructuredPromptPolicy,
  RunBackgroundStructuredPromptInput,
} from "../../src-electron/provider-runtime.js";

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

function runMemoryCandidate(
  runner: ReturnType<typeof createMateMemoryGenerationRunner>,
  prompt = createPrompt(),
) {
  return runner.runStructuredGeneration({
    purpose: "memory_candidate",
    prompt,
    logicalPrompt: createLogicalPrompt(),
  });
}

function createAdapter(
  onCall: (input: RunBackgroundStructuredPromptInput) => void = () => {},
  result?: { parsedJson?: unknown; structuredOutput?: unknown; rawText: string; threadId?: string | null },
  policy: Partial<ProviderBackgroundStructuredPromptPolicy> = {},
  rejectionError?: Error,
): ProviderBackgroundAdapter {
  const mergedPolicy: ProviderBackgroundStructuredPromptPolicy = {
    allowsFileWrite: false,
    allowsShellWrite: false,
    allowsToolPermissionRequests: false,
    structuredOutputOnly: true,
    structuredOutputMode: "schema_submit_tool",
    ...policy,
  };

  return {
    getBackgroundStructuredPromptPolicy() {
      return mergedPolicy;
    },
    extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    runCharacterReflection() {
      throw new Error("not used");
    },
    runBackgroundStructuredPrompt(input: RunBackgroundStructuredPromptInput) {
      onCall(input);
      if (rejectionError) {
        return Promise.reject(rejectionError);
      }
      return Promise.resolve({
        threadId: result?.threadId ?? null,
        rawText: result?.rawText ?? "{}",
        output: null,
        parsedJson: result?.parsedJson,
        structuredOutput: result?.structuredOutput,
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
  return createAdapter(onCall, undefined, {}, error);
}

function createDeps(overrides: {
  adapters: Map<string, ProviderBackgroundAdapter>;
  appSettings: ReturnType<typeof normalizeAppSettings>;
  mateGrowthSettings?: MateGrowthSettings | null;
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
    getMateGrowthSettings() {
      return overrides.mateGrowthSettings ?? null;
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
    const output = await runMemoryCandidate(runner);

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
    const output = await runMemoryCandidate(runner);

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
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["copilot", "codex"]);
    assert.deepEqual(failures, [{ provider: "copilot", model: "copilot-1" }]);
    assert.equal(output.provider, "codex");
    assert.equal(output.model, "codex-1");
  });

  it("unsafe な policy の候補は実行せず次候補へ fallback する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(
          () => {
            called.push("copilot");
          },
          {
            parsedJson: { memories: [{ foo: "unsafe" }] },
            rawText: "{\"memories\":[{\"foo\":\"unsafe\"}]}",
            threadId: "thread-unsafe",
          },
          {
            allowsFileWrite: true,
            allowsShellWrite: true,
            allowsToolPermissionRequests: true,
            structuredOutputOnly: false,
            structuredOutputMode: "schema_submit_tool",
          },
        ),
      ],
      [
        "codex",
        createAdapter(() => {
          called.push("codex");
        }, {
          parsedJson: { memories: [{ foo: "safe" }] },
          rawText: "{\"memories\":[{\"foo\":\"safe\"}]}",
          threadId: "thread-safe",
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
          assert.equal(candidate.provider, "copilot");
          assert.ok(error.message.includes("copilot"));
          assert.ok(error.message.includes("file_write_allowed"));
          assert.ok(error.message.includes("shell_write_allowed"));
          assert.ok(error.message.includes("tool_permission_requests_allowed"));
          assert.ok(error.message.includes("structured_output_not_guaranteed"));
        },
      }),
    );

    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["codex"]);
    assert.deepEqual(failures, [{ provider: "copilot", model: "copilot-1" }]);
    assert.equal(output.provider, "codex");
    assert.equal(output.model, "codex-1");
  });

  it("有効な memory_candidate 用 growth settings を優先して利用する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "growth-primary",
        createAdapter(() => {
          called.push("growth-primary");
        }, {
          parsedJson: { memories: [{ foo: "growth" }] },
          rawText: "{\"memories\":[{\"foo\":\"growth\"}]}",
          threadId: "thread-growth",
        }),
      ],
      [
        "growth-secondary",
        createAdapter(() => {
          called.push("growth-secondary");
        }, {
          parsedJson: { memories: [{ foo: "secondary" }] },
          rawText: "{\"memories\":[{\"foo\":\"secondary\"}]}",
          threadId: "thread-secondary",
        }),
      ],
      [
        "fallback",
        createAdapter(() => {
          called.push("fallback");
        }, {
          parsedJson: { memories: [{ foo: "fallback" }] },
          rawText: "{\"memories\":[{\"foo\":\"fallback\"}]}",
          threadId: "thread-fallback",
        }),
      ],
    ]);

    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "fallback", model: "fallback-1", reasoningEffort: "low", timeoutSeconds: 31 },
          { provider: "growth-primary", model: "growth-1", reasoningEffort: "low", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        "growth-primary": {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
        fallback: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const growthSettings: MateGrowthSettings = {
      enabled: true,
      autoApplyEnabled: true,
      memoryCandidateMode: "manual",
      applyIntervalMinutes: 60,
      modelPreferences: [
        {
          purpose: "memory_candidate",
          priority: 1,
          provider: "growth-primary",
          model: "growth-1",
          depth: "low",
          enabled: true,
        },
        {
          purpose: "memory_candidate",
          priority: 2,
          provider: "growth-secondary",
          model: "growth-2",
          depth: "high",
          enabled: true,
        },
        {
          purpose: "profile_update",
          priority: 2,
          provider: "fallback",
          model: "fallback-1",
          depth: "low",
          enabled: true,
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const runner = createMateMemoryGenerationRunner(createDeps({
      adapters,
      appSettings,
      mateGrowthSettings: growthSettings,
    }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["growth-primary"]);
    assert.equal(output.provider, "growth-primary");
    assert.equal(output.model, "growth-1");
    assert.equal(output.reasoningEffort, "low");
    assert.equal(output.depth, "low");
  });

  it("growth settings の memory_candidate が無効なら app settings 優先リストへ fallback する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "fallback",
        createAdapter(() => {
          called.push("fallback");
        }, {
          parsedJson: { memories: [{ foo: "fallback" }] },
          rawText: "{\"memories\":[{\"foo\":\"fallback\"}]}",
          threadId: "thread-fallback",
        }),
      ],
      [
        "growth-disabled",
        createAdapter(() => {
          called.push("growth-disabled");
        }, {
          parsedJson: { memories: [{ foo: "should-not-run" }] },
          rawText: "{\"memories\":[{\"foo\":\"should-not-run\"}]}",
          threadId: "thread-ignored",
        }),
      ],
    ]);

    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "fallback", model: "fallback-1", reasoningEffort: "medium", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        "growth-disabled": {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
        fallback: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const growthSettings: MateGrowthSettings = {
      enabled: true,
      autoApplyEnabled: true,
      memoryCandidateMode: "manual",
      applyIntervalMinutes: 60,
      modelPreferences: [
        {
          purpose: "memory_candidate",
          priority: 1,
          provider: "growth-disabled",
          model: "growth-1",
          depth: "low",
          enabled: false,
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const runner = createMateMemoryGenerationRunner(createDeps({
      adapters,
      appSettings,
      mateGrowthSettings: growthSettings,
    }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["fallback"]);
    assert.equal(output.provider, "fallback");
    assert.equal(output.model, "fallback-1");
  });

  it("growth settings の有効候補が provider disabled なら app settings 候補へ fallback する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "growth-disabled-provider",
        createAdapter(() => {
          called.push("growth-disabled-provider");
        }, {
          parsedJson: { memories: [{ foo: "should-not-run" }] },
          rawText: "{\"memories\":[{\"foo\":\"should-not-run\"}]}",
        }),
      ],
      [
        "fallback",
        createAdapter(() => {
          called.push("fallback");
        }, {
          parsedJson: { memories: [{ foo: "fallback" }] },
          rawText: "{\"memories\":[{\"foo\":\"fallback\"}]}",
          threadId: "thread-fallback",
        }),
      ],
    ]);

    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "fallback", model: "fallback-1", reasoningEffort: "medium", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        "growth-disabled-provider": {
          enabled: false,
          apiKey: "",
          skillRootPath: "",
        },
        fallback: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const growthSettings: MateGrowthSettings = {
      enabled: true,
      autoApplyEnabled: true,
      memoryCandidateMode: "manual",
      applyIntervalMinutes: 60,
      modelPreferences: [
        {
          purpose: "memory_candidate",
          priority: 1,
          provider: "growth-disabled-provider",
          model: "growth-1",
          depth: "low",
          enabled: true,
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const runner = createMateMemoryGenerationRunner(createDeps({
      adapters,
      appSettings,
      mateGrowthSettings: growthSettings,
    }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["fallback"]);
    assert.equal(output.provider, "fallback");
    assert.equal(output.model, "fallback-1");
  });

  it("growth depth が reasoningEffort でなくても safe に正規化される", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "growth-primary",
        createAdapter((input) => {
          called.push(`growth-primary:${input.reasoningEffort}`);
        }, {
          parsedJson: { memories: [{ foo: "growth" }] },
          rawText: "{\"memories\":[{\"foo\":\"growth\"}]}",
        }),
      ],
    ]);

    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "growth-primary", model: "growth-1", reasoningEffort: "low", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        "growth-primary": {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const growthSettings: MateGrowthSettings = {
      enabled: true,
      autoApplyEnabled: true,
      memoryCandidateMode: "manual",
      applyIntervalMinutes: 60,
      modelPreferences: [
        {
          purpose: "memory_candidate",
          priority: 1,
          provider: "growth-primary",
          model: "growth-1",
          depth: "invalid-depth",
          enabled: true,
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings, mateGrowthSettings: growthSettings }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["growth-primary:high"]);
    assert.equal(output.reasoningEffort, "high");
    assert.equal(output.depth, "high");
  });

  it("adapter 取得失敗でも次候補へ fallback する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "codex",
        createAdapter(() => {
          called.push("codex");
        }, {
          parsedJson: { memories: [{ foo: "used" }] },
          rawText: "{\"memories\":[{\"foo\":\"used\"}]}",
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
          assert.equal(candidate.provider, "copilot");
          assert.equal(error.message, "missing adapter: copilot");
        },
      }),
    );

    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["codex"]);
    assert.deepEqual(failures, [{ provider: "copilot", model: "copilot-1" }]);
    assert.equal(output.provider, "codex");
    assert.equal(output.model, "codex-1");
  });

  it("providerResult.structuredOutput が parsedJson として返る", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(() => {
          called.push("copilot");
        }, {
          rawText: "{\"memories\":[{\"foo\":\"from-structured\"}]}",
          structuredOutput: { memories: [{ foo: "from-structured" }] },
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [{ provider: "copilot", model: "copilot-1", reasoningEffort: "medium", timeoutSeconds: 31 }],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["copilot"]);
    assert.deepEqual(output.parsedJson, { memories: [{ foo: "from-structured" }] });
    assert.equal(output.provider, "copilot");
    assert.equal(output.model, "copilot-1");
  });

  it("providerResult.parsedJson と structuredOutput が両方ある場合は parsedJson を優先する", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(() => {
          called.push("copilot");
        }, {
          rawText: "{\"memories\":[{\"foo\":\"from-parsed\"}]}",
          parsedJson: { memories: [{ foo: "from-parsed" }] },
          structuredOutput: { memories: [{ foo: "from-structured" }] },
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [{ provider: "copilot", model: "copilot-1", reasoningEffort: "medium", timeoutSeconds: 31 }],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["copilot"]);
    assert.deepEqual(output.parsedJson, { memories: [{ foo: "from-parsed" }] });
  });

  it("選択 candidate の model / reasoningEffort / timeoutSeconds が runBackgroundStructuredPrompt input に渡る", async () => {
    let calledInput: RunBackgroundStructuredPromptInput | null = null;
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter((input) => {
          calledInput = input;
        }, {
          parsedJson: { memories: [] },
          rawText: "{\"memories\":[]}",
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [{ provider: "copilot", model: "copilot-light", reasoningEffort: "high", timeoutSeconds: 31 }],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));
    const prompt = createPrompt();

    await runMemoryCandidate(runner, prompt);

    assert.ok(calledInput);
    assert.equal(calledInput.providerId, "copilot");
    assert.equal(calledInput.model, "copilot-light");
    assert.equal(calledInput.reasoningEffort, "high");
    assert.equal(calledInput.timeoutMs, 31000);
    assert.equal(calledInput.workspacePath, "C:/workspace");
    assert.deepEqual(calledInput.appSettings, appSettings);
    assert.deepEqual(calledInput.prompt.outputSchema, MATE_MEMORY_GENERATION_OUTPUT_SCHEMA);
    assert.equal(calledInput.prompt.systemText, prompt.systemText);
    assert.equal(calledInput.prompt.userText, prompt.userText);
  });

  it("onProviderFailure が throw しても次候補へ fallback する", async () => {
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
        }),
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
    const runner = createMateMemoryGenerationRunner(
      createDeps({
        adapters,
        appSettings,
        onProviderFailure() {
          throw new Error("failure callback failed");
        },
      }),
    );
    const output = await runMemoryCandidate(runner);

    assert.deepEqual(called, ["copilot", "codex"]);
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
      () => runMemoryCandidate(runner),
      /last failed/,
    );
    assert.deepEqual(called, ["copilot", "codex"]);
  });

  it("memory_candidate 以外の purpose は実行しない", async () => {
    const called: string[] = [];
    const adapters = new Map<string, ProviderBackgroundAdapter>([
      [
        "copilot",
        createAdapter(() => {
          called.push("copilot");
        }),
      ],
    ]);
    const appSettings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          { provider: "copilot", model: "copilot-1", reasoningEffort: "medium", timeoutSeconds: 31 },
        ],
      },
      codingProviderSettings: {
        copilot: {
          enabled: true,
          apiKey: "",
          skillRootPath: "",
        },
      },
    });
    const runner = createMateMemoryGenerationRunner(createDeps({ adapters, appSettings }));

    await assert.rejects(
      () => runner.runStructuredGeneration({
        purpose: "profile_update",
        prompt: createPrompt(),
        logicalPrompt: createLogicalPrompt(),
      }),
      /profile_update purpose に対応していません/,
    );
    assert.deepEqual(called, []);
  });
});
