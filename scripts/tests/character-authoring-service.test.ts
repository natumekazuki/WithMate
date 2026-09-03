import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  DEFAULT_CHARACTER_THEME,
  type CharacterDetail,
} from "../../src/character/character-catalog.js";
import { buildNewSession, type CreateSessionInput } from "../../src/session-state.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
  resolveCharacterAuthoringRuntimeSessionForTurn,
} from "../../src-electron/character-authoring-service.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/provider-runtime-operation-coordinator.js";

const resolveSelectedProvider = (providerId: string): string => providerId;
const bundledSkillPath = path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME);
const defaultDefinition = "# Existing character\n";
const defaultNotes = "# Existing notes\n";

async function runProviderOperationExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
  return operation();
}

function buildCharacter(overrides: Partial<CharacterDetail> = {}): CharacterDetail {
  return {
    id: "char-muse",
    name: "Muse",
    description: "既存説明",
    iconFilePath: "",
    theme: DEFAULT_CHARACTER_THEME,
    state: "active",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    archivedAt: null,
    definitionMarkdown: defaultDefinition,
    notesMarkdown: defaultNotes,
    ...overrides,
  };
}

type CharacterAuthoringServiceDeps = ConstructorParameters<typeof CharacterAuthoringService>[0];

function createService(
  overrides: Partial<CharacterAuthoringServiceDeps> = {},
): CharacterAuthoringService {
  return new CharacterAuthoringService({
    bundledSkillPath,
    resolveProvider: resolveSelectedProvider,
    runProviderRuntimeOperationExclusive: runProviderOperationExclusive,
    getCharacter: () => buildCharacter(),
    getCharacterDirectory: () => "C:/characters/char-muse",
    async createSession(input) {
      return buildNewSession(input);
    },
    ...overrides,
  });
}

async function createWorkspace(
  definition = defaultDefinition,
  notes: string | null = defaultNotes,
): Promise<{ tempDirectory: string; workspacePath: string }> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-authoring-"));
  const workspacePath = path.join(tempDirectory, "characters", "char-muse");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "character.md"), definition, "utf8");
  if (notes !== null) {
    await writeFile(path.join(workspacePath, "character-notes.md"), notes, "utf8");
  }
  return { tempDirectory, workspacePath };
}

describe("CharacterAuthoringService", () => {
  it("最新定義から snapshot を作れない turn は古い runtime snapshot を破棄する", () => {
    const session = buildNewSession({
      taskTitle: "Muse authoring",
      workspaceLabel: "Muse authoring",
      workspacePath: "C:/characters/muse",
      branch: "main",
      sessionKind: "character-authoring",
      characterId: "muse",
      character: "Muse",
      characterIconPath: "",
      characterThemeColors: DEFAULT_CHARACTER_THEME,
      characterRuntimeSnapshot: {
        characterId: "muse",
        name: "Muse",
        description: "",
        iconFilePath: "",
        theme: DEFAULT_CHARACTER_THEME,
        definitionMarkdown: "# Character\nOld",
        definitionSha256: "old-sha256",
        definitionByteSize: 15,
        snapshotAt: "2026-08-01T00:00:00.000Z",
      },
      approvalMode: DEFAULT_APPROVAL_MODE,
    });

    const resolved = resolveCharacterAuthoringRuntimeSessionForTurn(session, () => null);

    assert.equal(resolved.characterId, "muse");
    assert.equal(resolved.characterRuntimeSnapshot, null);
  });

  it("workspace に固定 Skill と authoring 成果物を作成し character-authoring session を作る", async () => {
    const existingDefinition = `---
schema: withmate-character-v5
name: "Muse"
description: "作業を一緒に進める相手"
---

# Existing Character
`;
    const existingNotes = "# Existing Notes\n";
    const { tempDirectory, workspacePath } = await createWorkspace(existingDefinition, existingNotes);
    const createdInputs: CreateSessionInput[] = [];
    const service = createService({
      getCharacter: () => buildCharacter({
        description: "作業を一緒に進める相手",
        iconFilePath: "C:\\Characters\\Muse\\legacy.webp",
        theme: { main: "#112233", sub: "#445566" },
        definitionMarkdown: existingDefinition,
        notesMarkdown: existingNotes,
      }),
      getCharacterDirectory: () => workspacePath,
      async createSession(input) {
        createdInputs.push(input);
        return buildNewSession(input);
      },
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });

      assert.equal(result.session.sessionKind, "character-authoring");
      assert.equal(createdInputs[0]?.sessionKind, "character-authoring");
      assert.equal(createdInputs[0]?.approvalMode, DEFAULT_APPROVAL_MODE);
      assert.deepEqual(createdInputs[0]?.characterThemeColors, { main: "#112233", sub: "#445566" });
      assert.equal(createdInputs[0]?.allowedAdditionalDirectories?.length, 0);
      assert.equal(createdInputs[0]?.provider, "codex");
      assert.equal(createdInputs[0]?.model, undefined);
      assert.equal(createdInputs[0]?.reasoningEffort, undefined);
      assert.equal(createdInputs[0]?.characterIconPath, "C:\\Characters\\Muse\\legacy.webp");
      assert.equal(result.workspacePath, workspacePath);

      const rootEntries = await readdir(result.workspacePath);
      assert.deepEqual(rootEntries.sort(), [
        ".agents",
        "AGENTS.md",
        "AUTHORING_PROMPT.md",
        "character-notes.md",
        "character.md",
        "input.json",
      ]);

      const skillMarkdown = await readFile(
        path.join(result.workspacePath, ".agents", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
        "utf8",
      );
      assert.match(skillMarkdown, /name: withmate-character-authoring/);
      assert.match(skillMarkdown, /references\/improve-existing-character\.md/);
      const copiedSkillRoot = path.join(
        result.workspacePath,
        ".agents",
        "skills",
        CHARACTER_AUTHORING_SKILL_NAME,
      );
      assert.match(
        await readFile(path.join(copiedSkillRoot, "references", "character-format.md"), "utf8"),
        /8,000文字以内/,
      );
      assert.match(
        await readFile(path.join(copiedSkillRoot, "references", "source-and-rights-policy.md"), "utf8"),
        /コミュニティsource/,
      );
      assert.match(
        await readFile(path.join(copiedSkillRoot, "references", "review-checklist.md"), "utf8"),
        /Relationship smoke test/,
      );

      const characterMarkdown = await readFile(path.join(result.workspacePath, "character.md"), "utf8");
      assert.equal(characterMarkdown, existingDefinition);

      const notesMarkdown = await readFile(path.join(result.workspacePath, "character-notes.md"), "utf8");
      assert.equal(notesMarkdown, existingNotes);

      const agentsMarkdown = await readFile(path.join(result.workspacePath, "AGENTS.md"), "utf8");
      assert.match(agentsMarkdown, new RegExp(`必ず ${CHARACTER_AUTHORING_SKILL_NAME} Skill を使う。`));
      assert.match(agentsMarkdown, /必要な場合の character-notes\.md/);
      assert.doesNotMatch(agentsMarkdown, /character\.md \/ character-notes\.md を(?:改善|作成)する/);
      assert.doesNotMatch(agentsMarkdown, /Grow From Conversations/);

      const authoringPrompt = await readFile(path.join(result.workspacePath, "AUTHORING_PROMPT.md"), "utf8");
      assert.match(authoringPrompt, /source 調査.*mode 判定に従う/);
      assert.match(authoringPrompt, /必要な場合の `character-notes\.md`/);
      assert.doesNotMatch(authoringPrompt, /検索不要.*調査/);

      const inputJson = await readFile(path.join(result.workspacePath, "input.json"), "utf8");
      assert.match(inputJson, /"skill": "withmate-character-authoring"/);
      assert.match(inputJson, /"skillPath": ".agents\/skills\/withmate-character-authoring"/);
      assert.doesNotMatch(inputJson, /userInstruction/);
      assert.doesNotMatch(inputJson, /[A-Z]:\\\\/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "authoring Sessionへコピーされた固定SkillがCharacter Kernel、必須検証、WithMate固有の除外境界をすべて含む"
  // oracle = { type = "adr", ref = "docs/adr/011-character-authoring-kernel.md" }
  // failure_mode = "配布bundleの一部が旧版または欠落し、次回のAuthor / Improve Sessionが旧品質契約、hidden input、または責務外の生成処理を使う"
  // scope = "character-authoring-skill-distribution"
  // lifecycle = "permanent"
  // distinction = "配布処理の存在だけでなく、実際のprovider workspaceにコピーされたSkill全体の品質契約を観測する"
  // @end-test-value
  it("配布後の固定 Skill は Character Kernel と検証・除外境界を一式持つ", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace(defaultDefinition, null);
    const service = createService({
      getCharacterDirectory: () => workspacePath,
      getCharacter: () => buildCharacter({ notesMarkdown: "" }),
    });

    try {
      const result = await service.startSession({
        mode: "create",
        characterId: "char-muse",
        provider: "codex",
      });
      const copiedSkillRoot = path.join(
        result.workspacePath,
        ".agents",
        "skills",
        CHARACTER_AUTHORING_SKILL_NAME,
      );
      const skillMarkdown = await readFile(path.join(copiedSkillRoot, "SKILL.md"), "utf8");
      const formatMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "character-format.md"),
        "utf8",
      );
      const rubricMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "authoring-rubric.md"),
        "utf8",
      );
      const notesTemplate = await readFile(
        path.join(copiedSkillRoot, "templates", "character-notes.md"),
        "utf8",
      );

      assert.match(skillMarkdown, /選択の核 × 言語アイデンティティ × 状態変調/);
      assert.match(skillMarkdown, /既存Characterへ自動migrationや一括rewriteを要求しない/);
      for (const [boundary, pattern] of [
        ["permanent Character output", /`character\.md`と`character-notes\.md`以外を編集しない/],
        ["Character directory scope", /app database、packaged resource、このCharacter directory外のfileを編集しない/],
        ["config.toml hidden input", /`config\.toml`.*hidden inputとして使わない/],
        ["Memory hidden input", /Memory.*hidden inputとして使わない/],
        ["unrelated Session history hidden input", /unrelated Session \/ companion \/ chat history.*hidden inputとして使わない/],
        ["Character root artifacts", /Character rootへsource report、review checklist、manifest、pack directory、Zipを作らない/],
        ["Notion sync", /Notion同期.*必須処理にしない/],
        ["parent and child pages", /親・子page作成.*必須処理にしない/],
        ["CharacterPack Zip", /CharacterPack Zipの作成・展開検証.*必須処理にしない/],
        ["asset generation and distribution", /asset生成・添付・配布.*必須処理にしない/],
        ["catalog color metadata", /catalog metadataの色更新.*必須処理にしない/],
      ] as const) {
        assert.match(skillMarkdown, pattern, `${boundary} boundary must be distributed`);
      }
      for (const section of [
        "Identity Core",
        "Attention and Appraisal",
        "Social Intent / User Relationship",
        "Emotional Dynamics and Core Tensions",
        "Thinking and Action Style",
        "Identity Invariants",
        "Distributional Tendencies",
        "Triggered Markers",
        "State Modulation",
        "Character Priority",
        "Minimal Reliability",
      ]) {
        assert.match(formatMarkdown, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.match(formatMarkdown, /旧sectionや既存`Examples`を含むCharacterも引き続き読み込める/);
      for (const validation of [
        "Name-swap",
        "Phrase-suppression",
        "Voice-restoration",
        "Unseen-scenario",
        "Paraphrase diversity",
        "Marker-overuse",
        "Core-tension",
        "Long-form retention",
        "Relationship smoke test",
      ]) {
        assert.match(rubricMarkdown, new RegExp(validation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.match(notesTemplate, /## Observation Log/);
      assert.match(notesTemplate, /## Character Kernel Derivation/);
      assert.match(notesTemplate, /## Revision Guardrails/);
      assert.match(notesTemplate, /## Validation Summary/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("improve mode の開始時に既存 Character files を書き換えない", async () => {
    const existingDefinition = "# Existing character\r\n";
    const existingNotes = "# Existing notes\r\n";
    const { tempDirectory, workspacePath } = await createWorkspace(existingDefinition, existingNotes);
    const service = createService({
      getCharacterDirectory: () => workspacePath,
      getCharacter: () => buildCharacter({
        definitionMarkdown: existingDefinition,
        notesMarkdown: existingNotes,
      }),
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });

      assert.equal(await readFile(path.join(result.workspacePath, "character.md"), "utf8"), existingDefinition);
      assert.equal(await readFile(path.join(result.workspacePath, "character-notes.md"), "utf8"), existingNotes);
      assert.equal(result.session.characterId, "char-muse");
      assert.equal(result.workspacePath, path.join(tempDirectory, "characters", "char-muse"));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("optional な character-notes.md がなくても起動し、Skill が authoring 時の初期化手順を持つ", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace(defaultDefinition, null);
    const service = createService({
      getCharacterDirectory: () => workspacePath,
      getCharacter: () => buildCharacter({ notesMarkdown: "" }),
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });

      await assert.rejects(
        () => readFile(path.join(workspacePath, "character-notes.md"), "utf8"),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      const skillMarkdown = await readFile(
        path.join(result.workspacePath, ".agents", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
        "utf8",
      );
      assert.match(skillMarkdown, /## Targeted Update Workflow/);
      assert.match(skillMarkdown, /## Full Authoring Workflow/);
      assert.match(skillMarkdown, /character-notes\.md` は optional/);
      assert.match(skillMarkdown, /templates\/character-notes\.md/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("provider 指定時も model / depth は session 側の既定値解決に任せる", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace();
    const createdInputs: CreateSessionInput[] = [];
    const service = createService({
      getCharacterDirectory: () => workspacePath,
      async createSession(input) {
        createdInputs.push(input);
        return buildNewSession(input);
      },
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: " copilot ",
      });

      assert.equal(createdInputs[0]?.provider, "copilot");
      assert.equal(createdInputs[0]?.model, undefined);
      assert.equal(createdInputs[0]?.reasoningEffort, undefined);
      const skillMarkdown = await readFile(
        path.join(result.workspacePath, ".github", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
        "utf8",
      );
      assert.match(skillMarkdown, /name: withmate-character-authoring/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("provider 確定から workspace 準備と Session 保存まで Settings 更新と直列化する", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace(defaultDefinition, null);
    const coordinator = new ProviderRuntimeOperationCoordinator();
    let providerEnabled = true;
    const service = createService({
      resolveProvider(providerId) {
        if (!providerEnabled) {
          throw new Error("選択した Character authoring provider は Settings で無効になっているよ。");
        }
        return providerId;
      },
      runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
      getCharacter: () => buildCharacter({ notesMarkdown: "" }),
      getCharacterDirectory: () => workspacePath,
      async createSession(input) {
        if (!providerEnabled) {
          throw new Error("選択した Character authoring provider は Settings で無効になっているよ。");
        }
        return buildNewSession(input);
      },
    });

    try {
      const authoringPromise = service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });
      const settingsUpdatePromise = coordinator.runExclusive(() => {
        providerEnabled = false;
      });

      const result = await authoringPromise;
      await settingsUpdatePromise;

      assert.equal(result.session.provider, "codex");
      assert.equal(providerEnabled, false);
      assert.match(await readFile(path.join(workspacePath, "AGENTS.md"), "utf8"), /Character Authoring Workspace/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("provider 未指定の authoring session は workspace mutation 前に拒否する", async () => {
    let characterResolutionCount = 0;
    let sessionCreationCount = 0;
    const service = createService({
      getCharacter: () => {
        characterResolutionCount += 1;
        return null;
      },
      getCharacterDirectory: () => "C:/unexpected",
      async createSession(input) {
        sessionCreationCount += 1;
        return buildNewSession(input);
      },
    });
    const input = {
      mode: "improve",
      characterId: "char-muse",
      provider: undefined,
    } as unknown as Parameters<CharacterAuthoringService["startSession"]>[0];

    await assert.rejects(() => service.startSession(input), /provider/);
    assert.equal(characterResolutionCount, 0);
    assert.equal(sessionCreationCount, 0);
  });

  it("未知の authoring mode は workspace mutation 前に拒否する", async () => {
    let characterResolutionCount = 0;
    let sessionCreationCount = 0;
    const service = createService({
      getCharacter: () => {
        characterResolutionCount += 1;
        return null;
      },
      getCharacterDirectory: () => "C:/unexpected",
      async createSession(input) {
        sessionCreationCount += 1;
        return buildNewSession(input);
      },
    });

    await assert.rejects(
      () => service.startSession({
        mode: "unknown",
        characterId: "char-muse",
        provider: "codex",
      } as unknown as Parameters<CharacterAuthoringService["startSession"]>[0]),
      /mode/,
    );
    assert.equal(characterResolutionCount, 0);
    assert.equal(sessionCreationCount, 0);
  });

  it("無効または不明な provider の authoring session は workspace mutation 前に拒否する", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace(defaultDefinition, null);
    let sessionCreationCount = 0;
    const service = createService({
      resolveProvider(providerId) {
        if (providerId === "unknown-provider") {
          throw new Error("選択した Character authoring provider が model catalog に見つからないよ。");
        }
        throw new Error("選択した Character authoring provider は Settings で無効になっているよ。");
      },
      getCharacterDirectory: () => workspacePath,
      async createSession() {
        sessionCreationCount += 1;
        throw new Error("選択した Character authoring provider は Settings で無効になっているよ。");
      },
    });

    try {
      for (const [provider, expectedError] of [
        ["copilot", /provider.*無効/],
        ["unknown-provider", /provider.*model catalog/],
      ] as const) {
        await assert.rejects(
          () => service.startSession({
            mode: "improve",
            characterId: "char-muse",
            provider,
          }),
          expectedError,
        );
      }
      assert.equal(sessionCreationCount, 0);
      await assert.rejects(
        () => readFile(path.join(workspacePath, "AGENTS.md"), "utf8"),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      await assert.rejects(
        () => readFile(
          path.join(workspacePath, ".github", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
          "utf8",
        ),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("characterId 未確定の authoring session は開始しない", async () => {
    const service = createService({
      getCharacter: () => null,
      getCharacterDirectory: () => null,
    });

    await assert.rejects(
      () => service.startSession({
        mode: "create",
        provider: "codex",
      }),
      /保存済み Character/,
    );
  });

  it("保存済み Character が見つからない場合は workspace と session を作らない", async () => {
    let workspaceResolutionCount = 0;
    let sessionCreationCount = 0;
    const service = createService({
      getCharacter: () => null,
      getCharacterDirectory: () => {
        workspaceResolutionCount += 1;
        return "C:/unexpected";
      },
      async createSession(input) {
        sessionCreationCount += 1;
        return buildNewSession(input);
      },
    });

    await assert.rejects(
      () => service.startSession({
        mode: "improve",
        characterId: "missing-character",
        provider: "codex",
      }),
      /保存済み Character/,
    );
    assert.equal(workspaceResolutionCount, 0);
    assert.equal(sessionCreationCount, 0);
  });

  it("authoring 補助ファイルと Skill directory は次回起動時に作り直す", async () => {
    const { tempDirectory, workspacePath } = await createWorkspace();
    const service = createService({
      getCharacterDirectory: () => workspacePath,
    });

    try {
      await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });

      await writeFile(path.join(workspacePath, "AGENTS.md"), "stale agents", "utf8");
      await writeFile(path.join(workspacePath, "AUTHORING_PROMPT.md"), "stale prompt", "utf8");
      await writeFile(path.join(workspacePath, "input.json"), "{\"stale\":true}\n", "utf8");
      const staleSkillFilePath = path.join(
        workspacePath,
        ".agents",
        "skills",
        CHARACTER_AUTHORING_SKILL_NAME,
        "STALE.md",
      );
      await mkdir(path.dirname(staleSkillFilePath), { recursive: true });
      await writeFile(staleSkillFilePath, "stale", "utf8");

      await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        provider: "codex",
      });

      assert.match(await readFile(path.join(workspacePath, "AGENTS.md"), "utf8"), /Character Authoring Workspace/);
      assert.match(await readFile(path.join(workspacePath, "AUTHORING_PROMPT.md"), "utf8"), /Muse Character Authoring/);
      assert.match(await readFile(path.join(workspacePath, "input.json"), "utf8"), /"skill": "withmate-character-authoring"/);
      await assert.rejects(() => readFile(staleSkillFilePath, "utf8"));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
