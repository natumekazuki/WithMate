import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { resolveBackgroundPromptContext } from "../../src-electron/providers/background-prompt-context.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import type { CharacterContextResponse } from "../../src-shared/character-context/character-context-contract.js";

// @test-value v2
// kind = "contract"
// claim = "背景三用途は実sourceのCharacterとAffectを通常promptへ注入し、Auxiliaryは親SessionFolderを使い、設定offでcontextを取得しない"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
// fault = "背景で共通context注入を迂回する、親Characterへ置換する、Auxiliary独自folderを許可する、またはoff設定でもAffectを読む"
// observable = "共通promptの定義・Affect・folder、context取得のsource/snapshot、Timing取得IDとoff設定時の取得数"
// observation_boundary = "consumer"
// scope = "production background prompt context resolver through normal prompt composer with source-specific context port"
// lifecycle = "permanent"
// distinction = "native dispatch testはcontext取得をstub化するため、実resolverのMain/Auxiliary source選択と通常設定の反映を検証できない"
// @end-test-value
test("背景promptは三用途の実Character・AffectとMain共有folderを通常設定に従って使う", async () => {
  for (const purpose of ["character-memory", "target-memory", "affect"] as const) for (const kind of ["main", "auxiliary"] as const) {
    const session = buildNewSession({ id: "source", taskTitle: "Source", workspaceLabel: "workspace", workspacePath: process.cwd(),
      branch: "test", characterId: "actor-character", character: "Actor", characterIconPath: "",
      characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" });
    const source = { kind, sessionId: session.id, incarnationId: session.incarnationId, ownerIdentity: "owner",
      ...(kind === "auxiliary" ? { parent: { sessionId: "parent", incarnationId: "parent-inc" } } : {}) } as BackgroundAgentInput["scope"]["history"]["source"];
    const input = { session, scope: { purpose, history: { source, fromMessageSeq: 0, throughMessageSeq: 1 }, memoryTargets: [] } } satisfies Pick<BackgroundAgentInput, "session" | "scope">;
    const snapshot: CharacterRuntimeSnapshot = { characterId: session.characterId, name: "Actor", description: "", iconFilePath: "",
      theme: session.characterThemeColors, definitionMarkdown: "# Character\nACTOR_DEFINITION", definitionSha256: "definition",
      definitionByteSize: 32, snapshotAt: "2026-11-08T00:00:00.000Z" };
    const state: CharacterContextResponse = { schemaVersion: "withmate-character-context-v1",
      baseline: { definitionSha256: "definition", snapshotAt: snapshot.snapshotAt },
      affect: { mode: "active", effective: [{ contributingLayers: ["session"], targetType: "task", targetId: "task",
        family: "interest", label: "ACTOR_AFFECT", valence: 0.4, intensity: 0.5 }],
        evaluatedAt: snapshot.snapshotAt, version: "version", updatedAt: snapshot.snapshotAt },
      memory: { items: [], updatedAt: null } };
    const reads: unknown[][] = [], timings: string[] = [];
    const deps: Parameters<typeof resolveBackgroundPromptContext>[2] = { userDataPath: path.resolve("test-user-data"),
      refreshSnapshot: async (id) => { assert.equal(id, session.characterId); return snapshot; },
      characterContextService: { getContext: async (...args) => { reads.push(args); return state; } },
      getTimingSnapshot: async (id) => { timings.push(id); return { currentSessionLastCompletedAt: snapshot.snapshotAt,
        sameCharacterOtherSessionLastCompletedAt: null, sameCharacterCompletedTurns: null }; },
      onCharacterContextFailure: () => assert.fail("context should be available") };
    const settings = createDefaultAppSettings();
    settings.characterDefinitionEnabled = true; settings.characterAffectContextEnabled = true; settings.conversationTimingEnabled = true;
    const before = structuredClone(session);
    const context = await resolveBackgroundPromptContext(input, settings, deps);
    const prompt = composeProviderPrompt({ ...context, executionOptions: captureSessionExecutionOptions(session), appSettings: settings,
      providerCatalog: { id: "codex", label: "Codex", defaultModelId: "test", defaultReasoningEffort: "", models: [] },
      userMessage: "PURPOSE_INPUT", attachments: [] });
    assert.equal((prompt.systemBodyText.match(/ACTOR_DEFINITION/g) ?? []).length, 1);
    assert.equal((prompt.systemBodyText.match(/ACTOR_AFFECT/g) ?? []).length, 1);
    const folder = path.join(deps.userDataPath, "session-files", kind === "main" ? "source" : "parent");
    assert.equal(context.sessionFolderPath, folder);
    assert.ok(context.session.allowedAdditionalDirectories.includes(folder));
    assert.ok(prompt.systemBodyText.includes(folder));
    assert.deepEqual(reads[0]?.[3], source);
    assert.deepEqual(reads[0]?.[2], snapshot);
    assert.deepEqual(timings, kind === "main" ? [session.id] : []);
    assert.deepEqual(session, before);
    settings.characterDefinitionEnabled = false; settings.characterAffectContextEnabled = false; settings.conversationTimingEnabled = false;
    const disabled = await resolveBackgroundPromptContext(input, settings, deps);
    const disabledPrompt = composeProviderPrompt({ ...disabled, executionOptions: captureSessionExecutionOptions(session), appSettings: settings,
      providerCatalog: { id: "codex", label: "Codex", defaultModelId: "test", defaultReasoningEffort: "", models: [] }, userMessage: "PURPOSE_INPUT", attachments: [] });
    assert.equal(disabledPrompt.systemBodyText.includes("ACTOR_DEFINITION"), false);
    assert.equal(disabledPrompt.systemBodyText.includes("ACTOR_AFFECT"), false);
    assert.equal(reads.length, 1);
    assert.equal(timings.length, kind === "main" ? 1 : 0);
  }
});
