import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  _setNowOverrideForTesting,
  _getContentVersionForTesting,
  clearWorkspaceFileIndex,
  DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS,
  searchWorkspaceFilePaths,
} from "../../src-electron/workspace-file-search.js";

describe("workspace-file-search", () => {
  it("cache clear 後は新規 file が再検索結果へ反映される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-clear-"));

    try {
      await writeFile(path.join(workspacePath, "alpha.txt"), "alpha", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "alpha"), ["alpha.txt"]);

      await mkdir(path.join(workspacePath, "generated"), { recursive: true });
      await writeFile(path.join(workspacePath, "generated", "fresh-file.ts"), "export {};\n", "utf8");

      clearWorkspaceFileIndex(workspacePath);

      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "fresh-file"), ["generated/fresh-file.ts"]);
    } finally {
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("TTL を過ぎた cache は自動再走査される（構造変化あり）", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-ttl-"));
    // 時刻を固定して TTL を制御する
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "existing.txt"), "existing", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), []);

      // TTL 超過前に新規ファイルを追加してもキャッシュが返る
      await writeFile(path.join(workspacePath, "later-file.txt"), "later", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), []);

      // 時刻を TTL 分だけ進める（実時間 sleep 不要）
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      // TTL 超過 + ルートにファイルが増えた（構造変化あり）→ 再走査
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), ["later-file.txt"]);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("TTL を過ぎても構造変化がなければ再走査されず同じ結果を返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-ttl-nochange-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "stable.txt"), "stable", "utf8");
      // 初回走査
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "stable"), ["stable.txt"]);

      // TTL 超過（ファイル追加なし = 構造変化なし）
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      // 構造変化なし → キャッシュ継続（新ファイルがないので結果は変わらない）
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "stable"), ["stable.txt"]);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("サブディレクトリ内のファイル追加は TTL 超過後に検出される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-subdir-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "original.ts"), "", "utf8");
      // 初回走査
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), []);

      // TTL 超過前にサブディレクトリへファイル追加
      await writeFile(path.join(workspacePath, "src", "added.ts"), "", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), []);

      // TTL 超過 → src ディレクトリの mtime が変化しているため構造変化と判定
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), ["src/added.ts"]);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("連続 query / クエリキャッシュを使っても substring 検索結果が壊れない", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-querycache-"));

    try {
      await mkdir(path.join(workspacePath, "components"), { recursive: true });
      await writeFile(path.join(workspacePath, "components", "Button.tsx"), "", "utf8");
      await writeFile(path.join(workspacePath, "components", "ButtonGroup.tsx"), "", "utf8");
      await writeFile(path.join(workspacePath, "components", "IconButton.tsx"), "", "utf8");
      await writeFile(path.join(workspacePath, "index.ts"), "", "utf8");

      // 1 回目の検索結果
      const first = await searchWorkspaceFilePaths(workspacePath, "button");
      assert.deepEqual(first, [
        "components/Button.tsx",
        "components/ButtonGroup.tsx",
        "components/IconButton.tsx",
      ]);

      // 同一クエリを繰り返してもキャッシュから同一結果が返る
      const second = await searchWorkspaceFilePaths(workspacePath, "button");
      assert.deepEqual(second, first);

      // 別のクエリは独立して正しい結果を返す
      const third = await searchWorkspaceFilePaths(workspacePath, "index");
      assert.deepEqual(third, ["index.ts"]);

      // 大文字小文字を変えても同じ結果（toLowerCaseで正規化済み）
      const fourth = await searchWorkspaceFilePaths(workspacePath, "Button");
      assert.deepEqual(fourth, first);

      // clear 後は新しいキャッシュが作られ、結果は変わらない（同じファイルがある）
      clearWorkspaceFileIndex(workspacePath);
      const fifth = await searchWorkspaceFilePaths(workspacePath, "button");
      assert.deepEqual(fifth, first);
    } finally {
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("clearWorkspaceFileIndex でクエリキャッシュも破棄される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-cache-clear-"));

    try {
      await writeFile(path.join(workspacePath, "foo.ts"), "", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "foo"), ["foo.ts"]);

      // clear → 新ファイル追加 → clear しているので次の検索は再走査される
      clearWorkspaceFileIndex(workspacePath);
      await writeFile(path.join(workspacePath, "bar.ts"), "", "utf8");
      // ここで再走査が起きるため bar.ts も含まれる
      const results = await searchWorkspaceFilePaths(workspacePath, "bar");
      assert.deepEqual(results, ["bar.ts"]);
    } finally {
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("TTL 更新後も query cache が再利用可能なままである（contentVersion 不変を検証）", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-ttl-qcache-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "target.ts"), "", "utf8");

      // 初回検索 → index 構築 + query cache 登録
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "target"), ["target.ts"]);
      const versionAfterFirstScan = _getContentVersionForTesting(workspacePath);
      assert.ok(versionAfterFirstScan !== undefined, "初回走査後に contentVersion が取得できること");

      // TTL 超過（ファイル変化なし = 構造変化なし）
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      // 同一クエリ → TTL 更新のみ（再走査なし）→ contentVersion は変わらず query cache が有効
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "target"), ["target.ts"]);
      const versionAfterTTLRenewal = _getContentVersionForTesting(workspacePath);
      assert.equal(
        versionAfterTTLRenewal,
        versionAfterFirstScan,
        "TTL のみの延命では contentVersion が変わらないこと（= query cache が生き続けること）",
      );
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("2 段以上深いディレクトリへのファイル追加は TTL 超過後に検出される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-deep-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "src", "components"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "components", "Button.tsx"), "", "utf8");
      // 初回走査（visitedDirectories に src/ と src/components/ が記録される）
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "NewComp"), []);

      // TTL 超過前に 2 段目ディレクトリ配下へファイル追加
      await writeFile(path.join(workspacePath, "src", "components", "NewComp.tsx"), "", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "NewComp"), []);

      // TTL 超過 → src/components の mtime が変化 → visitedDirectories で構造変化と判定 → 再走査
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "NewComp"), [
        "src/components/NewComp.tsx",
      ]);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("再走査後は contentVersion が更新され query cache が失効する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-rescan-version-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "existing.ts"), "", "utf8");

      // 初回検索 → index 構築
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "existing"), ["existing.ts"]);
      const versionAfterFirstScan = _getContentVersionForTesting(workspacePath);
      assert.ok(versionAfterFirstScan !== undefined);

      // TTL 超過 + ファイル追加（構造変化あり）→ 再走査
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      await writeFile(path.join(workspacePath, "added.ts"), "", "utf8");

      // 再走査後は新ファイルが見え、contentVersion も更新される
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), ["added.ts"]);
      const versionAfterRescan = _getContentVersionForTesting(workspacePath);
      assert.notEqual(
        versionAfterRescan,
        versionAfterFirstScan,
        "再走査後は contentVersion が更新されること",
      );
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
