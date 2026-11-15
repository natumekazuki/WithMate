import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import koffi from "koffi";
import { renameDirectoryNoReplace } from "../../src-electron/platform/filesystem/rename-directory-no-replace.js";

// @test-value v2
// kind = "invariant"
// claim = "Native no-replace操作を読み込めない環境では通常renameへ退避せず明示的に失敗する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "Native bindingの取得失敗を握りつぶして通常renameでpublishする"
// observable = "ENOTSUPと元のcause、sourceの残存とdestinationの不存在"
// observation_boundary = "component-behavior"
// scope = "SessionFolder publishのno-replace capability境界"
// lifecycle = "permanent"
// impact = "排他的renameがない環境で既存SessionFolderを失う危険を防ぐ"
// distinction = "実FSの成功系ではnative symbolの欠落を再現できず型検査でもfallbackの実行を検出できない"
// @end-test-value
test("renameDirectoryNoReplace rejects unavailable native bindings without moving the source", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "withmate-no-replace-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  mkdirSync(source);
  const cause = new Error("Native rename symbol unavailable");
  const load = context.mock.method(koffi, "load", () => { throw cause; });
  try {
    assert.throws(() => renameDirectoryNoReplace(source, destination), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as NodeJS.ErrnoException).code, "ENOTSUP");
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(destination), false);
  } finally {
    load.mock.restore();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "未対応OSでは排他的renameの成功を装わずENOTSUPで停止する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "未対応OSを別OSのnative操作または通常renameへ流す"
// observable = "未対応platformでのENOTSUP例外"
// observation_boundary = "component-behavior"
// scope = "SessionFolder publishのplatform境界"
// lifecycle = "permanent"
// @end-test-value
test("renameDirectoryNoReplace explicitly rejects unsupported platforms", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "freebsd" });
  try {
    assert.throws(() => renameDirectoryNoReplace("source", "destination"), { code: "ENOTSUP" });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "不存在の宛先へのpublishは内容とdirectory identityを維持した単一renameとなる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "copy/deleteによりidentityが変わりcrash後のpublish照合が収束しない"
// observable = "sourceの不存在、destinationのdev/inoとファイル内容"
// observation_boundary = "component-behavior"
// scope = "SessionFolder publishの実filesystem identity"
// lifecycle = "permanent"
// impact = "publish直後のcrashから同じdirectoryを照合して再開する前提を守る"
// distinction = "型検査やmockではOSのrenameとcopy/deleteのidentity差を検出できない"
// @end-test-value
test("renameDirectoryNoReplace moves into a missing destination without changing directory identity", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "withmate-no-replace-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "元フォルダー-🌱");
  const destination = path.join(root, "公開フォルダー-🌸");
  mkdirSync(source);
  writeFileSync(path.join(source, "content.txt"), "source content");
  const before = lstatSync(source, { bigint: true });

  renameDirectoryNoReplace(source, destination);

  assert.equal(existsSync(source), false);
  const after = lstatSync(destination, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(readFileSync(path.join(destination, "content.txt"), "utf8"), "source content");
});

// @test-value v2
// kind = "invariant"
// claim = "既存宛先が空directory、非空directory、file、symlinkのいずれでも内容とidentityを置換せずsourceも保持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "publishで既存entryを上書きし別Sessionのデータまたはリンクを失う"
// observable = "sourceとdestinationのdev/ino、既存file内容、symlink target、native error情報"
// observation_boundary = "component-behavior"
// scope = "SessionFolder publishの実filesystem no-replace境界"
// lifecycle = "permanent"
// impact = "宛先衝突時にユーザーの既存SessionFolderを破壊しない"
// distinction = "通常renameも空directoryを置換できるため実FSでのentry種別別確認が必要"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
test("renameDirectoryNoReplace preserves every existing destination entry", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "withmate-no-replace-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ["empty-directory", "nonempty-directory", "file", "symlink"]) {
    const source = path.join(root, `source-${kind}`);
    const destination = path.join(root, `destination-${kind}`);
    mkdirSync(source);
    writeFileSync(path.join(source, "source.txt"), "source content");
    let linkTarget: string | undefined;
    if (kind === "file") {
      writeFileSync(destination, "destination content");
    } else if (kind === "symlink") {
      linkTarget = path.join(root, "link-target");
      mkdirSync(linkTarget);
      writeFileSync(path.join(linkTarget, "existing.txt"), "destination content");
      symlinkSync(linkTarget, destination, process.platform === "win32" ? "junction" : "dir");
    } else {
      mkdirSync(destination);
      if (kind === "nonempty-directory") writeFileSync(path.join(destination, "existing.txt"), "destination content");
    }
    const sourceBefore = lstatSync(source, { bigint: true });
    const destinationBefore = lstatSync(destination, { bigint: true });
    const targetBefore = kind === "symlink" ? readlinkSync(destination) : undefined;

    assert.throws(() => renameDirectoryNoReplace(source, destination), (error: unknown) => {
      assert.ok(error instanceof Error);
      const nativeError = error as NodeJS.ErrnoException & { dest: string };
      assert.equal(typeof nativeError.errno, "number");
      assert.ok(nativeError.errno! > 0);
      assert.equal(nativeError.path, source);
      assert.equal(nativeError.dest, destination);
      assert.ok(nativeError.syscall);
      return true;
    });

    const sourceAfter = lstatSync(source, { bigint: true });
    const destinationAfter = lstatSync(destination, { bigint: true });
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.equal(destinationAfter.dev, destinationBefore.dev);
    assert.equal(destinationAfter.ino, destinationBefore.ino);
    assert.equal(readFileSync(path.join(source, "source.txt"), "utf8"), "source content");
    if (kind === "file") assert.equal(readFileSync(destination, "utf8"), "destination content");
    if (kind === "nonempty-directory") assert.equal(readFileSync(path.join(destination, "existing.txt"), "utf8"), "destination content");
    if (linkTarget !== undefined) {
      assert.equal(readlinkSync(destination), targetBefore);
      assert.equal(readFileSync(path.join(linkTarget, "existing.txt"), "utf8"), "destination content");
    }
  }
});
