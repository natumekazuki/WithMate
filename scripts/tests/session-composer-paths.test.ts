import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMissingPathReferenceAttachments,
  buildAdditionalDirectoryItems,
  buildClosedWorkspacePathMatchState,
  buildComposerAttachmentItems,
  buildComposerPathReferencePreviewState,
  buildPathReferenceAttachmentItems,
  buildPathReferenceInsertionState,
  buildPathReferenceInsertionWithClosedWorkspaceMatchesState,
  buildPathReferenceRemovalState,
  buildPathReferenceRemovalWithClosedWorkspaceMatchesState,
  buildSelectedPathReferenceInsertionState,
  buildPathReferenceReplacementState,
  buildWorkspacePathMatchSelectionState,
  buildWorkspacePathMatchState,
  buildWorkspacePathMatchItems,
  canSearchWorkspacePathMatches,
  canNavigateWorkspacePathMatches,
  getInitialWorkspacePathMatchIndex,
  getNextWorkspacePathMatchIndex,
  getPreviousWorkspacePathMatchIndex,
  getWorkspacePathMatchNavigationIndex,
  pickComposerReferencePath,
  removePathReferenceAttachments,
  removePathReferenceTokensFromDraft,
  resolveActiveWorkspacePathMatch,
  resolveReferencePathsForInsertion,
  resolvePickedPathBaseDirectory,
  resolvePathReferenceRemovalTargets,
  resolveWorkspacePathMatchKeyAction,
  resolveWorkspacePathMatchNavigation,
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

test("buildClosedWorkspacePathMatchState は候補と active index を閉じる", () => {
  assert.deepEqual(buildClosedWorkspacePathMatchState(), {
    workspacePathMatches: [],
    activeWorkspacePathMatchIndex: -1,
  });
});

test("buildComposerPathReferencePreviewState は active path reference の preview を返す", () => {
  assert.deepEqual(
    buildComposerPathReferencePreviewState({
      draft: "確認 @src/ して",
      caret: "確認 @src/".length,
      isEnabled: true,
    }),
    {
      activePathReference: {
        query: "src/",
        start: "確認 ".length,
        end: "確認 @src/".length,
      },
      isEditingPathReference: true,
      normalizedActivePathQuery: "src/",
      previewDraft: "確認  して",
      previewUserMessage: "確認  して",
    },
  );
});

test("buildComposerPathReferencePreviewState は無効時に draft をそのまま preview に使う", () => {
  assert.deepEqual(
    buildComposerPathReferencePreviewState({
      draft: "確認 @src/",
      caret: "確認 @src/".length,
      isEnabled: false,
    }),
    {
      activePathReference: null,
      isEditingPathReference: false,
      normalizedActivePathQuery: "",
      previewDraft: "確認 @src/",
      previewUserMessage: "確認 @src/",
    },
  );
});

test("buildPathReferenceInsertionWithClosedWorkspaceMatchesState は挿入後に候補を閉じる", () => {
  assert.deepEqual(
    buildPathReferenceInsertionWithClosedWorkspaceMatchesState("確認 ", "確認 ".length, ["src/App.tsx"]),
    {
      draft: "確認 @src/App.tsx",
      caret: "確認 @src/App.tsx".length,
      workspacePathMatches: [],
      activeWorkspacePathMatchIndex: -1,
    },
  );
  assert.equal(
    buildPathReferenceInsertionWithClosedWorkspaceMatchesState("確認 ", "確認 ".length, []),
    null,
  );
});

test("buildSelectedPathReferenceInsertionState は選択 path を解決して候補を閉じる", () => {
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
      workspacePathMatches: [],
      activeWorkspacePathMatchIndex: -1,
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

test("buildComposerAttachmentItems は attachment display と remove targets を作る", () => {
  const attachments = [
    {
      id: "att-1",
      kind: "file" as const,
      absolutePath: "C:\\workspace\\project\\src\\App.tsx",
      displayPath: "src/App.tsx",
      workspaceRelativePath: "src/App.tsx",
      isOutsideWorkspace: false,
    },
    {
      id: "att-2",
      kind: "image" as const,
      absolutePath: "D:\\assets\\cover image.png",
      displayPath: "  ",
      isOutsideWorkspace: true,
    },
  ];

  assert.deepEqual(buildComposerAttachmentItems(attachments, { trimRemoveTargets: true }), [
    {
      key: "att-1",
      kind: "file",
      kindLabel: "ファイル",
      locationLabel: "ワークスペース内",
      primaryLabel: "App.tsx",
      secondaryLabel: "src",
      title: "src/App.tsx",
      removeTargets: ["src/App.tsx", "src/App.tsx", "C:/workspace/project/src/App.tsx"],
    },
    {
      key: "att-2",
      kind: "image",
      kindLabel: "画像",
      locationLabel: "ワークスペース外",
      primaryLabel: "cover image.png",
      secondaryLabel: "D:/assets",
      title: "D:/assets/cover image.png",
      removeTargets: ["D:/assets/cover image.png"],
    },
  ]);

  assert.deepEqual(
    buildComposerAttachmentItems([attachments[1]], { trimRemoveTargets: false })[0]?.removeTargets,
    ["  ", "D:/assets/cover image.png"],
  );
});

test("buildPathReferenceAttachmentItems は MateTalk path reference item を作る", () => {
  assert.deepEqual(
    buildPathReferenceAttachmentItems([
      { path: "src/App.tsx", kind: "file" },
      { path: "docs/specs", kind: "folder" },
      { path: "assets/cover image.png", kind: "image" },
    ]),
    [
      {
        key: "file:src/App.tsx",
        kind: "file",
        kindLabel: "ファイル",
        locationLabel: "参照",
        primaryLabel: "App.tsx",
        secondaryLabel: "src",
        title: "src/App.tsx",
        removeTargets: ["src/App.tsx"],
      },
      {
        key: "folder:docs/specs",
        kind: "folder",
        kindLabel: "フォルダ",
        locationLabel: "参照",
        primaryLabel: "specs",
        secondaryLabel: "docs",
        title: "docs/specs",
        removeTargets: ["docs/specs"],
      },
      {
        key: "image:assets/cover image.png",
        kind: "image",
        kindLabel: "画像",
        locationLabel: "参照",
        primaryLabel: "cover image.png",
        secondaryLabel: "assets",
        title: "assets/cover image.png",
        removeTargets: ["assets/cover image.png"],
      },
    ],
  );
});

test("appendMissingPathReferenceAttachments は既存にない path reference を追加する", () => {
  assert.deepEqual(
    appendMissingPathReferenceAttachments(
      [
        { path: "src/App.tsx", kind: "file" },
        { path: "docs", kind: "folder" },
      ],
      ["src/App.tsx", "assets/cover.png"],
      "image",
    ),
    [
      { path: "src/App.tsx", kind: "file" },
      { path: "docs", kind: "folder" },
      { path: "assets/cover.png", kind: "image" },
    ],
  );
});

test("resolvePathReferenceRemovalTargets は削除対象 path を正規化して重複を除く", () => {
  assert.deepEqual(
    resolvePathReferenceRemovalTargets(["src\\App.tsx", "src/App.tsx", "docs/spec.md"]),
    ["src/App.tsx", "docs/spec.md"],
  );
});

test("removePathReferenceAttachments は削除対象以外の path reference を残す", () => {
  assert.deepEqual(
    removePathReferenceAttachments(
      [
        { path: "src\\App.tsx", kind: "file" },
        { path: "docs", kind: "folder" },
        { path: "assets/cover.png", kind: "image" },
      ],
      ["src\\App.tsx", "assets/cover.png"],
    ),
    [{ path: "docs", kind: "folder" }],
  );
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

test("buildWorkspacePathMatchState は候補と初期 active index を返す", () => {
  const pathMatches = [
    { kind: "file" as const, path: "src/App.tsx" },
    { kind: "folder" as const, path: "src" },
  ];
  assert.deepEqual(buildWorkspacePathMatchState(pathMatches), {
    workspacePathMatches: pathMatches,
    activeWorkspacePathMatchIndex: 0,
  });
  assert.deepEqual(buildWorkspacePathMatchState([]), {
    workspacePathMatches: [],
    activeWorkspacePathMatchIndex: -1,
  });
});

test("canSearchWorkspacePathMatches は検索 block と composer 状態から検索可否を返す", () => {
  const baseInput = {
    isSearchBlocked: false,
    isComposerImeComposing: false,
    isEditingPathReference: true,
    normalizedActivePathQuery: "src",
    minQueryLength: 2,
  };

  assert.equal(canSearchWorkspacePathMatches(baseInput), true);
  assert.equal(canSearchWorkspacePathMatches({ ...baseInput, isSearchBlocked: true }), false);
  assert.equal(canSearchWorkspacePathMatches({ ...baseInput, isComposerImeComposing: true }), false);
  assert.equal(canSearchWorkspacePathMatches({ ...baseInput, isEditingPathReference: false }), false);
  assert.equal(canSearchWorkspacePathMatches({ ...baseInput, normalizedActivePathQuery: "s" }), false);
  assert.equal(canSearchWorkspacePathMatches({ ...baseInput, normalizedActivePathQuery: "sr" }), true);
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

test("canNavigateWorkspacePathMatches は候補数と IME 状態から navigation 可否を返す", () => {
  assert.equal(
    canNavigateWorkspacePathMatches({
      matchCount: 1,
      isComposerImeComposing: false,
      isNativeComposing: false,
    }),
    true,
  );
  assert.equal(
    canNavigateWorkspacePathMatches({
      matchCount: 0,
      isComposerImeComposing: false,
      isNativeComposing: false,
    }),
    false,
  );
  assert.equal(
    canNavigateWorkspacePathMatches({
      matchCount: 1,
      isComposerImeComposing: true,
      isNativeComposing: false,
    }),
    false,
  );
  assert.equal(
    canNavigateWorkspacePathMatches({
      matchCount: 1,
      isComposerImeComposing: false,
      isNativeComposing: true,
    }),
    false,
  );
});

test("resolveWorkspacePathMatchKeyAction は path match navigation key を action に変換する", () => {
  assert.deepEqual(
    resolveWorkspacePathMatchKeyAction({ key: "ArrowDown", ctrlKey: false, metaKey: false }),
    { kind: "next", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchKeyAction({ key: "ArrowUp", ctrlKey: false, metaKey: false }),
    { kind: "previous", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchKeyAction({ key: "Escape", ctrlKey: false, metaKey: false }),
    { kind: "dismiss", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchKeyAction({ key: "Tab", ctrlKey: false, metaKey: false }),
    { kind: "dismiss", shouldPreventDefault: false },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchKeyAction({ key: "Enter", ctrlKey: false, metaKey: false }),
    { kind: "select", shouldPreventDefault: true },
  );
  assert.equal(resolveWorkspacePathMatchKeyAction({ key: "Enter", ctrlKey: true, metaKey: false }), null);
  assert.equal(resolveWorkspacePathMatchKeyAction({ key: "Enter", ctrlKey: false, metaKey: true }), null);
  assert.equal(resolveWorkspacePathMatchKeyAction({ key: "a", ctrlKey: false, metaKey: false }), null);
});

test("resolveWorkspacePathMatchNavigation は key action と候補状態から navigation 結果を返す", () => {
  const pathMatches = [
    { kind: "file" as const, path: "src/App.tsx" },
    { kind: "folder" as const, path: "src" },
  ];
  const baseInput = {
    pathMatches,
    activeIndex: 0,
    ctrlKey: false,
    metaKey: false,
    isComposerImeComposing: false,
    isNativeComposing: false,
  };

  assert.deepEqual(
    resolveWorkspacePathMatchNavigation({ ...baseInput, key: "ArrowDown" }),
    { kind: "next", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchNavigation({ ...baseInput, activeIndex: 1, key: "ArrowUp" }),
    { kind: "previous", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchNavigation({ ...baseInput, key: "Tab" }),
    { kind: "dismiss", shouldPreventDefault: false },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchNavigation({ ...baseInput, key: "Escape" }),
    { kind: "dismiss", shouldPreventDefault: true },
  );
  assert.deepEqual(
    resolveWorkspacePathMatchNavigation({ ...baseInput, activeIndex: 9, key: "Enter" }),
    { kind: "select", match: pathMatches[0], shouldPreventDefault: true },
  );
  assert.equal(
    resolveWorkspacePathMatchNavigation({
      ...baseInput,
      key: "ArrowDown",
      isComposerImeComposing: true,
    }),
    null,
  );
  assert.equal(
    resolveWorkspacePathMatchNavigation({ ...baseInput, key: "Enter", ctrlKey: true }),
    null,
  );
  assert.equal(
    resolveWorkspacePathMatchNavigation({ ...baseInput, key: "ArrowDown", pathMatches: [] }),
    null,
  );
});

test("getWorkspacePathMatchNavigationIndex は最新 active index から次の index を返す", () => {
  assert.equal(
    getWorkspacePathMatchNavigationIndex(
      { kind: "next", shouldPreventDefault: true },
      1,
      3,
    ),
    2,
  );
  assert.equal(
    getWorkspacePathMatchNavigationIndex(
      { kind: "previous", shouldPreventDefault: true },
      2,
      3,
    ),
    1,
  );
  assert.equal(
    getWorkspacePathMatchNavigationIndex(
      { kind: "dismiss", shouldPreventDefault: false },
      2,
      3,
    ),
    2,
  );
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

test("buildWorkspacePathMatchSelectionState は active path reference を置換して候補を閉じる", () => {
  assert.deepEqual(
    buildWorkspacePathMatchSelectionState("確認 @src/ して", "確認 @src/".length, "src/App.tsx"),
    {
      draft: "確認 @src/App.tsx して",
      caret: "確認 @src/App.tsx".length,
      workspacePathMatches: [],
      activeWorkspacePathMatchIndex: -1,
    },
  );
});

test("buildWorkspacePathMatchSelectionState は active path reference がなければ null を返す", () => {
  assert.equal(
    buildWorkspacePathMatchSelectionState("確認 src/ して", "確認 src/".length, "src/App.tsx"),
    null,
  );
});

test("removePathReferenceTokensFromDraft は path reference token を draft から削除する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft("確認 @src/App.tsx して", ["src/App.tsx"]),
    "確認 して",
  );
});

test("removePathReferenceTokensFromDraft は同じ token の複数出現をすべて削除する", () => {
  assert.equal(
    removePathReferenceTokensFromDraft(
      "確認 @src/App.tsx と @src/App.tsx して",
      ["src/App.tsx"],
    ),
    "確認 と して",
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

test("buildPathReferenceRemovalState は path reference 削除後の draft と末尾 caret を返す", () => {
  assert.deepEqual(
    buildPathReferenceRemovalState("確認 @src/App.tsx して", ["src/App.tsx"]),
    {
      draft: "確認 して",
      caret: "確認 して".length,
    },
  );
});

test("buildPathReferenceRemovalWithClosedWorkspaceMatchesState は削除後に候補を閉じる", () => {
  assert.deepEqual(
    buildPathReferenceRemovalWithClosedWorkspaceMatchesState("確認 @src/App.tsx して", ["src/App.tsx"]),
    {
      draft: "確認 して",
      caret: "確認 して".length,
      workspacePathMatches: [],
      activeWorkspacePathMatchIndex: -1,
    },
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
