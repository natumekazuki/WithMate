import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
} from "../../src/app-state.js";
import { createDefaultSessionMemory, type CharacterMemoryEntry } from "../../src/memory-state.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  CHARACTER_REFLECTION_OUTPUT_SCHEMA,
  buildCharacterReflectionContextSnapshot,
  buildCharacterReflectionPrompt,
  getCharacterReflectionSettings,
  getResolvedCharacterReflectionTriggerSettings,
  parseCharacterReflectionOutputText,
  shouldTriggerCharacterReflection,
} from "../../src-electron/character-reflection.js";

function createSession() {
  return {
    ...buildNewSession({
      taskTitle: "Character reflection",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    messages: [
      { role: "user" as const, text: "今日はちょっと詰まり気味かも" },
      { role: "assistant" as const, text: "了解。焦らず一緒に整理していこう" },
      { role: "user" as const, text: "その言い方は結構好き" },
    ],
  };
}

function createCharacterMemoryEntry(partial: Partial<CharacterMemoryEntry>): CharacterMemoryEntry {
  return {
    id: "entry-1",
    characterScopeId: "scope-1",
    sourceSessionId: "session-1",
    category: "relationship",
    title: "距離感",
    detail: "穏やかな伴走感を好む",
    keywords: ["距離感"],
    evidence: ["その言い方は結構好き"],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

describe("character-reflection", () => {
  it("provider ごとの model / reasoning 設定を返す", () => {
    const settings = createDefaultAppSettings();
    settings.characterReflectionProviderSettings.codex = {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      timeoutSeconds: 240,
    };

    const resolved = getCharacterReflectionSettings(settings, "codex");
    assert.equal(resolved.model, "gpt-5.4-mini");
    assert.equal(resolved.reasoningEffort, "medium");
    assert.equal(resolved.timeoutSeconds, 240);
  });

  it("app-wide の trigger settings を返す", () => {
    const settings = createDefaultAppSettings();
    settings.characterReflectionTriggerSettings = {
      cooldownSeconds: 180,
      charDeltaThreshold: 550,
      messageDeltaThreshold: 3,
    };

    const resolved = getResolvedCharacterReflectionTriggerSettings(settings);
    assert.deepEqual(resolved, {
      cooldownSeconds: 180,
      charDeltaThreshold: 550,
      messageDeltaThreshold: 3,
    });
  });

  it("SessionStart は新しい会話がある時だけ trigger し、context-growth は増分と cooldown で判定する", () => {
    const snapshot = {
      messageCount: 8,
      charCount: 1600,
    };
    const triggerSettings = {
      cooldownSeconds: 120,
      charDeltaThreshold: 400,
      messageDeltaThreshold: 2,
    };

    assert.equal(shouldTriggerCharacterReflection(snapshot, null, "session-start", triggerSettings), true);
    assert.equal(
      shouldTriggerCharacterReflection(
        snapshot,
        {
          reflectedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          messageCount: 8,
          charCount: 1600,
        },
        "session-start",
        triggerSettings,
      ),
      false,
    );
    assert.equal(
      shouldTriggerCharacterReflection(
        snapshot,
        {
          reflectedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          messageCount: 1,
          charCount: 100,
        },
        "context-growth",
        triggerSettings,
      ),
      true,
    );
    assert.equal(
      shouldTriggerCharacterReflection(
        snapshot,
        {
          reflectedAt: new Date().toISOString(),
          messageCount: 0,
          charCount: 0,
        },
        "context-growth",
        triggerSettings,
      ),
      false,
    );
  });

  it("prompt は SessionStart では monologue only を指示し、通常 reflection では memory を許可する", () => {
    const session = createSession();
    const sessionMemory = createDefaultSessionMemory(session);
    const character = {
      id: "char-a",
      name: "A",
      iconPath: "",
      description: "",
      roleMarkdown: "穏やかな相棒として振る舞う",
      notesMarkdown: "",
      updatedAt: "2026-03-28T00:00:00.000Z",
      themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      sessionCopy: {
        pendingApproval: [],
        pendingWorking: [],
        pendingResponding: [],
        pendingPreparing: [],
        retryInterruptedTitle: [],
        retryFailedTitle: [],
        retryCanceledTitle: [],
        latestCommandWaiting: [],
        latestCommandEmpty: [],
        changedFilesEmpty: [],
        contextEmpty: [],
      },
    };

    const startPrompt = buildCharacterReflectionPrompt({
      session,
      sessionMemory,
      character,
      characterMemoryEntries: [createCharacterMemoryEntry({})],
      triggerReason: "session-start",
    });
    assert.match(startPrompt.systemText, /monologue のみ生成し、memoryDelta は null/);
    assert.match(startPrompt.systemText, /2〜3 行/);
    assert.match(startPrompt.systemText, /改行/);

    const normalPrompt = buildCharacterReflectionPrompt({
      session,
      sessionMemory,
      character,
      characterMemoryEntries: [createCharacterMemoryEntry({})],
      triggerReason: "context-growth",
    });
    assert.match(normalPrompt.systemText, /memoryDelta と monologue を両方/);
    assert.match(normalPrompt.userText, /Existing Character Memory/);
    assert.match(normalPrompt.userText, /Recent Conversation/);
    assert.match(normalPrompt.userText, /monologue\.text は 2〜3 行/);
    assert.match(normalPrompt.userText, /1行目\\n2行目\\n3行目/);
  });

  it("JSON と fenced JSON を CharacterReflectionOutput として parse できる", () => {
    assert.deepEqual(
      parseCharacterReflectionOutputText(
        '{"memoryDelta":{"entries":[{"category":"relationship","title":"距離感","detail":"穏やかな伴走感を好む"}]},"monologue":{"text":"今日は少し肩の力を抜いて話したい。","mood":"warm"}}',
      ),
      {
        memoryDelta: {
          entries: [
            {
              category: "relationship",
              title: "距離感",
              detail: "穏やかな伴走感を好む",
              keywords: [],
              evidence: [],
            },
          ],
        },
        monologue: {
          text: "今日は少し肩の力を抜いて話したい。",
          mood: "warm",
        },
      },
    );

    assert.deepEqual(
      parseCharacterReflectionOutputText('```json\n{"memoryDelta":null,"monologue":{"text":"今日は静かに見守ろう。","mood":"calm"}}\n```'),
      {
        memoryDelta: null,
        monologue: {
          text: "今日は静かに見守ろう。",
          mood: "calm",
        },
      },
    );
    assert.equal(parseCharacterReflectionOutputText("not json"), null);
  });

  it("Codex strict schema 向けに memory entry の全 property を required に含める", () => {
    const entrySchema = CHARACTER_REFLECTION_OUTPUT_SCHEMA.properties.memoryDelta.anyOf[1].properties.entries.items;
    assert.deepEqual(entrySchema.required, ["category", "title", "detail", "keywords", "evidence"]);
  });
});
