import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdditionalDirectoryItems,
  buildComposerReferenceInsertionState,
  buildPathReferenceInsertionState,
  buildSelectedPathReferenceInsertionState,
  pickComposerReferencePath,
  selectAdditionalDirectoryPath,
  resolveReferencePathsForInsertion,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
} from "../../src/chat/composer/session-composer-paths.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

// @test-value v2
// kind = "contract"
// claim = "Additional Directoryの選択は入力pathをMain APIで検証して返し、path未指定時だけ従来pickerの選択・取消を返す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory / Add Directory By Path" }
// fault = "入力pathでpickerを開く、検証を省く、空白を含むpathを破損する、pickerのbaseまたは取消を失う"
// observable = "選択結果、検証APIへ渡すpath、pickerのbaseと呼出回数"
// observation_boundary = "consumer"
// scope = "Main／Auxiliaryが共用するAdditional Directoryの選択"
// lifecycle = "permanent"
// impact = "pickerを使えない利用者のpath入力と既存pickerの双方を維持する"
// distinction = "filesystem検証testと異なり、入力方式によるAPI選択とpath転送を軽量な純粋adapter testで検出する"
// @end-test-value
test("Additional Directoryは入力pathを検証し、未指定時はpickerを使う", async () => {
  const validated: string[] = [];
  const picked: Array<string | null> = [];
  let pickerResult: string | null = "C:/selected";
  const api = {
    async validateWorkspaceDirectory(targetPath: string): Promise<WorkspaceDirectoryValidationResult> {
      validated.push(targetPath);
      return { valid: true };
    },
    async pickDirectory(base: string | null) {
      picked.push(base);
      return pickerResult;
    },
  };
  assert.equal(await selectAdditionalDirectoryPath({ directoryPath: "  C:\\作業\\shared folder  ", initialPath: "C:/base", api }), "C:\\作業\\shared folder");
  assert.deepEqual(validated, ["C:\\作業\\shared folder"]);
  assert.deepEqual(picked, []);
  assert.equal(await selectAdditionalDirectoryPath({ initialPath: "C:/base", api }), "C:/selected");
  pickerResult = null;
  assert.equal(await selectAdditionalDirectoryPath({ initialPath: null, api }), null);
  assert.deepEqual(picked, ["C:/base", null]);
  assert.equal(validated.length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "空入力、相対path、不存在、file、利用不可と検証API失敗はDirectory選択成功にならず、利用者向けの理由を伝播する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory By Path; src-shared/window/workspace-directory-validation.ts" }
// fault = "無効な入力を返す、検証失敗をpicker選択へ救済する、検証理由またはtransport errorを消す"
// observable = "選択Promiseのreject messageとpickerの呼出回数"
// observation_boundary = "consumer"
// scope = "入力path選択の失敗境界"
// lifecycle = "permanent"
// impact = "誤ったdirectoryの登録と検証失敗の成功扱いを防ぎ、再入力に必要な理由を渡す"
// distinction = "Main validatorのfilesystem判定でなく、判定結果とAPI失敗が登録前にrejectとして届くことを低コストに確認する"
// @end-test-value
test("Additional Directoryは無効pathと検証API失敗を理由付きで拒否する", async () => {
  let picked = 0;
  const cases = [
    ["empty", "Enter an absolute path."],
    ["not-absolute", "Enter an absolute path."],
    ["missing", "Path not found."],
    ["not-directory", "Not a directory."],
    ["unavailable", "Directory unavailable."],
  ] as const;
  for (const [reason, message] of cases) {
    await assert.rejects(selectAdditionalDirectoryPath({
      directoryPath: reason === "empty" ? " " : "invalid",
      initialPath: null,
      api: {
        validateWorkspaceDirectory: async () => ({ valid: false, reason }),
        pickDirectory: async () => { picked += 1; return "C:/unwanted"; },
      },
    }), { message });
  }
  await assert.rejects(selectAdditionalDirectoryPath({
    directoryPath: "C:/valid", initialPath: null,
    api: {
      validateWorkspaceDirectory: async () => { throw new Error("Validation unavailable"); },
      pickDirectory: async () => { picked += 1; return "C:/unwanted"; },
    },
  }), { message: "Validation unavailable" });
  assert.equal(picked, 0);
});

test("buildPathReferenceInsertionState は caret 位置に path reference を挿入する", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("before after", "before ".length, ["src/App.tsx"]),
    {
      draft: "before @src/App.tsx after",
      caret: "before @src/App.tsx ".length,
    },
  );
});

test("buildPathReferenceInsertionState は隣接文字との間に spacer を入れる", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("beforeafter", "before".length, ["src/App.tsx"]),
    {
      draft: "before @src/App.tsx after",
      caret: "before @src/App.tsx ".length,
    },
  );
});

test("buildPathReferenceInsertionState は空白を含む path reference を quote する", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("", 0, ["docs/my note.md", "src/App.tsx"]),
    {
      draft: "@\"docs/my note.md\" @src/App.tsx",
      caret: "@\"docs/my note.md\" @src/App.tsx".length,
    },
  );
});

test("buildPathReferenceInsertionState は reference path が空なら null を返す", () => {
  assert.equal(buildPathReferenceInsertionState("draft", 0, []), null);
});

test("buildComposerReferenceInsertionState は画像Markdownと通常pathを同じcaretへ挿入する", () => {
  assert.deepEqual(
    buildComposerReferenceInsertionState("確認後", "確認".length, [
      { path: "C:/session-files/cover image.png", presentation: "image" },
      { path: "C:/session-files/note.txt", presentation: "path" },
    ]),
    {
      draft: "確認 ![cover image.png](C:/session-files/cover%20image.png) @C:/session-files/note.txt 後",
      caret: "確認 ![cover image.png](C:/session-files/cover%20image.png) @C:/session-files/note.txt ".length,
    },
  );
});

test("buildSelectedPathReferenceInsertionState は選択 path を解決して挿入 state を作る", () => {
  assert.deepEqual(
    buildSelectedPathReferenceInsertionState({
      draft: "確認 ",
      caret: "確認 ".length,
      selectedPaths: [
        "C:\\workspace\\project\\src\\App.tsx",
        "D:\\assets\\cover image.png",
      ],
      workspacePath: "C:\\workspace\\project",
    }),
    {
      draft: "確認 @src/App.tsx @\"D:/assets/cover image.png\"",
      caret: "確認 @src/App.tsx @\"D:/assets/cover image.png\"".length,
    },
  );
  assert.equal(
    buildSelectedPathReferenceInsertionState({
      draft: "確認 ",
      caret: "確認 ".length,
      selectedPaths: [],
      workspacePath: "C:\\workspace\\project",
    }),
    null,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "additional directoryは正規化されたdisplay pathとroot/relative labelを作り、削除可否を保持する"
// oracle = { type = "contract", ref = "src/chat/composer/session-composer-paths.ts: buildAdditionalDirectoryItems" }
// fault = "trailing separatorやroot pathを誤表示するか、readonly一覧を削除可能として投影する"
// observable = "directory itemのkey、path、primary/secondary/title、canRemove"
// observation_boundary = "public-boundary"
// scope = "composer-additional-directory-items"
// lifecycle = "permanent"
// impact = "workspace補助directoryの識別と削除操作を誤る"
// distinction = "普通のexternal pathとroot path、remove allowed/readonlyを同時に確認する"
// @end-test-value
test("buildAdditionalDirectoryItems は additional directory display と remove state を作る", () => {
  assert.deepEqual(
    buildAdditionalDirectoryItems(
      [
        "C:\\workspace\\external\\",
        "C:/",
      ],
      true,
    ),
    [
      {
        key: "C:\\workspace\\external\\",
        path: "C:\\workspace\\external\\",
        primaryLabel: "external",
        secondaryLabel: "C:/workspace",
        title: "C:/workspace/external",
        canRemove: true,
      },
      {
        key: "C:/",
        path: "C:/",
        primaryLabel: "C:",
        secondaryLabel: "Root",
        title: "C:",
        canRemove: true,
      },
    ],
  );

  assert.equal(
    buildAdditionalDirectoryItems(["C:/workspace/readonly"], false)[0]?.canRemove,
    false,
  );
});

test("resolveReferencePathsForInsertion は workspace 内 path を相対化し workspace 外 path を正規化する", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(
      [
        "C:\\workspace\\project\\src\\App.tsx",
        "D:\\external\\note.md",
      ],
      "C:/workspace/project",
    ),
    [
      "src/App.tsx",
      "D:/external/note.md",
    ],
  );
});

test("resolveReferencePathsForInsertion は workspace がない場合 selected path を正規化する", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(["C:\\workspace\\project\\src\\App.tsx"], null),
    ["C:/workspace/project/src/App.tsx"],
  );
});

test("resolveReferencePathsForInsertion は空 workspace path を旧 workspace-relative 判定として扱う", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(["/workspace/project/src/App.tsx"], ""),
    ["workspace/project/src/App.tsx"],
  );
});

test("resolvePickedPathBaseDirectory は file picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("file", "C:\\workspace\\project\\src\\App.tsx"),
    "C:\\workspace\\project\\src",
  );
});

test("resolvePickedPathBaseDirectory は image picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("image", "/workspace/project/assets/icon.png"),
    "/workspace/project/assets",
  );
});

test("resolvePickedPathBaseDirectory は folder picker の選択 path をそのまま返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("folder", "/workspace/project/docs"),
    "/workspace/project/docs",
  );
});

test("pickComposerReferencePath は kind に対応する picker API を呼び分ける", async () => {
  const calls: Array<{ method: string; initialPath: string | null }> = [];
  const picker = {
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickDirectory", initialPath: initialPath ?? null });
      return "folder-result";
    },
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickFile", initialPath: initialPath ?? null });
      return "file-result";
    },
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickImageFile", initialPath: initialPath ?? null });
      return "image-result";
    },
  };

  const inputs: Array<{ kind: ComposerPathPickerKind; expectedPath: string; method: string }> = [
    { kind: "file", expectedPath: "file-result", method: "pickFile" },
    { kind: "folder", expectedPath: "folder-result", method: "pickDirectory" },
    { kind: "image", expectedPath: "image-result", method: "pickImageFile" },
  ];

  for (const input of inputs) {
    assert.equal(
      await pickComposerReferencePath(input.kind, "C:\\workspace", picker),
      input.expectedPath,
    );
    assert.deepEqual(calls.at(-1), { method: input.method, initialPath: "C:\\workspace" });
  }
});

test("pickComposerReferencePath は null initialPath を picker API にそのまま渡す", async () => {
  const calls: Array<string | null> = [];
  const picker = {
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
  };

  assert.equal(await pickComposerReferencePath("file", null, picker), null);
  assert.deepEqual(calls, [null]);
});
