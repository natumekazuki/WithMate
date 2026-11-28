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
// claim = "Additional Directoryの選択は親Session IDと入力pathを検証APIへ渡して返し、path未指定時だけ従来pickerの選択・取消を返す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory / Add Directory By Path" }
// fault = "入力pathでpickerを開く、検証を省く、親Session IDや空白を含むpathを破損する、pickerのbaseまたは取消を失う"
// observable = "選択結果、検証APIへ渡す親Session IDとpath、pickerのbaseと呼出回数"
// observation_boundary = "consumer"
// scope = "Main／Auxiliaryが共用するAdditional Directoryの選択"
// lifecycle = "permanent"
// impact = "pickerを使えない利用者のpath入力と既存pickerの双方を維持する"
// distinction = "filesystem検証testと異なり、入力方式によるAPI選択とpath転送を軽量な純粋adapter testで検出する"
// @end-test-value
/** 明示パスを親 Session の検証へ渡し、指定されていないときだけピッカーで選択または取消を扱う。 */
test("Additional Directoryは入力pathを検証し、未指定時はpickerを使う", async () => {
  const validated: Array<[string, string]> = [];
  const picked: Array<string | null> = [];
  let pickerResult: string | null = "C:/selected";
  const api = {
    /** 検証に渡った親の ID と、前後の空白を除いたパスを取得する。 */
    async validateSessionAdditionalDirectory(
      sessionId: string,
      targetPath: string,
    ): Promise<WorkspaceDirectoryValidationResult> {
      validated.push([sessionId, targetPath]);
      return { valid: true };
    },
    /** ピッカーの初期位置を記録し、選択結果と取消を切り替えて返す。 */
    async pickDirectory(base: string | null) {
      picked.push(base);
      return pickerResult;
    },
  };
  assert.equal(
    await selectAdditionalDirectoryPath({
      sessionId: "parent-1",
      directoryPath: "  C:\\作業\\shared folder  ",
      initialPath: "C:/base",
      api,
    }),
    "C:\\作業\\shared folder",
  );
  assert.deepEqual(validated, [["parent-1", "C:\\作業\\shared folder"]]);
  assert.deepEqual(picked, []);
  assert.equal(
    await selectAdditionalDirectoryPath({
      sessionId: "parent-1",
      initialPath: "C:/base",
      api,
    }),
    "C:/selected",
  );
  pickerResult = null;
  assert.equal(
    await selectAdditionalDirectoryPath({
      sessionId: "parent-1",
      initialPath: null,
      api,
    }),
    null,
  );
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
/** 無効パスの理由と検証失敗をそのまま伝え、失敗してもピッカーへ切り替えない。 */
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
    await assert.rejects(
      selectAdditionalDirectoryPath({
        sessionId: "parent-1",
        directoryPath: reason === "empty" ? " " : "invalid",
        initialPath: null,
        api: {
          /** 各ケースで想定した無効理由を検証の結果として返す。 */
          validateSessionAdditionalDirectory: async () => ({
            valid: false,
            reason,
          }),
          /** 無効な明示パスからピッカーを開かないことを呼び出し回数で確認する。 */
          pickDirectory: async () => {
            picked += 1;
            return "C:/unwanted";
          },
        },
      }),
      { message },
    );
  }
  await assert.rejects(
    selectAdditionalDirectoryPath({
      sessionId: "parent-1",
      directoryPath: "C:/valid",
      initialPath: null,
      api: {
        /** 妥当性確認サービスそのものが使えない状態を再現する。 */
        validateSessionAdditionalDirectory: async () => {
          throw new Error("Validation unavailable");
        },
        /** 検証が例外でもピッカーにフォールバックしないことを観測する。 */
        pickDirectory: async () => {
          picked += 1;
          return "C:/unwanted";
        },
      },
    }),
    { message: "Validation unavailable" },
  );
  assert.equal(picked, 0);
});

/** 既存文の途中へパス参照を挿入し、後続文を保って参照の後ろにカーソルを置く。 */
test("buildPathReferenceInsertionState は caret 位置に path reference を挿入する", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("before after", "before ".length, [
      "src/App.tsx",
    ]),
    {
      draft: "before @src/App.tsx after",
      caret: "before @src/App.tsx ".length,
    },
  );
});

/** 空白のない語の境目へ挿入するとき、参照の前後にだけ区切りを追加する。 */
test("buildPathReferenceInsertionState は隣接文字との間に spacer を入れる", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("beforeafter", "before".length, [
      "src/App.tsx",
    ]),
    {
      draft: "before @src/App.tsx after",
      caret: "before @src/App.tsx ".length,
    },
  );
});

/** 空白を含むパスを引用符で保護し、他の参照と区別する。 */
test("buildPathReferenceInsertionState は空白を含む path reference を quote する", () => {
  assert.deepEqual(
    buildPathReferenceInsertionState("", 0, ["docs/my note.md", "src/App.tsx"]),
    {
      draft: '@"docs/my note.md" @src/App.tsx',
      caret: '@"docs/my note.md" @src/App.tsx'.length,
    },
  );
});

/** 参照するパスが空なら、下書きの更新自体を返さない。 */
test("buildPathReferenceInsertionState は reference path が空なら null を返す", () => {
  assert.equal(buildPathReferenceInsertionState("draft", 0, []), null);
});

/** 通常パスの参照と画像 Markdown を同じ挿入位置へ組み立てる。 */
test("buildComposerReferenceInsertionState は画像Markdownと通常pathを同じcaretへ挿入する", () => {
  assert.deepEqual(
    buildComposerReferenceInsertionState("確認後", "確認".length, [
      { path: "C:/session-files/cover image.png", presentation: "image" },
      { path: "C:/session-files/note.txt", presentation: "path" },
    ]),
    {
      draft:
        "確認 ![cover image.png](C:/session-files/cover%20image.png) @C:/session-files/note.txt 後",
      caret:
        "確認 ![cover image.png](C:/session-files/cover%20image.png) @C:/session-files/note.txt "
          .length,
    },
  );
});

/** 選択したファイルのパスを Workspace に応じて解決し、下書きとカーソルの次状態を返す。 */
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
      draft: '確認 @src/App.tsx @"D:/assets/cover image.png"',
      caret: '確認 @src/App.tsx @"D:/assets/cover image.png"'.length,
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
/** 追加ディレクトリを表示項目に変換し、利用可能な項目に削除操作を対応付ける。 */
test("buildAdditionalDirectoryItems は additional directory display と remove state を作る", () => {
  assert.deepEqual(
    buildAdditionalDirectoryItems(["C:\\workspace\\external\\", "C:/"], true),
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
    buildAdditionalDirectoryItems(["C:/workspace/readonly"], false)[0]
      ?.canRemove,
    false,
  );
});

/** Workspace 内に限って相対パスへ変換し、外部パスは正規化した絶対パスにする。 */
test("resolveReferencePathsForInsertion は workspace 内 path を相対化し workspace 外 path を正規化する", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(
      ["C:\\workspace\\project\\src\\App.tsx", "D:\\external\\note.md"],
      "C:/workspace/project",
    ),
    ["src/App.tsx", "D:/external/note.md"],
  );
});

/** 基準の Workspace がない場合は絶対パスの区切りだけを正規化する。 */
test("resolveReferencePathsForInsertion は workspace がない場合 selected path を正規化する", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(
      ["C:\\workspace\\project\\src\\App.tsx"],
      null,
    ),
    ["C:/workspace/project/src/App.tsx"],
  );
});

/** 空文字の基準値は null と同一視せず、従来の Workspace 相対形式を使う。 */
test("resolveReferencePathsForInsertion は空 workspace path を旧 workspace-relative 判定として扱う", () => {
  assert.deepEqual(
    resolveReferencePathsForInsertion(["/workspace/project/src/App.tsx"], ""),
    ["workspace/project/src/App.tsx"],
  );
});

/** 次のファイル選択を同じ場所で始められるよう、前回選択したファイルの親を取得する。 */
test("resolvePickedPathBaseDirectory は file picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory(
      "file",
      "C:\\workspace\\project\\src\\App.tsx",
    ),
    "C:\\workspace\\project\\src",
  );
});

/** 画像選択後の初期位置には画像ファイルの親を使う。 */
test("resolvePickedPathBaseDirectory は image picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory(
      "image",
      "/workspace/project/assets/icon.png",
    ),
    "/workspace/project/assets",
  );
});

/** フォルダー選択後はそのフォルダー自体を次の初期位置にする。 */
test("resolvePickedPathBaseDirectory は folder picker の選択 path をそのまま返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("folder", "/workspace/project/docs"),
    "/workspace/project/docs",
  );
});

/** パス参照の種別に応じて API を切り替え、選択結果と指定された初期位置を保持する。 */
test("pickComposerReferencePath は kind に対応する picker API を呼び分ける", async () => {
  const calls: Array<{ method: string; initialPath: string | null }> = [];
  const picker = {
    /** フォルダーピッカーに渡った初期位置を記録し、専用の選択結果を返す。 */
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickDirectory", initialPath: initialPath ?? null });
      return "folder-result";
    },
    /** 通常ファイルの API が選ばれたことを呼び出しと戻り値で区別する。 */
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickFile", initialPath: initialPath ?? null });
      return "file-result";
    },
    /** 画像専用の API と初期位置が使われたことを確認可能にする。 */
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickImageFile", initialPath: initialPath ?? null });
      return "image-result";
    },
  };

  const inputs: Array<{
    kind: ComposerPathPickerKind;
    expectedPath: string;
    method: string;
  }> = [
    { kind: "file", expectedPath: "file-result", method: "pickFile" },
    { kind: "folder", expectedPath: "folder-result", method: "pickDirectory" },
    { kind: "image", expectedPath: "image-result", method: "pickImageFile" },
  ];

  for (const input of inputs) {
    assert.equal(
      await pickComposerReferencePath(input.kind, "C:\\workspace", picker),
      input.expectedPath,
    );
    assert.deepEqual(calls.at(-1), {
      method: input.method,
      initialPath: "C:\\workspace",
    });
  }
});

/** 初期位置が null のファイル選択では値を引き継ぎ、取消結果もそのまま返す。 */
test("pickComposerReferencePath は null initialPath を picker API にそのまま渡す", async () => {
  const calls: Array<string | null> = [];
  const picker = {
    /** このケースでフォルダー選択へ誤って切り替わった場合に呼び出しを記録する。 */
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    /** ファイル選択の初期位置を記録し、利用者による取消を返す。 */
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    /** 画像選択が誤って呼ばれた場合も記録できる形にする。 */
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
  };

  assert.equal(await pickComposerReferencePath("file", null, picker), null);
  assert.deepEqual(calls, [null]);
});
