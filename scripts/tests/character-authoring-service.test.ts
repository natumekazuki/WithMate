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

function assertSectionContains(
  markdown: string,
  heading: string,
  patterns: readonly RegExp[],
): void {
  const headingIndex = markdown.indexOf(heading);
  assert.notEqual(headingIndex, -1, `${heading} must be present`);
  const headingLevel = heading.match(/^#+/)?.[0].length;
  assert.ok(headingLevel, `${heading} must be a Markdown heading`);
  const sectionStart = headingIndex + heading.length;
  const nextSectionOffset = markdown.slice(sectionStart).search(
    new RegExp(`^#{1,${headingLevel}}\\s`, "m"),
  );
  const section = nextSectionOffset === -1
    ? markdown.slice(headingIndex)
    : markdown.slice(headingIndex, sectionStart + nextSectionOffset);
  for (const pattern of patterns) {
    assert.match(section, pattern, `${heading} must contain ${pattern}`);
  }
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

  // @test-value v2
  // kind = "contract"
  // claim = "Character authoring開始時に保存済み定義を保持したworkspaceとcharacter-authoring sessionを作成する"
  // oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md: workspace preparation" }
  // fault = "生成wrapperまたはinputのmode・Skill path・対象Characterが誤り、保存済みCharacterを壊すか実行可能なauthoring workspaceを作れない"
  // observable = "作成されたworkspaceのcharacter.md、character-notes.md、AGENTS.md、AUTHORING_PROMPT.md、input.json、copied SkillとsessionのsessionKind/characterId/provider"
  // observation_boundary = "component-behavior"
  // scope = "character-authoring-workspace-start"
  // lifecycle = "permanent"
  // impact = "authoring開始時の既存定義保持と、run固有の生成wrapper境界が崩れる"
  // distinction = "workspace準備・生成wrapper・session作成を実際のstartSession結果と生成ファイルで観測する"
  // @end-test-value
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
      assert.match(authoringPrompt, /詳細な作成・検証手順は固定 Skill と参照資料に従う/);
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

  // @test-value v2
  // kind = "contract"
  // claim = "Codexのcreate authoring workspaceへ固定Skill一式と、run固有の生成wrapper境界が配布される"
  // oracle = { type = "adr", ref = "docs/adr/011-character-authoring-kernel.md" }
  // fault = "Codexのcreate workspaceへ配布されるbundleまたは生成指示の主要部分が旧版または欠落し、次回のAuthor / Improve Sessionが旧品質契約、作業中のCharacter契約、hidden input、または責務外の生成処理を使う"
  // observable = "Codexのcreate workspaceへコピーされたSKILL.md、references、templatesの一式、およびAGENTS.md、AUTHORING_PROMPT.mdのmode・Skill path・入力・成果物境界"
  // observation_boundary = "component-behavior"
  // scope = "character-authoring-workspace-codex-create"
  // lifecycle = "permanent"
  // impact = "既存の良さを保持した対話・作業校正、未確認事項の正確な報告、成果物形式との分離、責務外のファイルやhidden inputの除外が次回Sessionへ伝わらない"
  // distinction = "配布処理の存在だけでなく、実際のCodex create workspaceにコピーされた列挙済みreferenceと生成指示の対話・作業契約を観測する"
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
      const runtimePhilosophyMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "runtime-philosophy.md"),
        "utf8",
      );
      const improveExistingCharacterMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "improve-existing-character.md"),
        "utf8",
      );
      const sourceAndRightsPolicyMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "source-and-rights-policy.md"),
        "utf8",
      );
      const reviewChecklistMarkdown = await readFile(
        path.join(copiedSkillRoot, "references", "review-checklist.md"),
        "utf8",
      );
      const agentsMarkdown = await readFile(path.join(result.workspacePath, "AGENTS.md"), "utf8");
      const authoringPrompt = await readFile(path.join(result.workspacePath, "AUTHORING_PROMPT.md"), "utf8");

      assert.match(skillMarkdown, /選択の核 × 言語アイデンティティ × 状態変調/);
      assert.match(skillMarkdown, /collaborative authoring/);
      assert.match(skillMarkdown, /Baseline Presence/);
      assert.match(skillMarkdown, /Likeness Anchor/);
      assert.match(skillMarkdown, /Marker-underuse/);
      assert.match(skillMarkdown, /Multi-turn continuity/);
      assert.match(skillMarkdown, /Regression \/ Protected-trait/);
      assert.match(skillMarkdown, /conversation-and-work/);
      assert.match(skillMarkdown, /Task-execution \/ Conversation-work Continuity/);
      assert.match(skillMarkdown, /Work Likeness \/ Task Integrity \/ Collaboration Comfort/);
      assert.match(skillMarkdown, /synthetic-event.*recorded-tool-replay.*live-tool-execution/);
      assert.match(skillMarkdown, /既存Characterへ自動migrationや一括rewriteを要求しない/);
      assert.match(runtimePhilosophyMarkdown, /## Baseline Presence and Likeness Anchors/);
      assert.match(runtimePhilosophyMarkdown, /habitual/);
      assert.match(runtimePhilosophyMarkdown, /reactive/);
      assert.match(runtimePhilosophyMarkdown, /signature/);
      assert.match(runtimePhilosophyMarkdown, /## Association and Meme Response/);
      assert.match(runtimePhilosophyMarkdown, /## Character Presence during Work/);
      assert.match(runtimePhilosophyMarkdown, /### Work-session Validation/);
      assertSectionContains(runtimePhilosophyMarkdown, "### Work-session Validation", [
        /Task-execution \/ Conversation-work Continuity/,
        /synthetic-event \/ recorded-tool-replay \/ live-tool-execution/,
        /Work Likeness（らしさ）、Task Integrity（作業の整合・信頼性）、Collaboration Comfort（一緒に進める心地よさ）を別評価する/,
        /内部思考ではなく観察可能な行為と発話を検証する/,
      ]);
      assert.match(improveExistingCharacterMarkdown, /## 4\. Separate Preserve \/ Revise \/ Investigate/);
      assert.match(improveExistingCharacterMarkdown, /## 8\. Compare Outputs and Revise by Cause/);
      assert.match(improveExistingCharacterMarkdown, /Task-execution \/ Conversation-work Continuity/);
      assert.match(improveExistingCharacterMarkdown, /Work Likeness \/ Task Integrity \/ Collaboration Comfort/);
      assert.match(sourceAndRightsPolicyMarkdown, /user-observation \/ user-preference \/ output-feedback \/ authoring-inference/);
      assert.match(sourceAndRightsPolicyMarkdown, /## Meme and Association Sources/);
      assert.match(sourceAndRightsPolicyMarkdown, /## Work-context Transfer and Task Evidence/);
      assertSectionContains(sourceAndRightsPolicyMarkdown, "## Work-context Transfer and Task Evidence", [
        /authoring-inference/,
        /本人の開発経験、技術的な能力、未確認のtool使用歴を創作しない/,
        /作業品質の低下、検証省略、わざと起こすミスへ変換しない/,
        /synthetic-event、recorded-tool-replay、live-tool-execution/,
        /非公開の内部思考を取得する工程にはしない/,
        /標準Packは引き続き2ファイルのみ/,
      ]);
      assert.match(reviewChecklistMarkdown, /## Evaluation Provenance/);
      assert.match(reviewChecklistMarkdown, /Marker-underuse/);
      assert.match(reviewChecklistMarkdown, /Multi-turn continuity \/ Return-to-baseline/);
      assert.match(reviewChecklistMarkdown, /Relationship smoke test（7場面）/);
      assert.match(reviewChecklistMarkdown, /## Work-session Validation/);
      assert.match(reviewChecklistMarkdown, /synthetic-event \/ recorded-tool-replay \/ live-tool-execution/);
      assertSectionContains(reviewChecklistMarkdown, "## Work-session Validation", [
        /task ID、候補revision、初期状態、依頼・受入条件・許可範囲を固定した/,
        /順調な経路と想定外の経路を扱い、中盤を含む時間順のセッションを確認した/,
        /検証のために無許可の本番変更・送信・課金・デプロイをしていない/,
        /Work Likenessを、必要な中盤発話・割り込み・復帰の出力から判定した/,
        /Task Integrityを、実行\/未実行・仮説\/確認・許可範囲・受入条件から独立に判定した/,
        /Collaboration Comfortを、発話密度・必要な共有・反復・作業の邪魔にならないことから判定した/,
        /Functional verificationを別記し、synthetic-eventやreplayのみではnot-runのままにした/,
        /非公開の内部思考の全文を検証資料として要求していない/,
        /logの秘密情報、改変・省略・保存\/参照不能の限界を明示した/,
      ]);
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
        const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(formatMarkdown, new RegExp(`^#{2,3} ${escapedSection}$`, "m"));
      }
      assert.match(formatMarkdown, /Baseline Presence/);
      assert.match(formatMarkdown, /^## Voice Rules$/m);
      assert.match(formatMarkdown, /Association and Meme Response/);
      assert.match(formatMarkdown, /作業中・集中・発見・見立ての修正/);
      assert.match(formatMarkdown, /Work-session Design/);
      assertSectionContains(formatMarkdown, "## No Fixed Response Examples", [
        /full authoringで作る`character\.md`へ完成返答の`Examples` sectionや場面別台詞集を置かない/,
        /smoke testの入力と出力は検証資料であり、runtime本文へコピーしない/,
        /作業イベントへの試演、実課題、toolログ、途中の完成台詞、テスト用コードはruntimeへ入れない/,
      ]);
      assert.match(formatMarkdown, /旧sectionや既存`Examples`を含むCharacterも引き続き読み込める/);
      for (const validation of [
        "Baseline / Anchor-presence",
        "Name-swap",
        "Combination",
        "Phrase-suppression",
        "Voice-restoration",
        "Marker-underuse",
        "Unseen-scenario",
        "Paraphrase Diversity",
        "Marker-overuse",
        "Core-tension",
        "Long-form Retention",
        "Multi-turn Continuity",
        "Return-to-baseline",
        "Regression / Protected-trait",
        "7-scene Relationship Smoke Test",
        "Task-execution / Conversation-work Continuity",
      ]) {
        assert.match(rubricMarkdown, new RegExp(validation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assertSectionContains(rubricMarkdown, "### Task-execution / Conversation-work Continuity Test", [
        /task ID.*候補revision.*初期ファイルや資料の版.*依頼・受入条件.*許可範囲/,
        /#### Temporal Coverage/,
        /#### Controlled Event Trials/,
        /未来の結果・原因・予定する反応を先に教えない/,
        /#### Live Task Trials and Mixed Dialogue/,
        /無許可の本番変更、外部送信、課金、デプロイは品質testに含めない/,
        /#### Three Independent Assessments/,
        /各軸を`pass \/ fail \/ inconclusive \/ not-run \/ not-applicable`で別記する/,
        /Functional verification（実編集・実行・受入条件の確認）は別欄/,
        /synthetic-eventやreplayだけの場合は`not-run`/,
        /非公開の内部思考の全文を求めず/,
      ]);
      assert.match(notesTemplate, /## Calibration Brief/);
      assert.match(notesTemplate, /## Likeness Anchors/);
      assert.match(notesTemplate, /## Feedback and Revision Log/);
      assert.match(notesTemplate, /^## Source Coverage$/m);
      assert.match(notesTemplate, /^## Evidence \/ Sources$/m);
      assert.match(notesTemplate, /## Observation Log/);
      assert.match(notesTemplate, /## Character Kernel Derivation/);
      assert.match(notesTemplate, /^## State Modulation$/m);
      assert.match(notesTemplate, /^## Runtime Handoff$/m);
      assert.match(notesTemplate, /^## Conflicts \/ Uncertainty$/m);
      assert.match(notesTemplate, /## Revision Guardrails/);
      assert.match(notesTemplate, /## Validation Summary/);
      assert.match(notesTemplate, /^### Environment and Provenance$/m);
      assert.match(notesTemplate, /^### Main Quality Test Details$/m);
      assert.match(notesTemplate, /Continuous Conversation Record/);
      assert.match(notesTemplate, /## Work-session Design/);
      assert.match(notesTemplate, /### Work-session Validation Record/);
      assert.match(notesTemplate, /Work Likeness/);
      assert.match(
        notesTemplate,
        /^\| Task-execution \/ Conversation-work Continuity（作業用途で必須） \|/m,
      );
      assertSectionContains(notesTemplate, "### Work-session Validation Record", [
        /Session \/ task ID、候補revision/,
        /ユーザー依頼・初期資料やfileの版・受入条件/,
        /tool構成・権限・初期状態の復元方法/,
        /Environment \/ Dialogue mode \/ Event source/,
        /Event source・元log・加工の有無/,
        /\| Work Likeness \|/,
        /\| Task Integrity \|/,
        /\| Collaboration Comfort \|/,
        /Functional verification: pass \/ fail \/ inconclusive \/ not-run \/ not-applicable/,
        /synthetic-eventやreplayのみのFunctional verificationはnot-run/,
        /非公開の内部思考は原出力証拠にしない/,
      ]);
      assert.match(agentsMarkdown, /編集対象はこの workspace 内の `character\.md` \/ `character-notes\.md` に限定する/);
      assert.match(agentsMarkdown, /詳細な authoring \/ validation 契約は固定 Skill と参照資料に従う/);
      assert.match(authoringPrompt, /詳細な作成・検証手順は固定 Skill と参照資料に従う/);
      assert.match(authoringPrompt, /Character directory 外の変更は、固定 Skill の boundary に従って作らない/);
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
