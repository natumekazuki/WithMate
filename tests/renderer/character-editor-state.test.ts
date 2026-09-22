import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CHARACTER_THEME, type CharacterDetail } from "../../src-shared/character/character-catalog.js";
import {
  CHARACTER_DEFINITION_MAX_CHARACTERS,
  countCharacterDefinitionCharacters,
  validateCharacterDefinitionMarkdown,
} from "../../src-shared/character/character-definition.js";
import {
  buildDefaultCharacterDefinition,
  areCharacterEditorDraftsEqual,
  buildCharacterEditorValidationSummary,
  buildCreateCharacterInputFromDraft,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  getCharacterIconDraftValidationMessage,
  isCharacterEditorDraftDirty,
  replaceCharacterDefinitionDraft,
  reconcileCharacterEditorDraftAfterSave,
  shouldBlockCharacterEditorBeforeUnload,
  updateCharacterEditorDraft,
} from "../../src/character-editor/character-editor-state.js";

describe("Character editor state", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "新規draftがhard format内でCharacter Kernelの推奨構造を初期化し、固定返答Examplesを生成しない"
  // oracle = { type = "adr", ref = "docs/adr/011-character-authoring-kernel.md" }
  // failure_mode = "Author with Agentの開始前に旧Examples中心のdefault定義が保存され、新しいfull authoring品質契約と食い違う"
  // scope = "character-editor-new-draft"
  // lifecycle = "permanent"
  // @end-test-value
  it("新規 draft は V5 character.md の初期本文を作る", () => {
    const draft = createNewCharacterEditorDraft("Mia");

    assert.equal(draft.mode, "create");
    assert.equal(draft.name, "Mia");
    assert.match(draft.definitionMarkdown, /schema: withmate-character-v5/);
    assert.match(draft.definitionMarkdown, /name: "Mia"/);
    assert.match(draft.definitionMarkdown, /# Character Kernel/);
    assert.match(draft.definitionMarkdown, /## Experience Goal/);
    assert.match(draft.definitionMarkdown, /## Identity Core/);
    assert.match(draft.definitionMarkdown, /## Attention and Appraisal/);
    assert.match(draft.definitionMarkdown, /## Social Intent \/ User Relationship/);
    assert.match(draft.definitionMarkdown, /## Emotional Dynamics and Core Tensions/);
    assert.match(draft.definitionMarkdown, /## Thinking and Action Style/);
    assert.match(draft.definitionMarkdown, /### Identity Invariants/);
    assert.match(draft.definitionMarkdown, /### Distributional Tendencies/);
    assert.match(draft.definitionMarkdown, /### Triggered Markers/);
    assert.match(draft.definitionMarkdown, /## State Modulation/);
    assert.match(draft.definitionMarkdown, /## Character Priority/);
    assert.match(draft.definitionMarkdown, /## Minimal Reliability/);
    assert.doesNotMatch(draft.definitionMarkdown, /^## Examples$/m);
    assert.doesNotMatch(draft.definitionMarkdown, /## Coding Agent Behavior/);
    assert.doesNotMatch(draft.definitionMarkdown, /## Knowledge Policy/);
    assert.doesNotMatch(draft.definitionMarkdown, /## Runtime Notes/);
    assert.deepEqual(validateCharacterDefinitionMarkdown(draft.definitionMarkdown), []);
    assert.ok(countCharacterDefinitionCharacters(draft.definitionMarkdown) <= CHARACTER_DEFINITION_MAX_CHARACTERS);
    assert.match(buildDefaultCharacterDefinition("   "), /name: "New Character"/);
    assert.match(draft.notesMarkdown, /## Observation Log/);
    assert.match(draft.notesMarkdown, /## Revision Guardrails/);
    assert.match(draft.notesMarkdown, /## Validation Summary/);
    assert.doesNotMatch(draft.notesMarkdown, /New Character/);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "name以外が未編集の新規draftだけを新しい名前のdefault Kernelへ再生成し、編集済み本文は上書きしない"
  // oracle = { type = "contract", ref = "docs/design/character-definition-format.md#update-policy" }
  // failure_mode = "name変更でdefault本文がstaleになる、またはユーザーが編集したcharacter.mdをdefault Kernelで上書きする"
  // scope = "character-editor-draft-name-update"
  // lifecycle = "permanent"
  // @end-test-value
  it("未編集の新規 character.md だけ name 変更に追従する", () => {
    const draft = createNewCharacterEditorDraft();
    const renamed = updateCharacterEditorDraft(draft, { name: "Mia" });

    assert.equal(renamed.name, "Mia");
    assert.match(renamed.definitionMarkdown, /name: "Mia"/);
    assert.match(renamed.definitionMarkdown, /Miaと気心の知れた相手/);
    assert.match(renamed.definitionMarkdown, /# Character Kernel/);
    assert.doesNotMatch(renamed.notesMarkdown, /New Character/);

    const edited = updateCharacterEditorDraft(
      { ...draft, definitionMarkdown: `${draft.definitionMarkdown}\n## Custom\n` },
      { name: "Noa" },
    );
    assert.equal(edited.name, "Noa");
    assert.match(edited.definitionMarkdown, /name: "New Character"/);
    assert.match(edited.definitionMarkdown, /## Custom/);
  });

  it("persisted detail から dirty 判定できる", () => {
    const detail: CharacterDetail = {
      id: "mia",
      name: "Mia",
      description: "first",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      state: "active",
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      archivedAt: null,
      definitionMarkdown: [
        "---",
        "schema: withmate-character-v5",
        "name: \"Mia\"",
        "description: \"first\"",
        "---",
        "",
        "# Profile",
      ].join("\n"),
      notesMarkdown: "# Character Notes\n",
    };
    const draft = createCharacterEditorDraftFromDetail(detail);

    assert.equal(isCharacterEditorDraftDirty(draft, detail), false);
    assert.equal(isCharacterEditorDraftDirty({ ...draft, description: "changed" }, detail), true);
    assert.equal(isCharacterEditorDraftDirty({ ...draft, state: "archived" }, detail), true);
    assert.equal(isCharacterEditorDraftDirty(createNewCharacterEditorDraft(), null), true);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存要求の応答が到着しても、要求開始後に行われたCharacter編集を保存済みdraftで上書きしない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
  // fault = "保存中に追加した定義・notes・metadata編集が保存済みの応答で失われ、未保存状態がSavedとして扱われる"
  // observable = "reconciled CharacterEditorDraft と draft equality"
  // observation_boundary = "public-boundary"
  // scope = "character-editor-save-reconciliation"
  // lifecycle = "permanent"
  // impact = "新しい編集の消失と、次の保存を不要にする誤ったSaved状態を防ぐ"
  // distinction = "保存APIの型検査では検出できない、応答とローカルdraftの時間的競合を確認する"
  // @end-test-value
  it("保存中に追加した編集を保存済みdraftで上書きしない", () => {
    const savedDetail: CharacterDetail = {
      id: "mia",
      name: "Mia",
      description: "saved",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      state: "active",
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      archivedAt: null,
      definitionMarkdown: "---\nschema: withmate-character-v5\nname: \"Mia\"\ndescription: \"saved\"\n---\n\n# Saved",
      notesMarkdown: "# Saved notes",
    };
    const savedDraft = createCharacterEditorDraftFromDetail(savedDetail);
    const draftAtSave = { ...savedDraft, description: "before save" };
    const currentDraft = { ...draftAtSave, definitionMarkdown: `${draftAtSave.definitionMarkdown}\n## New edit` };

    const reconciled = reconcileCharacterEditorDraftAfterSave(savedDraft, draftAtSave, currentDraft);

    assert.equal(areCharacterEditorDraftsEqual(reconciled, currentDraft), true);
    assert.equal(isCharacterEditorDraftDirty(reconciled, savedDetail), true);
  });

  it("persisted detail 読み込み時は character.md frontmatter の metadata を editor draft に反映する", () => {
    const detail: CharacterDetail = {
      id: "mia",
      name: "Old Mia",
      description: "old description",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      state: "active",
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      archivedAt: null,
      definitionMarkdown: [
        "---",
        "schema: withmate-character-v5",
        "name: \"Frontmatter Mia\"",
        "description: \"frontmatter description\"",
        "---",
        "",
        "# Profile",
      ].join("\n"),
      notesMarkdown: "# Character Notes\n",
    };

    const draft = createCharacterEditorDraftFromDetail(detail);

    assert.equal(draft.name, "Frontmatter Mia");
    assert.equal(draft.description, "frontmatter description");
    assert.equal(isCharacterEditorDraftDirty(draft, detail), true);
  });

  it("上限超過の persisted character.md は catalog metadata を保ち Improve の dirty gate を開ける", () => {
    const definitionMarkdown = [
      "---",
      "schema: withmate-character-v5",
      "name: \"Muse\"",
      "description: \"stored description\"",
      "---",
      "",
      "# Profile",
      "あ".repeat(CHARACTER_DEFINITION_MAX_CHARACTERS),
    ].join("\n");
    const detail: CharacterDetail = {
      id: "muse",
      name: "Muse",
      description: "stored description",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      state: "active",
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      archivedAt: null,
      definitionMarkdown,
      notesMarkdown: "",
    };

    assert.ok(countCharacterDefinitionCharacters(definitionMarkdown) > CHARACTER_DEFINITION_MAX_CHARACTERS);

    const draft = createCharacterEditorDraftFromDetail(detail);

    assert.equal(draft.name, detail.name);
    assert.equal(draft.description, detail.description);
    assert.equal(isCharacterEditorDraftDirty(draft, detail), false);
  });

  it("close 確認済みの beforeunload は dirty draft でもブロックしない", () => {
    assert.equal(shouldBlockCharacterEditorBeforeUnload({ dirty: true, saving: false, confirmedClose: false }), true);
    assert.equal(shouldBlockCharacterEditorBeforeUnload({ dirty: true, saving: true, confirmedClose: false }), false);
    assert.equal(shouldBlockCharacterEditorBeforeUnload({ dirty: false, saving: false, confirmedClose: false }), false);
    assert.equal(shouldBlockCharacterEditorBeforeUnload({ dirty: true, saving: false, confirmedClose: true }), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "新規・置換iconはlocal PNG/JPG/JPEGだけを受け入れ、既存の同一icon参照は保持し、不正形式を英語issueへ投影する"
  // oracle = { type = "contract", ref = "docs/design/character-storage.md#data-safety" }
  // fault = "remote/data URIや非画像形式を新規iconとして許可する、既存pathを不正扱いする、または修正可能なvalidation理由を失う"
  // observable = "getCharacterIconDraftValidationMessageのnullまたはlocal-path/format error message"
  // observation_boundary = "public-boundary"
  // scope = "character-editor-icon-validation"
  // lifecycle = "permanent"
  // impact = "保存時のicon materialization境界を守り、ユーザーが不正入力の原因を判別して修正できる"
  // distinction = "拡張子だけでなく、既存iconの同値path・URI形式・大文字小文字を含むvalidation投影を確認する"
  // @end-test-value
  it("新規・置換 icon は PNG/JPEG の local path に制限し、既存 icon はそのまま許可する", () => {
    assert.equal(getCharacterIconDraftValidationMessage("", null), null);
    assert.equal(getCharacterIconDraftValidationMessage("C:\\icons\\muse.PNG", null), null);
    assert.equal(getCharacterIconDraftValidationMessage("/icons/muse.jpg", null), null);
    assert.equal(getCharacterIconDraftValidationMessage("icons/muse.jpeg", null), null);
    assert.equal(
      getCharacterIconDraftValidationMessage("file:///icons/muse.png", null),
      "Character icon must use a local file path.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage("/icons/muse.webp", null),
      "Character icon must be a PNG, JPG, or JPEG image file.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage("  /legacy/muse.webp  ", "/legacy/muse.webp"),
      null,
    );
    assert.equal(
      getCharacterIconDraftValidationMessage(
        "c:/characters/muse/ICON.webp",
        "C:\\Characters\\Muse\\icon.webp",
      ),
      null,
    );
    assert.equal(
      getCharacterIconDraftValidationMessage(
        "//server/share/icon.webp",
        "//Server/Share/icon.webp",
      ),
      null,
    );
    assert.equal(
      getCharacterIconDraftValidationMessage("/legacy/Muse.webp", "/legacy/muse.webp"),
      "Character icon must be a PNG, JPG, or JPEG image file.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage(
        "DATA:image/webp;base64,AAAA",
        "data:image/webp;base64,AAAA",
      ),
      "Character icon must use a local file path.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage(
        "data:image\\webp;base64,AAAA",
        "data:image/webp;base64,AAAA",
      ),
      "Character icon must use a local file path.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage(
        "/legacy/muse\\icon.webp",
        "/legacy/muse/icon.webp",
      ),
      "Character icon must be a PNG, JPG, or JPEG image file.",
    );
    assert.equal(
      getCharacterIconDraftValidationMessage("/legacy/other.gif", "/legacy/muse.webp"),
      "Character icon must be a PNG, JPG, or JPEG image file.",
    );
  });

  it("create payload はDefault指定を含めない", () => {
    const draft = createNewCharacterEditorDraft("Mia");

    assert.deepEqual(buildCreateCharacterInputFromDraft(draft), {
      name: "Mia",
      description: "",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      definitionMarkdown: draft.definitionMarkdown,
      notesMarkdown: draft.notesMarkdown,
    });
    assert.equal("setDefault" in buildCreateCharacterInputFromDraft(draft), false);
  });

  it("create payload は character.md frontmatter の metadata を優先する", () => {
    const draft = {
      ...createNewCharacterEditorDraft("Mia"),
      definitionMarkdown: [
        "---",
        "schema: withmate-character-v5",
        "name: \"Frontmatter Mia\"",
        "description: \"frontmatter description\"",
        "---",
        "",
        "# Profile",
      ].join("\n"),
    };

    const input = buildCreateCharacterInputFromDraft(draft);

    assert.equal(input.name, "Frontmatter Mia");
    assert.equal(input.description, "frontmatter description");
  });

  it("import / replace は character.md draft と任意 metadata を置き換える", () => {
    const draft = createNewCharacterEditorDraft("Mia");
    const replaced = replaceCharacterDefinitionDraft(draft, "---\nschema: withmate-character-v5\nname: Noa\n---\n\n# Noa\n");

    assert.match(replaced.definitionMarkdown, /name: Noa/);
    assert.equal(replaced.notesMarkdown, draft.notesMarkdown);
    assert.equal(replaced.name, "Mia");

    const metadataReplaced = replaceCharacterDefinitionDraft(draft, replaced.definitionMarkdown, {
      name: "Noa",
      description: "Imported",
    });
    assert.equal(metadataReplaced.name, "Noa");
    assert.equal(metadataReplaced.description, "Imported");
  });

  it("definition / notes validation issue を集約する", () => {
    const summary = buildCharacterEditorValidationSummary({
      ...createNewCharacterEditorDraft("Mia"),
      definitionMarkdown: "# missing frontmatter",
      notesMarkdown: "invalid\0notes",
    });

    assert.ok(summary.definitionIssues.length > 0);
    assert.ok(summary.notesIssues.length > 0);
    assert.equal(summary.blockingIssues.length, summary.definitionIssues.length + summary.notesIssues.length);
  });
});
