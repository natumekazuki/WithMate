import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdditionalDirectoryItems,
  buildPathReferenceInsertionState,
  buildPathReferenceReplacementState,
  buildWorkspacePathMatchItems,
  getInitialWorkspacePathMatchIndex,
  getNextWorkspacePathMatchIndex,
  getPreviousWorkspacePathMatchIndex,
  pickComposerReferencePath,
  removePathReferenceTokensFromDraft,
  resolveActiveWorkspacePathMatch,
  resolveReferencePathsForInsertion,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
} from "../../src/session-composer-paths.js";

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

test("buildWorkspacePathMatchItems は path match display と active state を作る", () => {
  assert.deepEqual(
    buildWorkspacePathMatchItems(
      [
        { kind: "file", path: "C:\\workspace\\src\\App.tsx" },
        { kind: "folder", path: "C:/workspace/docs" },
      ],
      1,
    ),
    [
      {
        key: "file:C:\\workspace\\src\\App.tsx",
        path: "C:\\workspace\\src\\App.tsx",
        kind: "file",
        kindLabel: "File",
        primaryLabel: "App.tsx",
        secondaryLabel: "C:/workspace/src",
        title: "C:/workspace/src/App.tsx",
        isActive: false,
      },
      {
        key: "folder:C:/workspace/docs",
        path: "C:/workspace/docs",
        kind: "folder",
        kindLabel: "Dir",
        primaryLabel: "docs",
        secondaryLabel: "C:/workspace",
        title: "C:/workspace/docs",
        isActive: true,
      },
    ],
  );
});

test("workspace path match index helpers は初期値と上下移動を clamp する", () => {
  assert.equal(getInitialWorkspacePathMatchIndex(0), -1);
  assert.equal(getInitialWorkspacePathMatchIndex(2), 0);
  assert.equal(getNextWorkspacePathMatchIndex(-1, 3), 0);
  assert.equal(getNextWorkspacePathMatchIndex(1, 3), 2);
  assert.equal(getNextWorkspacePathMatchIndex(2, 3), 2);
  assert.equal(getPreviousWorkspacePathMatchIndex(0), 0);
  assert.equal(getPreviousWorkspacePathMatchIndex(2), 1);
});

test("resolveActiveWorkspacePathMatch は active index の候補または先頭候補を返す", () => {
  const pathMatches = [
    { kind: "file" as const, path: "src/App.tsx" },
    { kind: "folder" as const, path: "src" },
  ];

  assert.deepEqual(resolveActiveWorkspacePathMatch(pathMatches, 1), pathMatches[1]);
  assert.deepEqual(resolveActiveWorkspacePathMatch(pathMatches, -1), pathMatches[0]);
  assert.deepEqual(resolveActiveWorkspacePathMatch(pathMatches, 9), pathMatches[0]);
  assert.equal(resolveActiveWorkspacePathMatch([], 0), null);
});

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
        secondaryLabel: "ルート",
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

test("buildPathReferenceReplacementState は active path reference を置換する", () => {
  assert.deepEqual(
    buildPathReferenceReplacementState(
      "確認 @sr して",
      { query: "sr", start: "確認 ".length, end: "確認 @sr".length },
      "src/App.tsx",
    ),
    {
      draft: "確認 @src/App.tsx して",
      caret: "確認 @src/App.tsx".length,
    },
  );
});

test("buildPathReferenceReplacementState は空白を含む path を quote する", () => {
  assert.deepEqual(
    buildPathReferenceReplacementState(
      "確認 @docs して",
      { query: "docs", start: "確認 ".length, end: "確認 @docs".length },
      "docs/my note.md",
    ),
    {
      draft: "確認 @\"docs/my note.md\" して",
      caret: "確認 @\"docs/my note.md\"".length,
    },
  );
});

test("removePathReferenceTokensFromDraft は path reference token を draft から削除する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft("確認 @src/App.tsx して", ["src/App.tsx"]),
    "確認 して",
  );
});

test("removePathReferenceTokensFromDraft は quote された path reference token を削除する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft("確認 @\"docs/my note.md\" して", ["docs/my note.md"]),
    "確認 して",
  );
});

test("removePathReferenceTokensFromDraft は複数空白と連続改行を整理する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft("確認  @src/App.tsx\n\n\nして", ["src/App.tsx"]),
    "確認 \n\nして",
  );
});

test("removePathReferenceTokensFromDraft は複数 token と句読点境界を削除する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft(
      "確認 (@src/App.tsx), @" + "\"docs/my note.md\"" + "!",
      ["src/App.tsx", "docs/my note.md"],
    ),
    "確認 (), !",
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
