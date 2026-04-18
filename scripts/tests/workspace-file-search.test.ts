import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  _setNowOverrideForTesting,
  _getContentVersionForTesting,
  _getValidatedAtForTesting,
  clearWorkspaceFileIndex,
  DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS,
  searchWorkspaceFilePaths,
} from "../../src-electron/workspace-file-search.js";
import { _setAfterIgnoreFileReadHookForTesting } from "../../src-electron/snapshot-ignore.js";

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

});
