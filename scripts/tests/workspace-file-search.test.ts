import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  _getQueryCacheKeysForTesting,
  _getQueryCacheSizeForTesting,
  _setNowOverrideForTesting,
  _setQueryCacheMaxEntriesForTesting,
  _getContentVersionForTesting,
  _getValidatedAtForTesting,
  clearWorkspaceFileIndex,
  DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS,
  DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS,
  searchWorkspaceFilePaths,
} from "../../src-electron/workspace-file-search.js";
import {
  _setAfterIgnoreFileReadHookForTesting,
  _setIgnoreFileReadOverrideForTesting,
  _setIgnoreFileStatOverrideForTesting,
  _setWalkDirectoryReadOverrideForTesting,
  _setWalkDirectoryStatOverrideForTesting,
} from "../../src-electron/snapshot-ignore.js";

function createErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

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

  it("サブディレクトリ readdir の一時失敗で欠落した subtree は TTL 超過後に再走査され、復旧後は通常 TTL 延命へ戻る", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-readdir-failure-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "generated"), { recursive: true });
      await writeFile(path.join(workspacePath, "generated", "fresh.ts"), "", "utf8");

      const generatedDirectoryPath = path.resolve(path.join(workspacePath, "generated"));
      let shouldFailReaddir = true;
      _setWalkDirectoryReadOverrideForTesting(async (directoryPath) => {
        if (path.resolve(directoryPath) === generatedDirectoryPath && shouldFailReaddir) {
          shouldFailReaddir = false;
          throw createErrnoError("EBUSY");
        }
        return readdir(directoryPath, { withFileTypes: true });
      });

      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "fresh"),
        [],
        "readdir 失敗中は subtree が欠落したまま index されること",
      );
      const versionAfterPartialScan = _getContentVersionForTesting(workspacePath);
      assert.ok(versionAfterPartialScan !== undefined);

      _setWalkDirectoryReadOverrideForTesting(null);

      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "fresh"),
        [],
        "TTL 超過前は不完全 index がそのまま返ること",
      );

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "fresh"), ["generated/fresh.ts"]);
      const versionAfterRecovery = _getContentVersionForTesting(workspacePath);
      assert.notEqual(
        versionAfterRecovery,
        versionAfterPartialScan,
        "readdir 失敗を記録した scan は TTL 超過後に必ず再走査されること",
      );

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "fresh"), ["generated/fresh.ts"]);
      assert.equal(
        _getContentVersionForTesting(workspacePath),
        versionAfterRecovery,
        "clean scan 後は通常の TTL 延命に戻ること",
      );
    } finally {
      _setWalkDirectoryReadOverrideForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("サブディレクトリ stat の一時失敗でも監視が外れず、TTL 超過後に配下追加を検出できる", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-stat-failure-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "original.ts"), "", "utf8");

      const srcDirectoryPath = path.resolve(path.join(workspacePath, "src"));
      let shouldFailStat = true;
      _setWalkDirectoryStatOverrideForTesting(async (directoryPath) => {
        if (path.resolve(directoryPath) === srcDirectoryPath && shouldFailStat) {
          shouldFailStat = false;
          throw createErrnoError("EACCES");
        }
        return stat(directoryPath);
      });

      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "original"),
        ["src/original.ts"],
        "stat 失敗時でも readdir が成功すれば既存ファイルは index されること",
      );

      _setWalkDirectoryStatOverrideForTesting(null);
      const versionAfterStatFailureScan = _getContentVersionForTesting(workspacePath);
      assert.ok(versionAfterStatFailureScan !== undefined);

      await writeFile(path.join(workspacePath, "src", "added.ts"), "", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), [], "TTL 超過前は既存キャッシュが返ること");

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), ["src/added.ts"]);
      const versionAfterRecovery = _getContentVersionForTesting(workspacePath);
      assert.notEqual(
        versionAfterRecovery,
        versionAfterStatFailureScan,
        "stat 一時失敗を記録した directory は TTL 超過後に再走査されること",
      );

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "added"), ["src/added.ts"]);
      assert.equal(
        _getContentVersionForTesting(workspacePath),
        versionAfterRecovery,
        "clean scan 後は通常の TTL 延命に戻ること",
      );
    } finally {
      _setWalkDirectoryStatOverrideForTesting(null);
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

  it("query cache は上限を超えると recent 順に古い entry を排出する（review-20260419-0553 regression: query cache cap）", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-querycache-cap-"));
    _setQueryCacheMaxEntriesForTesting(3);

    try {
      await writeFile(path.join(workspacePath, "alpha.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "alphabet.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "beta.ts"), "", "utf8");

      await searchWorkspaceFilePaths(workspacePath, "a");
      await searchWorkspaceFilePaths(workspacePath, "al");
      await searchWorkspaceFilePaths(workspacePath, "alp");
      assert.equal(_getQueryCacheSizeForTesting(workspacePath), 3);
      assert.deepEqual(_getQueryCacheKeysForTesting(workspacePath), ["a", "al", "alp"]);

      // exact hit は recent 扱いになり末尾へ移動する
      await searchWorkspaceFilePaths(workspacePath, "a");
      assert.deepEqual(_getQueryCacheKeysForTesting(workspacePath), ["al", "alp", "a"]);

      // 新しい query を追加すると最も古い "al" が排出される
      await searchWorkspaceFilePaths(workspacePath, "z");
      assert.equal(_getQueryCacheSizeForTesting(workspacePath), 3);
      assert.deepEqual(_getQueryCacheKeysForTesting(workspacePath), ["alp", "a", "z"]);
    } finally {
      _setQueryCacheMaxEntriesForTesting(null);
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

  // ---------------------------------------------------------------------------
  // P1 回帰: .gitignore 変更によるキャッシュ失効
  // ---------------------------------------------------------------------------

  it(".gitignore の内容変更後は TTL 超過時に再走査される（P1 回帰）", async () => {
    // ファイルの内容変更は親ディレクトリの mtime を更新しない（NTFS / ext4 共通）。
    // visitedDirectories の mtime だけ見ていると .gitignore 編集を見逃す。
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-gitignore-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      // secret.ts を無視するルールを .gitignore に書く
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      // 初回走査: secret.ts は ignore される
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), []);
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "public"), ["public.ts"]);

      // .gitignore を書き換えて無視ルールを削除
      // → ファイル自身の mtime は変わるが、ディレクトリの mtime は変わらない
      await writeFile(path.join(workspacePath, ".gitignore"), "# no rules\n", "utf8");

      // TTL 超過前はキャッシュが生きている
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), []);

      // TTL 超過 → checkStructureUnchanged が .gitignore の mtime 変化を検出 → 再走査
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // P2 回帰: validatedAt を走査/検証完了後の時刻で記録する
  // ---------------------------------------------------------------------------

  it("再走査後の validatedAt は scanWorkspacePaths 完了後の時刻で記録される（P2 回帰: rescan path）", async () => {
    // getNow() を連番で返すシーケンスモックにより、
    // scan 前後で異なる時刻が返ることを利用して validatedAt の記録タイミングを検証する。
    // 期待: validatedAt === 2 回目の getNow() 戻り値（scan 完了後）
    // バグ: validatedAt === 1 回目の getNow() 戻り値（scan 開始前）
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-p2-rescan-"));

    const T1 = 1_000_000;
    const T2 = T1 + 42;
    let callIdx = 0;
    _setNowOverrideForTesting(() => (callIdx++ === 0 ? T1 : T2));

    try {
      await writeFile(path.join(workspacePath, "a.ts"), "", "utf8");
      // 初回検索（キャッシュなし）: getNow() call-0 → T1、scan 後 call-1 → T2
      await searchWorkspaceFilePaths(workspacePath, "a");

      const validatedAt = _getValidatedAtForTesting(workspacePath);
      assert.equal(
        validatedAt,
        T2,
        "scan 完了後に getNow() が呼ばれ、その時刻が validatedAt に記録されること",
      );
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("TTL 延命時の validatedAt は checkStructureUnchanged 完了後の時刻で記録される（P2 回帰: TTL renewal path）", async () => {
    // 期待: validatedAt === checkStructureUnchanged 完了後の getNow() 戻り値
    // バグ: validatedAt === checkStructureUnchanged 開始前に取得した now の値
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-p2-renewal-"));

    const T0 = 1_000_000;
    _setNowOverrideForTesting(() => T0);

    try {
      await writeFile(path.join(workspacePath, "b.ts"), "", "utf8");
      // 初回走査
      await searchWorkspaceFilePaths(workspacePath, "b");

      // TTL 延命用シーケンス: call-0 → T_stale（stale 判定用）、call-1 以降 → T_after_check
      const T_stale = T0 + DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      const T_after_check = T_stale + 7;
      let renewalCallIdx = 0;
      _setNowOverrideForTesting(() => (renewalCallIdx++ === 0 ? T_stale : T_after_check));

      // 構造変化なし → TTL 延命パス
      await searchWorkspaceFilePaths(workspacePath, "b");

      const validatedAt = _getValidatedAtForTesting(workspacePath);
      assert.equal(
        validatedAt,
        T_after_check,
        "TTL 延命時は checkStructureUnchanged 完了後の時刻で validatedAt が更新されること",
      );
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // P2 回帰: 外部 ignore ファイルの新規作成によるキャッシュ失効
  // ---------------------------------------------------------------------------

  it(".git/info/exclude が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: exclude 新規作成）", async () => {
    // .git/ ディレクトリを手動作成して gitRoot = workspacePath にする。
    // .git/info/exclude は最初存在せず absentIgnoreCandidates に記録される。
    // ファイル作成後に TTL 超過すると checkStructureUnchanged が出現を検知して再走査が起きる。
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-p2-exclude-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      // .git/info/ ディレクトリだけ作成（exclude ファイルはまだ作らない）
      await mkdir(path.join(workspacePath, ".git", "info"), { recursive: true });
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");

      // 初回走査: exclude なし → secret.ts も含まれる
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);

      // .git/info/exclude を作成して secret.ts を除外するルールを追加
      await writeFile(path.join(workspacePath, ".git", "info", "exclude"), "secret.ts\n", "utf8");

      // TTL 超過前はキャッシュが生きている
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);

      // TTL 超過 → checkStructureUnchanged が absentIgnoreCandidates に exclude の出現を検知 → 再走査
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      // 再走査: exclude のルールが適用される → secret.ts が除外される
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), []);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("workspace 外の親 .gitignore が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: 親 .gitignore 新規作成）", async () => {
    // outerDir 配下に workspace を作成する。gitRoot がない状態で initial scan を行うと
    // outerDir/.gitignore が absentIgnoreCandidates に記録される。
    // ファイル作成後に TTL 超過すると checkStructureUnchanged が出現を検知して再走査が起きる。
    // 前提: os.tmpdir() の祖先に .git が存在しないこと（通常のシステムでは成立する）。
    const outerDir = await mkdtemp(path.join(os.tmpdir(), "withmate-p2-outer-"));
    const workspacePath = path.join(outerDir, "workspace");
    await mkdir(workspacePath, { recursive: true });

    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");

      // 初回走査: 親 .gitignore なし → secret.ts も含まれる
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);

      // outerDir に .gitignore を作成して secret.ts を除外するルールを追加
      await writeFile(path.join(outerDir, ".gitignore"), "secret.ts\n", "utf8");

      // TTL 超過前はキャッシュが生きている
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);

      // TTL 超過 → checkStructureUnchanged が absentIgnoreCandidates に outerDir/.gitignore の出現を検知 → 再走査
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      // 再走査: outerDir/.gitignore のルールが適用される → secret.ts が除外される
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), []);
    } finally {
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(outerDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // P3 回帰: createIgnoreMatcher の retry による整合版採用
  // ---------------------------------------------------------------------------

  it("ignore ファイルが read と stat の間で更新されても retry 後の整合した最新版が採用される（P3 回帰: retry）", async () => {
    // シナリオ:
    //   1. .gitignore は "# no rules" の状態で走査開始
    //   2. readFile 完了直後のフックが 1 回だけ .gitignore を "secret.ts\n" に書き換える
    //   3. 確認 stat で mtime/size が変化していることを検出 → race と判定し retry
    //   4. retry 時はフック不発 → 新しい内容 "secret.ts\n" で整合確認できる → loaded
    //   5. 最終的に secret.ts が ignore されるため searchWorkspaceFilePaths が [] を返す
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-p3-retry-"));

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      // 初期状態: ルールなし（secret.ts は除外されない）
      await writeFile(path.join(workspacePath, ".gitignore"), "# no rules\n", "utf8");

      const gitignorePath = path.join(workspacePath, ".gitignore");

      // フック: 最初の readFile 直後に 1 回だけ .gitignore を secret.ts ルールへ書き換える
      let hookFired = false;
      _setAfterIgnoreFileReadHookForTesting(async (filePath) => {
        if (!hookFired && filePath === path.resolve(gitignorePath)) {
          hookFired = true;
          await writeFile(gitignorePath, "secret.ts\n", "utf8");
        }
      });

      clearWorkspaceFileIndex(workspacePath);
      // retry 後に "secret.ts\n" ルールが採用されるため secret.ts は除外される
      const results = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(results, [], "retry 後の整合した最新版（secret.ts ルール）が採用され secret.ts が除外されること");
    } finally {
      _setAfterIgnoreFileReadHookForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // review-20260419-0444 回帰: race した ignore ファイルが TTL 後の失効を引き起こす
  // ---------------------------------------------------------------------------

  it("初期 scan で .gitignore が全 retry 競合 (race) した場合、TTL 超過後に再走査される（review-20260419-0444 regression: initial load）", async () => {
    // シナリオ:
    //   1. .gitignore は "secret.ts\n" の状態で初期 scan 開始
    //   2. hook が全 retry にわたって .gitignore を書き換え続ける → kind: "race"
    //   3. race → ignoreFiles に race 状態が記録される → .gitignore ルール未適用 → secret.ts が含まれる
    //   4. hook を解除（ファイルは安定状態になる）
    //   5. TTL 超過 → checkStructureUnchanged が race 状態を検出 → re-scan
    //   6. 再走査で "secret.ts\n" ルールが適用され secret.ts が除外される
    //
    // 注: NTFS / ext4 ではファイル書き込みが親ディレクトリの mtime を変えないため、
    //     visitedDirectories チェックは pass し、sentinel だけが re-scan を引き起こす。
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-race-initial-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      const gitignorePath = path.join(workspacePath, ".gitignore");

      // hook: 呼ばれるたびに '#' を 1 文字ずつ増やしてファイルサイズを単調増加させる。
      // これにより、前後 stat の size が必ず異なるため、Windows NTFS の mtime 精度に
      // 依存せず全 retry で race を確実に検出できる。
      let hookCallCount = 0;
      _setAfterIgnoreFileReadHookForTesting(async (filePath) => {
        if (filePath === path.resolve(gitignorePath)) {
          hookCallCount++;
          // サイズを hookCallCount に比例して増加させることで size 不一致を保証する
          await writeFile(gitignorePath, "secret.ts\n" + "#".repeat(hookCallCount) + "\n", "utf8");
        }
      });

      clearWorkspaceFileIndex(workspacePath);
      // 初期 scan: .gitignore が全 retry で race → rules 未適用 → secret.ts が含まれる
      const resultsWithRace = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsWithRace, ["secret.ts"], "race 中は .gitignore ルールが適用されず secret.ts が含まれること");

      // hook 解除: 以降は .gitignore が安定している
      _setAfterIgnoreFileReadHookForTesting(null);

      // TTL 超過 → race 状態検出 → re-scan
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      const resultsAfterRescan = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsAfterRescan, [], "再走査後は .gitignore ルールが適用され secret.ts が除外されること");
    } finally {
      _setAfterIgnoreFileReadHookForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("root .gitignore の read が EBUSY 連発でも unreadable に固定されず TTL 超過後に再走査される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-busy-root-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      const gitignorePath = path.resolve(path.join(workspacePath, ".gitignore"));
      _setIgnoreFileReadOverrideForTesting((ignoreFilePath) => {
        if (path.resolve(ignoreFilePath) === gitignorePath) {
          throw createErrnoError("EBUSY");
        }
        throw new Error(`unexpected ignore file read override hit: ${ignoreFilePath}`);
      });

      clearWorkspaceFileIndex(workspacePath);
      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        ["secret.ts"],
        "EBUSY 中は .gitignore を読めず secret.ts が含まれること",
      );

      _setIgnoreFileReadOverrideForTesting(null);

      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        ["secret.ts"],
        "TTL 超過前は既存キャッシュが返ること",
      );

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        [],
        "EBUSY は race-like 扱いとなり TTL 超過後の再走査で ignore ルールが反映されること",
      );
    } finally {
      _setIgnoreFileReadOverrideForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("root .gitignore の初回 stat が access error でも監視が外れず TTL 超過後に再評価される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-stat-access-root-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      const gitignorePath = path.resolve(path.join(workspacePath, ".gitignore"));
      let remainingFailures = 2;
      _setIgnoreFileStatOverrideForTesting(async (ignoreFilePath) => {
        if (path.resolve(ignoreFilePath) === gitignorePath && remainingFailures > 0) {
          remainingFailures--;
          throw createErrnoError("EACCES");
        }
        return stat(ignoreFilePath);
      });

      clearWorkspaceFileIndex(workspacePath);
      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        ["secret.ts"],
        "初回 stat 失敗中は .gitignore が未適用で secret.ts が含まれること",
      );

      _setIgnoreFileStatOverrideForTesting(null);

      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        ["secret.ts"],
        "TTL 超過前は既存キャッシュが返ること",
      );

      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(
        await searchWorkspaceFilePaths(workspacePath, "secret"),
        [],
        "初回 stat の access error でも race-like に追跡され TTL 超過後に ignore ルールが反映されること",
      );
    } finally {
      _setIgnoreFileStatOverrideForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("walkWorkspace 中のサブディレクトリ .gitignore が全 retry 競合 (race) した場合、TTL 超過後に再走査される（review-20260419-0444 regression: walk）", async () => {
    // シナリオ:
    //   1. sub/.gitignore は "secret.ts\n" の状態で scan 開始
    //   2. hook が全 retry にわたって sub/.gitignore を書き換え続ける → kind: "race"
    //   3. race → ignoreFiles に race 状態が記録される → sub/.gitignore ルール未適用 → sub/secret.ts が含まれる
    //   4. hook を解除
    //   5. TTL 超過 → race 状態検出 → re-scan
    //   6. 再走査で "secret.ts\n" ルールが適用され sub/secret.ts が除外される
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-race-walk-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "sub"), { recursive: true });
      await writeFile(path.join(workspacePath, "sub", "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "sub", "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "sub", ".gitignore"), "secret.ts\n", "utf8");

      const subGitignorePath = path.join(workspacePath, "sub", ".gitignore");

      // hook: 呼ばれるたびに '#' を 1 文字ずつ増やしてファイルサイズを単調増加させる。
      // これにより、前後 stat の size が必ず異なるため、Windows NTFS の mtime 精度に
      // 依存せず全 retry で race を確実に検出できる。
      let hookCallCount = 0;
      _setAfterIgnoreFileReadHookForTesting(async (filePath) => {
        if (filePath === path.resolve(subGitignorePath)) {
          hookCallCount++;
          // サイズを hookCallCount に比例して増加させることで size 不一致を保証する
          await writeFile(subGitignorePath, "secret.ts\n" + "#".repeat(hookCallCount) + "\n", "utf8");
        }
      });

      clearWorkspaceFileIndex(workspacePath);
      // 初期 scan: sub/.gitignore が全 retry で race → rules 未適用 → sub/secret.ts が含まれる
      const resultsWithRace = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsWithRace, ["sub/secret.ts"], "race 中は sub/.gitignore ルールが適用されず sub/secret.ts が含まれること");

      // hook 解除
      _setAfterIgnoreFileReadHookForTesting(null);

      // TTL 超過 → race 状態検出 → re-scan
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      const resultsAfterRescan = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsAfterRescan, [], "再走査後は sub/.gitignore ルールが適用され sub/secret.ts が除外されること");
    } finally {
      _setAfterIgnoreFileReadHookForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("安定して unreadable な .gitignore は毎 TTL では再走査されず、retry interval 後に再評価される（review-20260419-0553 regression: unreadable root — 全 retry が stable unreadable の場合のみ unreadable に確定する）", async () => {
    // 注: このテストは「全 3 試行がすべて stable unreadable（EACCES）で終わる」シナリオを検証する。
    // 全 retry を消費して初めて unreadable に確定する。
    // 1 試行でも成功すれば "loaded" に、race/transient と混在すれば "race" になる（review-0650 修正済み）。
    //
    // root .gitignore の読み取りは 2 箇所で発生する:
    //   1. loadInitialIgnoreMatchers() — ワークスペース初期化時
    //   2. walkWorkspace() の root directory 処理 — ファイル走査時
    // persistent unreadable の場合、両箇所でそれぞれ全 retry（3 回）を消費するため
    // 合計 readCallCount は 3 × 2 = 6 になる。
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-unreadable-root-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      const gitignorePath = path.join(workspacePath, ".gitignore");
      let readCallCount = 0;
      _setIgnoreFileReadOverrideForTesting((filePath) => {
        if (filePath === path.resolve(gitignorePath)) {
          readCallCount++;
          throw createErrnoError("EACCES");
        }
        throw new Error(`unexpected ignore read path: ${filePath}`);
      });

      clearWorkspaceFileIndex(workspacePath);
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);
      assert.equal(readCallCount, 6, "root .gitignore は loadInitialIgnoreMatchers() と walkWorkspace() の両箇所で全 retry（3 回）を消費するため、persistent unreadable では計 6 回読み取り試行されること");
      const versionAfterUnreadableScan = _getContentVersionForTesting(workspacePath);
      assert.ok(versionAfterUnreadableScan !== undefined, "初回 scan 後に contentVersion が取得できること");

      // 1 回 TTL を超えても、stable unreadable は再走査されない
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), ["secret.ts"]);
      assert.equal(
        _getContentVersionForTesting(workspacePath),
        versionAfterUnreadableScan,
        "stable unreadable は毎 TTL で再走査されないこと",
      );

      // 読み取り不能を解消し、retry interval 超過後に再評価させる
      _setIgnoreFileReadOverrideForTesting(null);
      fakeNow += DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS;

      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "secret"), []);
      assert.notEqual(
        _getContentVersionForTesting(workspacePath),
        versionAfterUnreadableScan,
        "retry interval 超過後は再走査され stable unreadable から回復できること",
      );
    } finally {
      _setIgnoreFileReadOverrideForTesting(null);
      _setAfterIgnoreFileReadHookForTesting(null);
      _setNowOverrideForTesting(null);
      _setQueryCacheMaxEntriesForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // review-0650 回帰: 最初の数試行のみ unreadable で後続試行が成功するケース
  // ---------------------------------------------------------------------------

  it("root .gitignore が最初の 2 試行のみ unreadable（EACCES/EBUSY）で 3 回目に成功した場合はルールが適用される（review-0650 回帰: transient unreadable → loaded）", async () => {
    // シナリオ:
    //   1. .gitignore は "secret.ts\n" の内容
    //   2. 1 回目の readFile: EACCES を投げる（一時的に読めない）
    //   3. 2 回目の readFile: EBUSY を投げる（一時的に読めない）
    //   4. 3 回目の readFile: 実際の内容 "secret.ts\n" を返す → loaded に確定
    //   5. ルールが適用され secret.ts が除外される → searchWorkspaceFilePaths が [] を返す
    //   6. 読み取り試行回数が 3 回であることを確認
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-transient-unreadable-"));

    try {
      await writeFile(path.join(workspacePath, "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, ".gitignore"), "secret.ts\n", "utf8");

      const gitignorePath = path.join(workspacePath, ".gitignore");
      let readCallCount = 0;
      _setIgnoreFileReadOverrideForTesting((filePath) => {
        if (filePath === path.resolve(gitignorePath)) {
          readCallCount++;
          if (readCallCount === 1) throw createErrnoError("EACCES");
          if (readCallCount === 2) throw createErrnoError("EBUSY");
          // 3 回目: 実際のファイル内容（"secret.ts\n"）を返す → loaded に確定
          return "secret.ts\n";
        }
        throw new Error(`unexpected ignore read path: ${filePath}`);
      });

      clearWorkspaceFileIndex(workspacePath);
      const results = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(results, [], "3 回目の試行で成功し secret.ts ルールが適用されること");
      assert.equal(readCallCount, 3, "読み取り試行回数が 3 回であること");
    } finally {
      _setIgnoreFileReadOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  // review-0650 回帰: stable unreadable と race-like が混在した場合は race を優先する
  it("review-0650: subdir .gitignore で stable unreadable と race-like が混在した場合、race が優先され TTL 超過後に再走査される", async () => {
    // シナリオ:
    //   1. sub/.gitignore は "secret.ts\n" の内容
    //   2. 全 3 試行ともに読み取りは失敗するが、エラー種別を混在させる:
    //      1 回目: EACCES（stable unreadable）
    //      2 回目: ENOENT（race-like: 非 stable エラー）
    //      3 回目: EACCES（stable unreadable）
    //   3. sawStableUnreadable && sawRaceLikeFailure → race 優先 → kind: "race"
    //   4. race → sub/.gitignore ルール未適用 → sub/secret.ts が含まれる
    //   5. override 解除後、TTL 超過 → race 状態検出 → re-scan → ルール適用 → []
    //
    // subdir .gitignore は loadInitialIgnoreMatchers() では読まれず walkWorkspace() のみで
    // 読まれるため、readCallCount は全 3 試行分の 3 になる。
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mixed-unreadable-"));
    let fakeNow = Date.now();
    _setNowOverrideForTesting(() => fakeNow);

    try {
      await mkdir(path.join(workspacePath, "sub"), { recursive: true });
      await writeFile(path.join(workspacePath, "sub", "secret.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "sub", "public.ts"), "", "utf8");
      await writeFile(path.join(workspacePath, "sub", ".gitignore"), "secret.ts\n", "utf8");

      const subGitignorePath = path.join(workspacePath, "sub", ".gitignore");
      let readCallCount = 0;
      _setIgnoreFileReadOverrideForTesting((filePath) => {
        if (filePath === path.resolve(subGitignorePath)) {
          readCallCount++;
          if (readCallCount === 1) throw createErrnoError("EACCES"); // stable unreadable
          if (readCallCount === 2) throw createErrnoError("ENOENT"); // race-like (非 stable)
          throw createErrnoError("EACCES"); // stable unreadable
        }
        throw new Error(`unexpected ignore read path: ${filePath}`);
      });

      clearWorkspaceFileIndex(workspacePath);
      // 初期 scan: stable/race-like 混在 → race 優先 → ルール未適用 → sub/secret.ts が含まれる
      const resultsWithMixed = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsWithMixed, ["sub/secret.ts"], "混在時は race 優先でルールが適用されず sub/secret.ts が含まれること");
      assert.equal(readCallCount, 3, "全 3 試行が消費されること");

      // override 解除
      _setIgnoreFileReadOverrideForTesting(null);

      // TTL 超過 → race 状態検出 → re-scan → ルール適用 → []
      fakeNow += DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100;

      const resultsAfterRescan = await searchWorkspaceFilePaths(workspacePath, "secret");
      assert.deepEqual(resultsAfterRescan, [], "再走査後は sub/.gitignore ルールが適用され sub/secret.ts が除外されること");
    } finally {
      _setIgnoreFileReadOverrideForTesting(null);
      _setNowOverrideForTesting(null);
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

});
