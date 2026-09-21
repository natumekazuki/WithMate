import assert from "node:assert/strict";
import test from "node:test";

import { SessionFileObjectCopyService } from "../../src-electron/session-file-object-copy-service.js";
import type { SessionFileResourceRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { NativeFileDropWriteResult } from "../../src-electron/windows-file-drop-clipboard-writer.js";

const RESOURCE: SessionFileResourceRequest = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/report.txt",
};

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
    createAuthorizationBoundary: () => ({
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
    async writeNativeFileDrop(targetPath) {
      writes.push(targetPath);
      return options.writeResult ?? { status: "copied" };
    },
  });
  return { service, writes, authorizationRequests };
}

test("file object copy serviceは認可済みregular fileのreal pathだけをwriterへ渡す", async () => {
  const harness = createService({});
  assert.deepEqual(await harness.service.copyResource(RESOURCE), {
    status: "copied",
    message: "File copied.",
  });
  assert.deepEqual(harness.authorizationRequests, [RESOURCE]);
  assert.deepEqual(harness.writes, ["C:\\workspace\\docs\\report.txt"]);
});

test("file object copy serviceは認可・存在・regular file失敗でwriterを開始しない", async () => {
  for (const error of [
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    new Error("指定 path は file ではないよ。"),
    new Error("指定された file root は現在の Session で利用できないよ。"),
  ]) {
    const harness = createService({ operationError: error });
    const result = await harness.service.copyResource(RESOURCE);
    assert.equal(result.status, error.message.includes("root") ? "failed" : "not-copyable");
    assert.deepEqual(harness.writes, []);
  }
});

test("file object copy serviceはnative write未開始と開始後未確認を区別する", async () => {
  const failed = createService({ writeResult: { status: "failed-before-write" } });
  assert.equal((await failed.service.copyResource(RESOURCE)).status, "failed");

  const unknown = createService({ writeResult: { status: "effect-unknown" } });
  assert.equal((await unknown.service.copyResource(RESOURCE)).status, "effect-unknown");

  const replaced = createService({ writeResult: { status: "copied" }, targetStillCurrent: false });
  assert.equal((await replaced.service.copyResource(RESOURCE)).status, "effect-unknown");
});

test("Markdown linkはmainの既存解決境界でfile resourceへ収束した場合だけcopyableになる", async () => {
  const file = createService({ resolution: "file" });
  assert.deepEqual(await file.service.resolveCopyableLinkResource({
    sessionId: "session-1",
    target: "docs/report.txt",
  }), RESOURCE);

  for (const resolution of ["directory", "external-url", "not-found"] as const) {
    const outside = createService({ resolution });
    assert.equal(await outside.service.resolveCopyableLinkResource({
      sessionId: "session-1",
      target: "target",
    }), null);
    assert.deepEqual(outside.writes, []);
  }
});

test("Markdown linkはroot外absolute-file preview resourceをcopy対象にしない", async () => {
  const writes: string[] = [];
  const authorizationRequests: SessionFileResourceRequest[] = [];
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    createAuthorizationBoundary: () => ({
      async resolvePreviewTarget(sessionId) {
        return { type: "file", resource: { sessionId, absolutePath: "C:\\outside\\report.txt" } };
      },
      async withAuthorizedFilePath(request, operation) {
        authorizationRequests.push(request);
        return { result: await operation("C:\\outside\\report.txt"), targetStillCurrent: true };
      },
    }),
    async writeNativeFileDrop(targetPath) {
      writes.push(targetPath);
      return { status: "copied" };
    },
  });

  assert.equal(await service.resolveCopyableLinkResource({
    sessionId: "session-1",
    target: "C:\\outside\\report.txt",
  }), null);
  assert.deepEqual(authorizationRequests, []);
  assert.deepEqual(writes, []);
});

test("現在のabsolute-file preview resourceは明示Copy File操作でcopyできる", async () => {
  const absoluteResource: SessionFileResourceRequest = {
    sessionId: "session-1",
    absolutePath: "C:\\outside\\report.txt",
  };
  const writes: string[] = [];
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    createAuthorizationBoundary: () => ({
      async resolvePreviewTarget() {
        return { type: "not-found", targetPath: "", message: "unused" };
      },
      async withAuthorizedFilePath(request, operation) {
        assert.deepEqual(request, absoluteResource);
        return { result: await operation(absoluteResource.absolutePath), targetStillCurrent: true };
      },
    }),
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
// claim = "file object copy serviceはcopy operationを直列化してread-back競合を避ける"
// oracle = { type = "contract", ref = "src-electron/session-file-object-copy-service.ts: copy queue" }
// fault = "並行copyがread-back順序を競合させ、後発結果で対象contentを壊す"
// observable = "operation orderと最終copied content"
// observation_boundary = "public-boundary"
// scope = "session-file-object-copy-serialization"
// lifecycle = "permanent"
// distinction = "単一copy成功では検出できないqueue競合を確認する"
// @end-test-value
test("file object copy serviceはcopy operationを直列化してread-back競合を避ける", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    createAuthorizationBoundary: () => ({
      async resolvePreviewTarget() {
        return { type: "file", resource: RESOURCE };
      },
      async withAuthorizedFilePath(request, operation) {
        const targetPath = "relativePath" in request ? request.relativePath : request.absolutePath;
        return { result: await operation(targetPath), targetStillCurrent: true };
      },
    }),
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
  const second = service.copyResource({ ...RESOURCE, relativePath: "second.txt" });
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
// oracle = { type = "contract", ref = "src-electron/session-file-object-copy-service.ts: context menu copy" }
// fault = "popup closeを成功扱いしてcopy失敗または結果を利用者へ伝えない"
// observable = "popup callback、copy result、close state"
// observation_boundary = "public-boundary"
// scope = "session-file-context-menu-copy"
// lifecycle = "permanent"
// distinction = "copy service直呼出では検出できないpopup lifecycle競合を確認する"
// @end-test-value
test("Files context menuは選択後のpopup closeよりcopy resultを優先する", async () => {
  let menuTemplate: Array<{ click?: () => void }> = [];
  let popupCallback: (() => void) | undefined;
  const service = new SessionFileObjectCopyService({
    platform: "win32",
    createAuthorizationBoundary: () => ({
      async resolvePreviewTarget() {
        return { type: "file", resource: RESOURCE };
      },
      async withAuthorizedFilePath(_request, operation) {
        return { result: await operation("C:\\workspace\\docs\\report.txt"), targetStillCurrent: true };
      },
    }),
    async writeNativeFileDrop() {
      return { status: "copied" };
    },
    buildMenu(template) {
      menuTemplate = template as Array<{ click?: () => void }>;
      return {
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
