import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdditionalDirectoryItems,
  buildComposerReferenceInsertionState,
  buildPathReferenceInsertionState,
  buildSelectedPathReferenceInsertionState,
  pickComposerReferencePath,
  resolveReferencePathsForInsertion,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
} from "../../src/chat/composer/session-composer-paths.js";

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
