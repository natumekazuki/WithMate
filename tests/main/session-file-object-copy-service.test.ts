import assert from "node:assert/strict";
import test from "node:test";

import { SessionFileObjectCopyService } from "../../src-electron/files/session-file-object-copy-service.js";
import type { SessionFileResourceRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { NativeFileDropWriteResult } from "../../src-electron/files/windows-file-drop-clipboard-writer.js";

const RESOURCE: SessionFileResourceRequest = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/report.txt",
};

/** 認可の失敗、リンク種別、クリップボード結果を差し替え、要求と書き込みパスを観測できるようにする。 */
function createService(options: {
  writeResult?: NativeFileDropWriteResult;
  targetStillCurrent?: boolean;
  operationError?: Error;
  resolution?: "file" | "directory" | "external-url" | "not-found";
  platform?: NodeJS.Platform;
}) {
  const writes: string[] = [];
  const authorizationRequests: SessionFileResourceRequest[] = [];
  const service = new SessionFileObjectCopyService({
    platform: options.platform ?? "win32",
    /** テストごとのリンク解決と認可結果を返す境界の代役を作る。 */
    createAuthorizationBoundary: () => ({
      /** ファイル以外も表現できるプレビュー解決結果を作る。 */
      async resolvePreviewTarget(sessionId, target) {
        if ((options.resolution ?? "file") === "file") {
          return { type: "file", resource: { ...RESOURCE, sessionId } };
        }
        if (options.resolution === "directory") {
          return { type: "directory", targetPath: target };
        }
        if (options.resolution === "external-url") {
          return { type: "external-url", target };
        }
        return { type: "not-found", targetPath: target, message: "missing" };
      },
      /** 全認可要求を記録し、成功時だけ認可済み実パスで処理を呼ぶ。 */
      async withAuthorizedFilePath(request, operation) {
        authorizationRequests.push(request);
        if (options.operationError) {
          throw options.operationError;
        }
        return {
          result: await operation("C:\\workspace\\docs\\report.txt"),
          targetStillCurrent: options.targetStillCurrent ?? true,
        };
      },
    }),
    /** クリップボードは触らず、渡されたパスと設定済みの結果を返す。 */
    async writeNativeFileDrop(targetPath) {
      writes.push(targetPath);
      return options.writeResult ?? { status: "copied" };
    },
  });
  return { service, writes, authorizationRequests };
}

/** 要求の相対パスでなく、認可境界が返した通常ファイルの実パスで書き込む。 */
test("file object copy serviceは認可済みregular fileのreal pathだけをwriterへ渡す", async () => {
  const harness = createService({});
  assert.deepEqual(await harness.service.copyResource(RESOURCE), {
    status: "copied",
    message: "File copied.",
  });
  assert.deepEqual(harness.authorizationRequests, [RESOURCE]);
  assert.deepEqual(harness.writes, ["C:\\workspace\\docs\\report.txt"]);
});

/** 欠損や通常ファイルでない場合と認可失敗を区別し、いずれも書き込みに進まない。 */
test("file object copy serviceは認可・存在・regular file失敗でwriterを開始しない", async () => {
  for (const error of [
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    new Error("指定 path は file ではないよ。"),
    new Error("指定された file root は現在の Session で利用できないよ。"),
  ]) {
    const harness = createService({ operationError: error });
    const result = await harness.service.copyResource(RESOURCE);
    assert.equal(
      result.status,
      error.message.includes("root") ? "failed" : "not-copyable",
    );
    assert.deepEqual(harness.writes, []);
  }
});

/** 書き込み後に対象が変わった場合も、確定した成功ではなく結果不明とする。 */
test("file object copy serviceはnative write未開始と開始後未確認を区別する", async () => {
  const failed = createService({
    writeResult: { status: "failed-before-write" },
  });
  assert.equal((await failed.service.copyResource(RESOURCE)).status, "failed");

  const unknown = createService({ writeResult: { status: "effect-unknown" } });
  assert.equal(
    (await unknown.service.copyResource(RESOURCE)).status,
    "effect-unknown",
  );

  const replaced = createService({
    writeResult: { status: "copied" },
    targetStillCurrent: false,
  });
  assert.equal(
    (await replaced.service.copyResource(RESOURCE)).status,
    "effect-unknown",
  );
});

/** リンク解決でファイルと判定されたときにだけ、コピー候補を返す。 */
test("Markdown linkはmainの既存解決境界でfile resourceへ収束した場合だけcopyableになる", async () => {
  const file = createService({ resolution: "file" });
  assert.deepEqual(
    await file.service.resolveCopyableLinkResource({
      sessionId: "session-1",
      target: "docs/report.txt",
    }),
    RESOURCE,
  );

  for (const resolution of [
    "directory",
    "external-url",
    "not-found",
  ] as const) {
    const outside = createService({ resolution });
    assert.equal(
      await outside.service.resolveCopyableLinkResource({
        sessionId: "session-1",
        target: "target",
      }),
      null,
    );
    assert.deepEqual(outside.writes, []);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Markdown linkの実在fileはSession root外でも対象確認後にCopy Fileできる"
// oracle = { type = "contract", ref = "docs/features/windows-file-object-copy.md" }
// fault = "通常fileをroot外という理由でcopy候補から除外する、またはcopy時の対象確認を飛ばす"
// observable = "解決されたabsolute resource、確認要求とnative writerの対象path"
// observation_boundary = "public-boundary"
// scope = "Markdown link resolution and explicit file copy service"
// lifecycle = "permanent"
// impact = "表示されたローカルfileをユーザーがコピーできなくなる"
// distinction = "既存root内copyとabsolute Previewの直copyではリンク候補判定との接続を確認できない"
// @end-test-value
/** ルート外の実在ファイルも候補にできるが、候補解決と実コピーの両方で認可を通す。 */
test("Markdown linkはroot外absolute-fileも対象確認後にcopyできる", async () => {
  const writes: string[] = [];
  const authorizationRequests: SessionFileResourceRequest[] = [];
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    /** ルート外の絶対パスを扱う解決と認可の境界を模擬する。 */
    createAuthorizationBoundary: () => ({
      /** 外部 URL でなく、会話にひもづく絶対パスのファイルとして解決する。 */
      async resolvePreviewTarget(sessionId) {
        return {
          type: "file",
          resource: { sessionId, absolutePath: "C:\\outside\\report.txt" },
        };
      },
      /** 候補判定と実コピーの双方が同じ対象を認可するか調べるため、要求を記録する。 */
      async withAuthorizedFilePath(request, operation) {
        authorizationRequests.push(request);
        return {
          result: await operation("C:\\outside\\report.txt"),
          targetStillCurrent: true,
        };
      },
    }),
    /** 認可済みの絶対パスへの書き込みだけを記録する。 */
    async writeNativeFileDrop(targetPath) {
      writes.push(targetPath);
      return { status: "copied" };
    },
  });

  const resource = await service.resolveCopyableLinkResource({
    sessionId: "session-1",
    target: "C:\\outside\\report.txt",
  });
  assert.deepEqual(resource, {
    sessionId: "session-1",
    absolutePath: "C:\\outside\\report.txt",
  });
  assert.deepEqual(authorizationRequests, [resource]);
  assert.equal((await service.copyResource(resource!)).status, "copied");
  assert.deepEqual(authorizationRequests, [resource, resource]);
  assert.deepEqual(writes, ["C:\\outside\\report.txt"]);
});

/** リンクの再解決が不要なプレビューからも、明示操作なら認可された絶対パスをコピーできる。 */
test("現在のabsolute-file preview resourceは明示Copy File操作でcopyできる", async () => {
  const absoluteResource: SessionFileResourceRequest = {
    sessionId: "session-1",
    absolutePath: "C:\\outside\\report.txt",
  };
  const writes: string[] = [];
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    /** 既に解決済みの絶対パスだけを受ける認可境界を作る。 */
    createAuthorizationBoundary: () => ({
      /** このケースでは新たなリンク確認によってファイルを供給しない。 */
      async resolvePreviewTarget() {
        return { type: "not-found", targetPath: "", message: "unused" };
      },
      /** プレビューのリソース指定が失われていないことを確認して、コピー処理を実行する。 */
      async withAuthorizedFilePath(request, operation) {
        assert.deepEqual(request, absoluteResource);
        return {
          result: await operation(absoluteResource.absolutePath),
          targetStillCurrent: true,
        };
      },
    }),
    /** プレビューと同じ絶対パスが書き込み先に渡ったかを記録する。 */
    async writeNativeFileDrop(targetPath) {
      writes.push(targetPath);
      return { status: "copied" };
    },
  });

  assert.equal((await service.copyResource(absoluteResource)).status, "copied");
  assert.deepEqual(writes, [absoluteResource.absolutePath]);
});

// @test-value v2
// kind = "invariant"
// claim = "file object copy serviceはcopy operationを直列化してnative writerの対象順序を保つ"
// oracle = { type = "contract", ref = "src-electron/files/session-file-object-copy-service.ts: copy queue" }
// fault = "並行copyがwriterの対象順序を競合させ、先行操作の完了前に後続操作を開始する"
// observable = "operation orderとnative writerへ渡した対象path"
// observation_boundary = "public-boundary"
// scope = "session-file-object-copy-serialization"
// lifecycle = "permanent"
// distinction = "単一copy成功では検出できないqueue競合を確認する"
// @end-test-value
/** 先行コピーが終わるまで、二件目の書き込みを始めない。 */
test("file object copy serviceはcopy operationを直列化してread-back競合を避ける", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    /** 書き込み順だけを分離して観測できるよう、認可は常に通す。 */
    createAuthorizationBoundary: () => ({
      /** プレビュー解決に備え、正規のファイル候補を固定する。 */
      async resolvePreviewTarget() {
        return { type: "file", resource: RESOURCE };
      },
      /** キュー順を識別できるよう、各要求で異なるファイルパスを操作に渡す。 */
      async withAuthorizedFilePath(request, operation) {
        const targetPath =
          "relativePath" in request
            ? request.relativePath
            : request.absolutePath;
        return {
          result: await operation(targetPath),
          targetStillCurrent: true,
        };
      },
    }),
    /** 初回の終了をテスト側で遅らせ、前後の書き込み順を記録する。 */
    async writeNativeFileDrop(targetPath) {
      call += 1;
      order.push(`start:${targetPath}`);
      if (call === 1) {
        await firstBlocked;
      }
      order.push(`end:${targetPath}`);
      return { status: "copied" };
    },
  });
  const first = service.copyResource(RESOURCE);
  const second = service.copyResource({
    ...RESOURCE,
    relativePath: "second.txt",
  });
  await Promise.resolve();
  assert.deepEqual(order, ["start:docs/report.txt"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "start:docs/report.txt",
    "end:docs/report.txt",
    "start:second.txt",
    "end:second.txt",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Files context menuはpopup close後もcopy resultを優先して通知する"
// oracle = { type = "contract", ref = "src-electron/files/session-file-object-copy-service.ts: context menu copy" }
// fault = "popup closeを成功扱いしてcopy失敗または結果を利用者へ伝えない"
// observable = "popup callback、copy result、close state"
// observation_boundary = "public-boundary"
// scope = "session-file-context-menu-copy"
// lifecycle = "permanent"
// distinction = "copy service直呼出では検出できないpopup lifecycle競合を確認する"
// @end-test-value
/** コピーの選択直後にメニューが閉じても、閉じただけの結果でコピー結果を上書きしない。 */
test("Files context menuは選択後のpopup closeよりcopy resultを優先する", async () => {
  let menuTemplate: Array<{ click?: () => void }> = [];
  let popupCallback: (() => void) | undefined;
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    /** メニューのタイミングを確かめるため、コピー対象は一件に固定する。 */
    createAuthorizationBoundary: () => ({
      /** メニューで使う対象をファイルとして扱う。 */
      async resolvePreviewTarget() {
        return { type: "file", resource: RESOURCE };
      },
      /** 調べたい競合をメニュー終了に限定するため、認可は同じパスで成功させる。 */
      async withAuthorizedFilePath(_request, operation) {
        return {
          result: await operation("C:\\workspace\\docs\\report.txt"),
          targetStillCurrent: true,
        };
      },
    }),
    /** 実クリップボードには書かず、コピー完了を返す。 */
    async writeNativeFileDrop() {
      return { status: "copied" };
    },
    /** 実メニューは開かず、項目の選択をテストから発火できるようにする。 */
    buildMenu(template) {
      menuTemplate = template as Array<{ click?: () => void }>;
      return {
        /** 閉じる通知を捕捉し、項目クリックに続けてテスト側から発火する。 */
        popup(options) {
          popupCallback = options?.callback;
        },
      };
    },
  });
  const result = service.showContextMenu({} as never, {
    resource: RESOURCE,
    point: { x: 10, y: 20 },
  });
  menuTemplate[0]?.click?.();
  popupCallback?.();
  assert.deepEqual(await result, { status: "copied", message: "File copied." });
});
