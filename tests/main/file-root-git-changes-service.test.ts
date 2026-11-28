import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileRootGitChangesService } from "../../src-electron/files/file-root-git-changes-service.js";
import {
  parseGitHistoryLog,
  parseGitHistoryAvailableRefs,
  parseGitHistoryNameStatusZ,
  parseGitPorcelainV1Z,
} from "../../src-electron/files/file-root-git-parsers.js";
import type { FileRootChangesResult } from "../../src-shared/file-explorer/file-explorer-contract.js";

const EXPECTED_GIT_GLOBAL_ARGS = [
  "--no-optional-locks",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
];

/** 指定した作業ディレクトリーと環境でGitを実行し、出力のバイト列と終了結果を収集する。 */
function runGitForTest(
  workspacePath: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    executablePath?: string;
    stdin?: Buffer;
    signal?: AbortSignal;
  } = { env: process.env },
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executablePath ?? "git",
      ["-C", workspacePath, ...args],
      {
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
    child.stdin.end(options.stdin);
  });
}

/** 処理の完了を待つ間だけイベントループを維持し、終了時はタイマーを解放する。 */
async function runWithReferencedEventLoopHandle<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const eventLoopHandle = setInterval(() => undefined, 1_000);
  try {
    return await operation();
  } finally {
    clearInterval(eventLoopHandle);
  }
}

/** ディレクトリーをGitリポジトリにし、後続の差分比較に使う基準コミットを作る。 */
async function initializeRepository(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  assert.equal(
    (await runGitForTest(repositoryPath, ["init", "--quiet"])).exitCode,
    0,
  );
  await writeFile(path.join(repositoryPath, "tracked.txt"), "base\n");
  assert.equal(
    (await runGitForTest(repositoryPath, ["add", "tracked.txt"])).exitCode,
    0,
  );
  assert.equal(
    (
      await runGitForTest(repositoryPath, [
        "-c",
        "user.name=WithMate Test",
        "-c",
        "user.email=withmate@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ])
    ).exitCode,
    0,
  );
}

/** NUL区切りのstatus出力から、作業ツリー、ステージ済み、未追跡、名前変更のパスと区分を分けて取り出す。 */
test("parseGitPorcelainV1Z は working tree / staged / untracked / rename を scope 付きで返す", () => {
  const output = Buffer.from(
    " M src/a.ts\0M  src/b.ts\0?? src/new.ts\0R  src/to.ts\0src/from.ts\0",
    "utf8",
  );
  assert.deepEqual(parseGitPorcelainV1Z(output), [
    {
      relativePath: "src/a.ts",
      previousRelativePath: null,
      kinds: { "working-tree": "modified" },
      scopes: ["working-tree"],
    },
    {
      relativePath: "src/b.ts",
      previousRelativePath: null,
      kinds: { staged: "modified" },
      scopes: ["staged"],
    },
    {
      relativePath: "src/new.ts",
      previousRelativePath: null,
      kinds: { "working-tree": "untracked" },
      scopes: ["working-tree"],
    },
    {
      relativePath: "src/to.ts",
      previousRelativePath: "src/from.ts",
      kinds: { staged: "renamed" },
      scopes: ["staged"],
    },
  ]);
});

/** 入れ子のWorkspace外を除外し、境界をまたぐ名前変更もWorkspace相対パスと各区分の変更種別に変換する。 */
test("parseGitPorcelainV1Z は nested Workspace の path を Workspace-relative にし scope ごとの kind を保つ", () => {
  const output = Buffer.from(
    "MD src/a.ts\0?? src/new.ts\0 M docs/outside.md\0R  src/in.ts\0docs/from.ts\0R  docs/out.ts\0src/old.ts\0",
    "utf8",
  );
  assert.deepEqual(parseGitPorcelainV1Z(output, "src/"), [
    {
      relativePath: "a.ts",
      previousRelativePath: null,
      kinds: { staged: "modified", "working-tree": "deleted" },
      scopes: ["staged", "working-tree"],
    },
    {
      relativePath: "new.ts",
      previousRelativePath: null,
      kinds: { "working-tree": "untracked" },
      scopes: ["working-tree"],
    },
    {
      relativePath: "in.ts",
      previousRelativePath: null,
      kinds: { staged: "added" },
      scopes: ["staged"],
    },
    {
      relativePath: "old.ts",
      previousRelativePath: null,
      kinds: { staged: "deleted" },
      scopes: ["staged"],
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Git履歴parserはcommit metadata、HEAD/local branch/tag、rename/copy status、heads/remotes/tagsのref種別をpublic projectionへ変換する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "Git履歴のmetadataやref種別が欠落する、またはrename/copyのpath順を取り違える"
// observable = "parseGitHistoryLog、parseGitHistoryNameStatusZ、parseGitHistoryAvailableRefsのresult"
// observation_boundary = "public-boundary"
// scope = "Git history parser projections"
// lifecycle = "permanent"
// impact = "HistoryとCompareが利用可能なcommit metadata、変更path、ref種別を正しく表示・選択できる"
// distinction = "commit decoration、rename/copy status、heads/remotes/tagsのref種別をparserのpublic resultで同時に確認する"
// @end-test-value
/** ログのコミット情報とref種別、NUL区切りの名前変更・コピーを公開用の形へ変換する。 */
test("Git history parser はcommit metadata、HEAD/local branch/tag、rename/copy statusをprojectionする", () => {
  const firstCommitId = "a".repeat(40);
  const secondCommitId = "b".repeat(40);
  const output = Buffer.from(
    `${firstCommitId}\0aaaaaaa\0Author\0author@example.invalid\x002026-08-22T00:00:00+00:00\0Add history\0${secondCommitId}\0HEAD -> refs/heads/main, refs/tags/v1.0, refs/remotes/origin/main\0\x01\n` +
      `${secondCommitId}\0bbbbbbb\0Author\0author@example.invalid\x002026-08-21T00:00:00+00:00\0Base\0\0\0\x01\n`,
    "utf8",
  );
  assert.deepEqual(parseGitHistoryLog(output), [
    {
      id: firstCommitId,
      shortHash: "aaaaaaa",
      subject: "Add history",
      authorName: "Author",
      authorEmail: "author@example.invalid",
      authoredAt: "2026-08-22T00:00:00.000Z",
      refs: [
        { kind: "head", name: "HEAD" },
        { kind: "branch", name: "main" },
        { kind: "tag", name: "v1.0" },
      ],
      parentIds: [secondCommitId],
    },
    {
      id: secondCommitId,
      shortHash: "bbbbbbb",
      subject: "Base",
      authorName: "Author",
      authorEmail: "author@example.invalid",
      authoredAt: "2026-08-21T00:00:00.000Z",
      refs: [],
      parentIds: [],
    },
  ]);
  assert.deepEqual(
    parseGitHistoryNameStatusZ(
      Buffer.from(
        "R100\0src/old.ts\0src/new.ts\0C100\0src/new.ts\0src/copy.ts\0",
        "utf8",
      ),
    ),
    [
      {
        relativePath: "src/new.ts",
        previousRelativePath: "src/old.ts",
        kinds: { commit: "renamed" },
        scopes: ["commit"],
      },
      {
        relativePath: "src/copy.ts",
        previousRelativePath: "src/new.ts",
        kinds: { commit: "copied" },
        scopes: ["commit"],
      },
    ],
  );
  assert.deepEqual(
    parseGitHistoryAvailableRefs(
      Buffer.from(
        "refs/heads/main\nrefs/remotes/origin/main\nrefs/tags/v1.0\nrefs/heads/main\n",
        "utf8",
      ),
    ),
    [
      { kind: "branch", name: "main" },
      { kind: "remote", name: "origin/main" },
      { kind: "tag", name: "v1.0" },
    ],
  );
});

// @test-value v2
// kind = "contract"
// claim = "Git履歴のCompareはdirectとbranch changesを別の比較範囲として解決し、remote tracking/短縮commitとnested rootの変更・previewを固定OIDで返す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Compare" }
// fault = "untracked working-tree fileを比較へ混ぜる、branch changesをbase commitから直接比較する、remote tracking/短縮commitを解決できない、nested rootのscopeを越える、またはref移動後にpatchの対象OIDを差し替える"
// observable = "available refs、comparison resultのmode/baseCommitId/targetCommitId/mergeBaseCommitId、changed entries、comparison diffのpatchとpreview resources"
// observation_boundary = "public-boundary"
// scope = "FileRootGitChangesService history comparison"
// lifecycle = "permanent"
// impact = "利用者が選んだ2つのGit ref間の差分を、working treeや別rootのfileを混ぜずに再現できる"
// distinction = "分岐後にbase側だけ進んだ実Git repositoryを作り、directとmerge-base起点のbranch changes、nested rootのadded-file preview、remote ref、短縮commit、ref移動後のsnapshot固定を同時に確認する"
// @end-test-value
/** 直接比較と分岐点からの比較で異なる範囲を使い、ブランチが移動しても解決済みOIDと入れ子のプレビュー範囲を維持する。 */
test("FileRootGitChangesService はdirectとbranch changesを固定OIDで比較しnested rootのpreviewをscopeする", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-comparison-"),
  );
  try {
    await initializeRepository(repositoryPath);
    assert.equal(
      (await runGitForTest(repositoryPath, ["branch", "-M", "main"])).exitCode,
      0,
    );
    const baseCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", "HEAD"])
    ).stdout
      .toString("utf8")
      .trim();
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "checkout",
          "-b",
          "feature/compare",
        ])
      ).exitCode,
      0,
    );
    await mkdir(path.join(repositoryPath, "nested"), { recursive: true });
    await writeFile(path.join(repositoryPath, "tracked.txt"), "feature\n");
    await writeFile(path.join(repositoryPath, "feature.txt"), "feature-only\n");
    await writeFile(
      path.join(repositoryPath, "nested", "only.txt"),
      "nested feature\n",
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "--all"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "feature comparison",
        ])
      ).exitCode,
      0,
    );
    const featureCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", "HEAD"])
    ).stdout
      .toString("utf8")
      .trim();
    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", "main"])).exitCode,
      0,
    );
    await mkdir(path.join(repositoryPath, "nested"), { recursive: true });
    await writeFile(path.join(repositoryPath, "main-only.txt"), "main-only\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "main-only.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "main comparison",
        ])
      ).exitCode,
      0,
    );
    const mainCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", "HEAD"])
    ).stdout
      .toString("utf8")
      .trim();
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "tag",
          "-a",
          "v-compare",
          "-m",
          "comparison tag",
          featureCommitId,
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-ref",
          "refs/remotes/origin/feature/compare",
          featureCommitId,
        ])
      ).exitCode,
      0,
    );
    await writeFile(
      path.join(repositoryPath, "working-tree-only.txt"),
      "not committed\n",
    );

    const service = new FileRootGitChangesService({
      /** 通常のChanges操作では一時リポジトリ全体を認可ルートとして返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** 同じリポジトリの全体と入れ子を、履歴に別々の認可ルートとして列挙する。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
        {
          rootId: "additional:nested",
          label: "Nested",
          displayPath: path.join(repositoryPath, "nested"),
          rootPath: path.join(repositoryPath, "nested"),
        },
      ],
      /** 比較・プレビューに指定されたルートを、入れ子かリポジトリ直下かで解決する。 */
      resolveHistoryRootContext: async (request) =>
        request.rootId === "additional:nested"
          ? { rootPath: path.join(repositoryPath, "nested") }
          : { rootPath: repositoryPath },
    });
    const repositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") {
      return;
    }
    const repository = repositories.repositories[0]!;
    assert.ok(
      repository.refs.some(
        (ref) => ref.kind === "remote" && ref.name === "origin/feature/compare",
      ),
    );
    assert.ok(
      repository.refs.some(
        (ref) => ref.kind === "tag" && ref.name === "v-compare",
      ),
    );

    const branchRequest = {
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: "workspace",
      base: { kind: "branch" as const, name: "main" },
      target: { kind: "branch" as const, name: "feature/compare" },
      mode: "branch" as const,
    };
    const branchResult = await service.getHistoryComparison(branchRequest);
    assert.equal(branchResult.status, "ok");
    if (branchResult.status !== "ok") {
      return;
    }
    assert.equal(branchResult.comparison.baseCommitId, mainCommitId);
    assert.equal(branchResult.comparison.targetCommitId, featureCommitId);
    assert.equal(branchResult.comparison.mergeBaseCommitId, baseCommitId);
    assert.deepEqual(
      new Set(branchResult.entries.map((entry) => entry.relativePath)),
      new Set(["tracked.txt", "feature.txt", "nested/only.txt"]),
    );
    assert.equal(
      branchResult.entries.some(
        (entry) => entry.relativePath === "main-only.txt",
      ),
      false,
    );
    assert.equal(
      branchResult.entries.some(
        (entry) => entry.relativePath === "working-tree-only.txt",
      ),
      false,
    );

    const directResult = await service.getHistoryComparison({
      ...branchRequest,
      mode: "direct",
      base: { kind: "commit", objectId: mainCommitId.slice(0, 12) },
      target: { kind: "remote", name: "origin/feature/compare" },
    });
    assert.equal(directResult.status, "ok");
    if (directResult.status !== "ok") {
      return;
    }
    assert.equal(directResult.comparison.baseCommitId, mainCommitId);
    assert.equal(directResult.comparison.targetCommitId, featureCommitId);
    assert.equal(directResult.comparison.mergeBaseCommitId, null);
    assert.equal(
      directResult.entries.some(
        (entry) => entry.relativePath === "main-only.txt",
      ),
      true,
    );

    const nestedRequest = {
      ...branchRequest,
      rootId: "additional:nested",
    };
    const nestedResult = await service.getHistoryComparison(nestedRequest);
    assert.equal(nestedResult.status, "ok");
    if (nestedResult.status !== "ok") {
      return;
    }
    assert.deepEqual(
      nestedResult.entries.map((entry) => entry.relativePath),
      ["only.txt"],
    );
    const nestedDiff = await service.getHistoryDiff({
      ...nestedRequest,
      comparison: nestedResult.comparison,
      relativePath: "only.txt",
    });
    assert.equal(nestedDiff.status, "ok");
    if (nestedDiff.status === "ok") {
      assert.match(nestedDiff.patch, /nested feature/);
      assert.ok("previewBeforeResource" in nestedDiff);
      assert.equal(nestedDiff.previewBeforeResource, null);
      assert.ok("previewAfterResource" in nestedDiff);
      assert.deepEqual(nestedDiff.previewAfterResource, {
        resourceKind: "git-commit-file",
        sessionId: "session-1",
        rootId: "additional:nested",
        repositoryId: repository.repositoryId,
        commitId: featureCommitId,
        relativePath: "only.txt",
      });
      const nestedDescriptor = await service.inspectHistoryFile(
        nestedDiff.previewAfterResource,
      );
      assert.equal(
        nestedDescriptor.absoluteFilePath,
        path.join(repositoryPath, "nested", "only.txt"),
      );
    }

    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-ref",
          "refs/heads/feature/compare",
          mainCommitId,
        ])
      ).exitCode,
      0,
    );
    const fixedDiff = await service.getHistoryDiff({
      ...branchRequest,
      comparison: branchResult.comparison,
      relativePath: "feature.txt",
    });
    assert.equal(fixedDiff.status, "ok");
    if (fixedDiff.status === "ok") {
      assert.match(fixedDiff.patch, /feature-only/);
      assert.ok("comparison" in fixedDiff);
      assert.equal(fixedDiff.comparison.targetCommitId, featureCommitId);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "FileRootGitChangesServiceは異なるrootPathから同じcanonical repositoryへ解決した複数root contextを一つのrepositoryへまとめ、commit detail、diff、binary preview metadataを返す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "canonical repositoryの重複排除、root commitの扱い、rename・binary・gitlinkの分類を誤り、preview可能性や取得bytesを誤って返す"
// observable = "history repositories、commit page、commit detail、diff result、preview resource、file descriptor、read chunk"
// observation_boundary = "public-boundary"
// scope = "FileRootGitChangesService history and preview"
// lifecycle = "permanent"
// distinction = "top-levelとnestedの異なるrootPathを持つ複数root contextから実Git repositoryを解決して一つへ統合し、binaryのmetadata-only admissionとrevision付きchunk読出しまで確認する"
// @end-test-value
/** 別ルートから同じリポジトリを一つにまとめ、履歴と差分、バイナリ記述子・読み出しを固定したコミット情報で返す。 */
test("FileRootGitChangesService はcanonical repository単位のhistory、root/parent diff、binary metadataを返す", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-"),
  );
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "tracked.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "changed",
        ])
      ).exitCode,
      0,
    );
    await runGitForTest(repositoryPath, ["mv", "tracked.txt", "renamed.txt"]);
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "rename",
        ])
      ).exitCode,
      0,
    );
    await writeFile(
      path.join(repositoryPath, "binary.bin"),
      Buffer.from([0, 1, 2, 3, 255]),
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "binary.bin"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "binary",
        ])
      ).exitCode,
      0,
    );
    await mkdir(path.join(repositoryPath, "nested"));

    const service = new FileRootGitChangesService({
      /** 現在のファイル変更用には一時リポジトリを返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** Workspaceと追加ルートの名前が違っても、同じリポジトリを指す一覧を用意する。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
        {
          rootId: "additional:repo",
          label: "repo",
          displayPath: path.join(repositoryPath, "nested"),
          rootPath: path.join(repositoryPath, "nested"),
        },
      ],
      /** 履歴の内容は重複するルート指定のどちらからも同じリポジトリに解決する。 */
      resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const repositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") {
      return;
    }
    assert.equal(repositories.repositories.length, 1);
    const repository = repositories.repositories[0]!;
    const page = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      branch: repository.currentBranch,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") {
      return;
    }
    assert.equal(page.page.entries[0]?.subject, "binary");
    const binaryCommit = page.page.entries[0]!;
    const binaryDetail = await service.getHistoryCommitDetail({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: binaryCommit.id,
    });
    assert.equal(binaryDetail.status, "ok");
    if (binaryDetail.status !== "ok") {
      return;
    }
    assert.deepEqual(binaryDetail.entries[0]?.kinds.commit, "added");
    const binaryDiff = await service.getHistoryDiff({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: binaryCommit.id,
      relativePath: "binary.bin",
    });
    assert.equal(binaryDiff.status, "ok");
    if (binaryDiff.status === "ok") {
      assert.match(binaryDiff.patch, /Binary files .* differ/);
      assert.doesNotMatch(binaryDiff.patch, /GIT binary patch/);
      assert.ok("previewResource" in binaryDiff);
      assert.deepEqual(binaryDiff.previewResource, {
        resourceKind: "git-commit-file",
        sessionId: "session-1",
        repositoryId: repository.repositoryId,
        rootId: repository.rootId,
        commitId: binaryCommit.id,
        relativePath: "binary.bin",
      });
      let blobReadAttempts = 0;
      let allowBlobInspection = false;
      const metadataOnlyService = new FileRootGitChangesService({
        /** プレビュー境界の照合用に、Changes側も同じリポジトリを参照させる。 */
        resolveRootContext: async () => ({ rootPath: repositoryPath }),
        /** プレビュー対象のコミットとパスを、履歴を作ったリポジトリで解決する。 */
        resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
        /** プレビュー受付の段階ではblob本文を読ませず、実ファイル確認に進んだ際の取得上限を照合する。 */
        runGit: async (workspacePath, args, options) => {
          if (
            args.some(
              (arg, index) => arg === "cat-file" && args[index + 1] === "blob",
            )
          ) {
            blobReadAttempts += 1;
            if (!allowBlobInspection) {
              throw new Error(
                "Blob contents must not be read during preview Window admission.",
              );
            }
            assert.equal(options.captureStdoutBytes, 8 * 1024);
          }
          return runGitForTest(workspacePath, args, {
            env: options.env,
            executablePath: options.executablePath,
            stdin: options.stdin,
            signal: options.signal,
          });
        },
      });
      assert.deepEqual(
        await metadataOnlyService.resolveHistoryFilePreview(
          binaryDiff.previewResource,
        ),
        {
          name: "binary.bin",
          absoluteFilePath: path.join(repositoryPath, "binary.bin"),
        },
      );
      assert.equal(blobReadAttempts, 0);
      await writeFile(
        path.join(repositoryPath, "binary.bin"),
        Buffer.from([9, 9, 9]),
      );
      allowBlobInspection = true;
      const descriptor = await metadataOnlyService.inspectHistoryFile(
        binaryDiff.previewResource,
      );
      assert.equal(
        descriptor.absoluteFilePath,
        path.join(repositoryPath, "binary.bin"),
      );
      assert.equal(blobReadAttempts, 1);
      assert.equal(descriptor.revision.length, binaryCommit.id.length);
      assert.equal(descriptor.kind, "binary");
      assert.equal(descriptor.byteLength, 5);
      const chunk = await service.readHistoryFileChunk({
        ...binaryDiff.previewResource,
        offset: 0,
        length: descriptor.byteLength,
        expectedRevision: descriptor.revision,
      });
      assert.deepEqual([...new Uint8Array(chunk.data)], [0, 1, 2, 3, 255]);
    }

    await unlink(path.join(repositoryPath, "binary.bin"));
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "--all", "binary.bin"]))
        .exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "delete binary",
        ])
      ).exitCode,
      0,
    );
    const deletedCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", "HEAD"])
    ).stdout
      .toString("utf8")
      .trim();
    const deletedDiff = await service.getHistoryDiff({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: deletedCommitId,
      relativePath: "binary.bin",
    });
    assert.equal(deletedDiff.status, "ok");
    if (deletedDiff.status === "ok") {
      assert.ok("previewResource" in deletedDiff);
      assert.equal(deletedDiff.previewResource, null);
    }
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${binaryCommit.id},vendor/example`,
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "add gitlink",
        ])
      ).exitCode,
      0,
    );
    const gitlinkCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", "HEAD"])
    ).stdout
      .toString("utf8")
      .trim();
    const gitlinkDiff = await service.getHistoryDiff({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: gitlinkCommitId,
      relativePath: "vendor/example",
    });
    assert.equal(gitlinkDiff.status, "ok");
    if (gitlinkDiff.status === "ok") {
      assert.ok("previewResource" in gitlinkDiff);
      assert.equal(gitlinkDiff.previewResource, null);
    }

    const renameCommit = page.page.entries.find(
      (entry) => entry.subject === "rename",
    );
    assert.ok(renameCommit);
    const renameDetail = await service.getHistoryCommitDetail({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: renameCommit.id,
    });
    assert.equal(renameDetail.status, "ok");
    if (renameDetail.status === "ok") {
      assert.equal(renameDetail.entries[0]?.kinds.commit, "renamed");
      assert.equal(
        renameDetail.entries[0]?.previousRelativePath,
        "tracked.txt",
      );
    }

    const rootCommitId = (
      await runGitForTest(repositoryPath, [
        "rev-list",
        "--max-parents=0",
        "HEAD",
      ])
    ).stdout
      .toString("utf8")
      .trim();
    const rootDetail = await service.getHistoryCommitDetail({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: rootCommitId,
    });
    assert.equal(rootDetail.status, "ok");
    if (rootDetail.status === "ok") {
      assert.deepEqual(
        rootDetail.entries.map((entry) => entry.relativePath),
        ["tracked.txt"],
      );
    }
    const invalidCommit = await service.getHistoryCommitDetail({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: "not-a-commit",
    });
    assert.equal(invalidCommit.status, "failed");
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Git履歴のrepository情報は対象rootのcurrent branchとlocal branch一覧を返し、remote-tracking branchを含めず、選択branchの到達履歴だけを返す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "commit一覧が全local branchの履歴を混ぜる、同名tagでbranch名が変化する、remote-tracking branchをlocal branchとして公開する、またはdetached HEAD・branch削除・未commit repositoryを暗黙に別状態として表示する"
// observable = "listHistoryRepositoriesとlistHistoryCommitsのpublic result"
// observation_boundary = "public-boundary"
// scope = "FileRootGitChangesService.listHistoryRepositories/listHistoryCommits"
// lifecycle = "permanent"
// impact = "History利用者が選択したbranch以外のcommitを誤って参照せず、現在のroot状態を判断できる"
// distinction = "parserやgit commandの引数静的検査ではなく、実Gitで分岐履歴、remote-tracking refの除外、対象rootのcurrent branch、detached HEAD、削除branch、空repositoryのresultを確認する"
// @end-test-value
/** 現在ブランチとローカルブランチだけを返し、選択したブランチからたどれる履歴に限定する。 */
test("FileRootGitChangesService は対象rootのbranch状態と選択branchの到達履歴を返す", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-branch-"),
  );
  const emptyRepositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-empty-branch-"),
  );
  try {
    await initializeRepository(repositoryPath);
    const mainBranch = (
      await runGitForTest(repositoryPath, ["branch", "--show-current"])
    ).stdout
      .toString("utf8")
      .trim();
    assert.ok(mainBranch);
    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", "-b", "history-side"]))
        .exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "side.txt"), "side\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "side.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "side-only",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", mainBranch])).exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "main.txt"), "main\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "main.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "main-only",
        ])
      ).exitCode,
      0,
    );
    const mainCommitId = (
      await runGitForTest(repositoryPath, ["rev-parse", mainBranch])
    ).stdout
      .toString("utf8")
      .trim();
    assert.equal(
      (await runGitForTest(repositoryPath, ["tag", mainBranch])).exitCode,
      0,
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["tag", "history-side"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-ref",
          "refs/remotes/origin/remote-only",
          mainCommitId,
        ])
      ).exitCode,
      0,
    );

    const service = new FileRootGitChangesService({
      /** ブランチ切替でパス自体は変更せず、同じ作業ツリーを返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** ブランチ一覧を取得する対象をWorkspaceの1件にする。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
      ],
      /** 通常・detachedのどちらの履歴要求も同じリポジトリに向ける。 */
      resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const repositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") {
      return;
    }
    const repository = repositories.repositories[0];
    assert.ok(repository);
    assert.equal(repository.currentBranch, mainBranch);
    assert.deepEqual(
      [...repository.branches].sort(),
      [mainBranch, "history-side"].sort(),
    );

    const mainPage = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      branch: mainBranch,
    });
    const sidePage = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      branch: "history-side",
    });
    assert.equal(mainPage.status, "ok");
    assert.equal(sidePage.status, "ok");
    if (mainPage.status !== "ok" || sidePage.status !== "ok") {
      return;
    }
    const mainSubjects = mainPage.page.entries.map((entry) => entry.subject);
    const sideSubjects = sidePage.page.entries.map((entry) => entry.subject);
    assert.ok(mainSubjects.includes("main-only"));
    assert.ok(!mainSubjects.includes("side-only"));
    assert.ok(sideSubjects.includes("side-only"));
    assert.ok(!sideSubjects.includes("main-only"));

    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", "--detach", "HEAD"]))
        .exitCode,
      0,
    );
    const detachedRepositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(detachedRepositories.status, "ok");
    if (detachedRepositories.status !== "ok") {
      return;
    }
    const detachedRepository = detachedRepositories.repositories[0];
    assert.ok(detachedRepository);
    assert.equal(detachedRepository.currentBranch, null);
    const detachedPage = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: detachedRepository.repositoryId,
      rootId: detachedRepository.rootId,
      branch: null,
    });
    assert.deepEqual(detachedPage, {
      status: "detached-head",
      message: "Git HEAD is detached. Select a branch to view its history.",
    });

    assert.equal(
      (await runGitForTest(repositoryPath, ["branch", "-D", "history-side"]))
        .exitCode,
      0,
    );
    const deletedBranchPage = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: detachedRepository.repositoryId,
      rootId: detachedRepository.rootId,
      branch: "history-side",
    });
    assert.deepEqual(deletedBranchPage, {
      status: "branch-not-found",
      message: "The selected Git branch is no longer available.",
    });

    await runGitForTest(emptyRepositoryPath, ["init", "--quiet"]);
    const emptyService = new FileRootGitChangesService({
      /** 作業ツリーの登録先を初回コミット前のリポジトリに切り替える。 */
      resolveRootContext: async () => ({ rootPath: emptyRepositoryPath }),
      /** ブランチ名がまだ確定していないリポジトリだけを発見対象にする。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: emptyRepositoryPath,
          rootPath: emptyRepositoryPath,
        },
      ],
      /** コミット一覧も初回コミット前のルートで解決する。 */
      resolveHistoryRootContext: async () => ({
        rootPath: emptyRepositoryPath,
      }),
    });
    const emptyRepositories = await emptyService.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(emptyRepositories.status, "ok");
    if (emptyRepositories.status !== "ok") {
      return;
    }
    const emptyRepository = emptyRepositories.repositories[0];
    assert.ok(emptyRepository);
    assert.deepEqual(emptyRepository.branches, []);
    assert.equal(emptyRepository.currentBranch, null);
    const emptyPage = await emptyService.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: emptyRepository.repositoryId,
      rootId: emptyRepository.rootId,
      branch: null,
    });
    assert.deepEqual(emptyPage, {
      status: "empty-repository",
      message: "The Git repository has no committed branches.",
    });
  } finally {
    await rm(emptyRepositoryPath, { recursive: true, force: true });
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "regression"
// claim = "History diffはGitの改行設定がsystem/global由来でも、commit間で実際に変更された行だけを追加・削除として返す"
// oracle = { type = "contract", ref = "User requirement: History diff reflects only committed content changes" }
// failure_mode = "Git設定の隔離でcore.autocrlfが欠落し、1行だけ変更したtext fileを全行変更として表示する"
// scope = "FileRootGitChangesService.getHistoryDiff"
// lifecycle = "permanent"
// distinction = "binary・renameのHistory検証ではなく、隔離前のglobal改行設定とtext patchの行単位結果を実Gitで検証する"
// @end-test-value
/** 独立のglobal設定で改行変換が有効な場合も、履歴差分を改行すべての変更にせず実変更行だけに絞る。 */
test("FileRootGitChangesService はglobal改行設定を維持してHistoryの実変更行だけを返す", async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-eol-"),
  );
  const primaryRepositoryPath = path.join(tempRoot, "primary");
  const repositoryPath = path.join(tempRoot, "worktree");
  const homePath = path.join(tempRoot, "home");
  const gitEnv = {
    ...process.env,
    HOME: homePath,
    USERPROFILE: homePath,
  };
  const gitCalls: string[][] = [];
  /** 同じテスト用global設定で、元リポジトリにコミットを作るGit操作を実行する。 */
  const runPrimaryGit = (args: string[]) =>
    runGitForTest(primaryRepositoryPath, args, { env: gitEnv });
  /** 別の作業ツリーで、元リポジトリと同じ改行設定を用いてGit操作を行う。 */
  const runGit = (args: string[]) =>
    runGitForTest(repositoryPath, args, { env: gitEnv });
  try {
    await mkdir(primaryRepositoryPath);
    await mkdir(homePath);
    await writeFile(
      path.join(homePath, ".gitconfig"),
      "[core]\n\tautocrlf = true\n",
    );
    assert.equal((await runPrimaryGit(["init", "--quiet"])).exitCode, 0);
    const beforeLines = Array.from({ length: 12 }, (_, index) =>
      index === 6 ? "before" : `unchanged-${index + 1}`,
    );
    await writeFile(
      path.join(primaryRepositoryPath, "tracked.txt"),
      `${beforeLines.join("\r\n")}\r\n`,
    );
    assert.equal((await runPrimaryGit(["add", "tracked.txt"])).exitCode, 0);
    assert.equal(
      (
        await runPrimaryGit([
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "before",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runPrimaryGit([
          "worktree",
          "add",
          "--quiet",
          "-b",
          "history-eol",
          repositoryPath,
        ])
      ).exitCode,
      0,
    );
    const afterLines = [...beforeLines];
    afterLines[6] = "after";
    const mixedEolContent = afterLines
      .map((line, index) => `${line}${index === 6 ? "\n" : "\r\n"}`)
      .join("");
    await writeFile(path.join(repositoryPath, "tracked.txt"), mixedEolContent);
    assert.equal((await runGit(["add", "tracked.txt"])).exitCode, 0);
    assert.equal(
      (
        await runGit([
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "after",
        ])
      ).exitCode,
      0,
    );
    const commitId = (await runGit(["rev-parse", "HEAD"])).stdout
      .toString("utf8")
      .trim();

    const service = new FileRootGitChangesService({
      /** 差分のルートに、検証用の改行設定を使う作業ツリーを指定する。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** 比較したい履歴を持つWorkspaceだけを候補として列挙する。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
      ],
      /** History要求を改行設定付きで準備したリポジトリに戻す。 */
      resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
      processEnv: gitEnv,
      /** 履歴差分へ渡ったGit引数を記録し、指定された環境と標準入力で実コマンドに渡す。 */
      runGit: async (workspacePath, args, options) => {
        gitCalls.push(args);
        return runGitForTest(workspacePath, args, {
          env: options.env,
          executablePath: options.executablePath,
          stdin: options.stdin,
          signal: options.signal,
        });
      },
    });
    const repositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok", JSON.stringify(repositories));
    if (repositories.status !== "ok") {
      return;
    }
    const repository = repositories.repositories[0]!;
    const result = await service.getHistoryDiff({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId,
      relativePath: "tracked.txt",
    });

    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status === "ok") {
      const diffArgs = gitCalls.find(
        (args) => args.includes("diff-tree") && args.includes("--patch"),
      );
      assert.ok(diffArgs);
      assert.ok(diffArgs.includes("core.autocrlf=true"));
      const patchLines = result.patch.split(/\r\n|\n|\r/);
      assert.deepEqual(
        patchLines.filter(
          (line) => line.startsWith("-") && !line.startsWith("---"),
        ),
        ["-before"],
      );
      assert.deepEqual(
        patchLines.filter(
          (line) => line.startsWith("+") && !line.startsWith("+++"),
        ),
        ["+after"],
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "merge commitのdetailとdiffはfirst parentから追加された変更を返す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "merge commit detailまたはfile diffがsecond parentまたはmerge前後の全差分として扱われ、first parentにない変更以外の内容を返す"
// observable = "merge commit detailのentries relativePathとhistory diffのpatch"
// observation_boundary = "public-boundary"
// scope = "FileRootGitChangesService.getHistoryCommitDetail/getHistoryDiff"
// lifecycle = "permanent"
// distinction = "2親のmerge commitを作成し、通常commitとは異なるfirst parent基準のdetailとrelativePath指定diffを確認する"
// @end-test-value
/** マージコミットの変更一覧とパッチは、第二親でなく第一親に対する追加内容を返す。 */
test("FileRootGitChangesService はmerge commitをfirst parentと比較する", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-merge-"),
  );
  try {
    await initializeRepository(repositoryPath);
    const mainBranch = (
      await runGitForTest(repositoryPath, ["branch", "--show-current"])
    ).stdout
      .toString("utf8")
      .trim();
    assert.ok(mainBranch);
    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", "-b", "history-side"]))
        .exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "side.txt"), "side\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "side.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "side",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["checkout", mainBranch])).exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "main.txt"), "main\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "main.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "main",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "merge",
          "--no-ff",
          "--quiet",
          "-m",
          "merge side",
          "history-side",
        ])
      ).exitCode,
      0,
    );

    const service = new FileRootGitChangesService({
      /** マージ済みコミットがある実リポジトリを通常の解決先にする。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** マージ履歴を発見する対象を、そのリポジトリのWorkspaceだけにする。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
      ],
      /** コミット詳細とパッチを、マージを実行したリポジトリに解決する。 */
      resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const repositories = await service.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") {
      return;
    }
    const repository = repositories.repositories[0];
    assert.ok(repository);
    const page = await service.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      branch: repository.currentBranch,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") {
      return;
    }
    const mergeCommit = page.page.entries.find(
      (entry) => entry.subject === "merge side",
    );
    assert.ok(mergeCommit);
    const detail = await service.getHistoryCommitDetail({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: mergeCommit.id,
    });
    assert.equal(detail.status, "ok");
    if (detail.status === "ok") {
      assert.deepEqual(
        detail.entries.map((entry) => entry.relativePath),
        ["side.txt"],
      );
      const diff = await service.getHistoryDiff({
        sessionId: "session-1",
        repositoryId: repository.repositoryId,
        rootId: repository.rootId,
        commitId: mergeCommit.id,
        relativePath: "side.txt",
      });
      assert.equal(diff.status, "ok", JSON.stringify(diff));
      if (diff.status === "ok") {
        assert.equal(diff.relativePath, "side.txt");
        assert.match(diff.patch, /\+side/);
      }
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Git history discoveryとcommit listはnon-Git・missing rootと、serviceが受け取ったhistory stdoutの上限超過を明示したresultへ投影する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "non-Gitまたはmissing rootをrepositoryとして公開する、またはserviceが受け取った上限超過のhistory outputを成功扱いする"
// observable = "listHistoryRepositoriesとlistHistoryCommitsのresult statusとmessage"
// observation_boundary = "public-boundary"
// scope = "FileRootGitChangesService history discovery and pagination"
// lifecycle = "permanent"
// distinction = "repositoryが存在しない場合の空集合と、runGit resultとして渡された履歴出力の上限超過を別々に確認する"
// @end-test-value
/** Gitでないルートや消失したルートは履歴候補に入れず、履歴出力の上限超過は明示的な失敗にする。 */
test("FileRootGitChangesService は空のrepository集合とhistory stdout上限を結果へ投影する", async () => {
  const nonGitPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-history-empty-"),
  );
  const missingPath = path.join(nonGitPath, "missing");
  try {
    const emptyService = new FileRootGitChangesService({
      /** 個別のChangesルートは解決せず、履歴のルート列挙を独立に検証する。 */
      resolveRootContext: async () => null,
      /** Gitでないディレクトリーと存在しないディレクトリーを候補に混ぜる。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: nonGitPath,
          rootPath: nonGitPath,
        },
        {
          rootId: "missing",
          label: "Missing",
          displayPath: missingPath,
          rootPath: missingPath,
        },
      ],
    });
    assert.deepEqual(
      await emptyService.listHistoryRepositories({ sessionId: "session-1" }),
      {
        status: "ok",
        repositories: [],
      },
    );

    const repositoryPath = path.join(nonGitPath, "repository");
    await initializeRepository(repositoryPath);
    const largeOutput = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const limitedService = new FileRootGitChangesService({
      /** 上限のケースでは、発見に成功する実リポジトリを用意する。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** 履歴候補を見つけられるよう、初期化したリポジトリを一つ返す。 */
      resolveHistoryRootContexts: async () => [
        {
          rootId: "workspace",
          label: "Workspace",
          displayPath: repositoryPath,
          rootPath: repositoryPath,
        },
      ],
      /** ログ読込を、発見済みの実リポジトリへ向ける。 */
      resolveHistoryRootContext: async () => ({ rootPath: repositoryPath }),
      /** 発見のコマンドには実Gitを使い、履歴ログだけ上限を超える合成出力を返す。 */
      runGit: async (workspacePath, args, options) => {
        if (args.includes("log")) {
          return { exitCode: 0, stdout: largeOutput, stderr: "" };
        }
        return runGitForTest(workspacePath, args, {
          env: options.env,
          executablePath: options.executablePath,
          stdin: options.stdin,
          signal: options.signal,
        });
      },
    });
    const repositories = await limitedService.listHistoryRepositories({
      sessionId: "session-1",
    });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") {
      return;
    }
    const repository = repositories.repositories[0];
    assert.ok(repository);
    const page = await limitedService.listHistoryCommits({
      sessionId: "session-1",
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      branch: repository.currentBranch,
    });
    assert.equal(page.status, "failed");
    if (page.status === "failed") {
      assert.match(page.message, /stdout.*resource limit/i);
    }
  } finally {
    await rm(nonGitPath, { recursive: true, force: true });
  }
});

/** 親のGit環境を透過継承せず、許可された設定を隔離status・diffに反映し、ルート外のパスも拒否する。 */
test("FileRootGitChangesService は隔離した status / diff と非継承 Git 環境を使う", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-changes-"),
  );
  const workspacePath = path.join(repositoryPath, "src");
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    const canonicalRepositoryPath = await realpath(repositoryPath);
    await writeFile(path.join(workspacePath, "a.ts"), "old\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "src/a.ts"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "nested",
        ])
      ).exitCode,
      0,
    );
    await writeFile(path.join(workspacePath, "a.ts"), "new\n");
    await writeFile(path.join(workspacePath, "new.ts"), "untracked\n");

    const service = new FileRootGitChangesService({
      /** リポジトリ内の実WorkspaceをChangesとパッチの認可範囲にする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      processEnv: {
        ...process.env,
        GIT_DIR: "redirected-dir",
        git_work_tree: "redirected-worktree",
        GIT_TRACE: path.join(repositoryPath, "trace.txt"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "external-command",
      },
      /** Gitの引数と環境を記録し、設定読込では反映可否が異なる設定を含む応答を返す。 */
      runGit: async (workingDirectoryPath, args, options) => {
        calls.push({ args, env: options.env });
        if (args.includes("--get-regexp")) {
          return {
            exitCode: 0,
            stdout: Buffer.from(
              "core.autocrlf\ntrue\0core.filemode\0core.symlinks\n\0core.ignorecase\n2\0" +
                "core.precomposeunicode\n0x1\0filter.untrusted.clean\nexternal-command\0",
              "utf8",
            ),
            stderr: "",
          };
        }
        const accessesOriginalRepository =
          args.includes("--show-toplevel") ||
          args.some(
            (arg) =>
              arg === `--git-dir=${path.join(canonicalRepositoryPath, ".git")}`,
          );
        const safeDirectoryArg = `safe.directory=${
          process.platform === "win32"
            ? canonicalRepositoryPath.replace(/\\/g, "/")
            : canonicalRepositoryPath
        }`;
        if (accessesOriginalRepository && !args.includes(safeDirectoryArg)) {
          return {
            exitCode: 128,
            stdout: Buffer.alloc(0),
            stderr: `fatal: detected dubious ownership in repository at '${repositoryPath}'`,
          };
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });

    const changes = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.ok(changes.entries.some((entry) => entry.relativePath === "a.ts"));
      assert.ok(
        changes.entries.some((entry) => entry.relativePath === "new.ts"),
      );
    }
    const diff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "a.ts",
      scope: "working-tree",
    });
    assert.equal(diff.status, "ok");
    if (diff.status === "ok") {
      assert.match(diff.patch, /-old/);
      assert.match(diff.patch, /\+new/);
    }
    for (const { args, env } of calls) {
      assert.deepEqual(
        args.slice(0, EXPECTED_GIT_GLOBAL_ARGS.length),
        EXPECTED_GIT_GLOBAL_ARGS,
      );
      assert.equal(env.GIT_TRACE, undefined);
      assert.equal(env.GIT_DIR, undefined);
      assert.equal(env.git_work_tree, undefined);
      assert.equal(env.GIT_CONFIG_COUNT, undefined);
    }
    const identityArgs = calls.find(({ args }) =>
      args.includes("--show-toplevel"),
    )?.args;
    assert.ok(identityArgs);
    assert.ok(
      identityArgs.includes(
        `safe.directory=${
          process.platform === "win32"
            ? canonicalRepositoryPath.replace(/\\/g, "/")
            : canonicalRepositoryPath
        }`,
      ),
    );
    const configReadCall = calls.find(({ args }) =>
      args.includes("--get-regexp"),
    );
    assert.ok(configReadCall);
    assert.equal(configReadCall.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(configReadCall.env.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(configReadCall.env.GIT_CONFIG_NOSYSTEM, undefined);
    const statusArgs = calls.find(({ args }) => args.includes("status"))?.args;
    assert.ok(statusArgs);
    assert.ok(statusArgs.includes("core.autocrlf=true"));
    assert.ok(statusArgs.includes("core.filemode=true"));
    assert.ok(statusArgs.includes("core.symlinks=false"));
    assert.ok(statusArgs.includes("core.ignorecase=true"));
    assert.ok(statusArgs.includes("core.precomposeunicode=true"));
    assert.ok(statusArgs.includes("--ignore-submodules=dirty"));
    assert.equal(
      statusArgs.some((arg) => arg.includes("filter.untrusted")),
      false,
    );
    const diffArgs = [...calls]
      .reverse()
      .find(({ args }) => args.includes("diff"))?.args;
    assert.ok(diffArgs);
    assert.ok(
      diffArgs.some(
        (arg) =>
          arg.startsWith("--git-dir=") && !arg.endsWith(`${path.sep}.git`),
      ),
    );
    assert.deepEqual(diffArgs.slice(diffArgs.indexOf("diff")), [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      "--ignore-submodules=dirty",
      "--",
      ":(top,literal)src/a.ts",
    ]);
    await assert.rejects(() => access(path.join(repositoryPath, "trace.txt")));
    await assert.rejects(
      () =>
        service.getFileDiff({
          sessionId: "session-1",
          rootId: "workspace",
          relativePath: "../escape",
          scope: "working-tree",
        }),
      /invalid segment/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** globalの除外ファイルは隔離statusに反映する一方、同じ設定源の外部フィルターは実行しない。 */
test("FileRootGitChangesService は global core.excludesFile を隔離 status に限定して反映する", async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-global-ignore-"),
  );
  const repositoryPath = path.join(tempRoot, "repository");
  const homePath = path.join(tempRoot, "home");
  const globalIgnorePath = path.join(homePath, "global-ignore");
  const filterScriptPath = path.join(tempRoot, "global-filter.cjs");
  const filterMarkerPath = path.join(tempRoot, "global-filter-ran.txt");
  try {
    await initializeRepository(repositoryPath);
    await mkdir(homePath);
    await writeFile(
      path.join(repositoryPath, ".gitattributes"),
      "visible.txt filter=marker\n",
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", ".gitattributes"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "attributes",
        ])
      ).exitCode,
      0,
    );
    await writeFile(
      filterScriptPath,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n",
    );
    const filterCommand = `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}" "${filterMarkerPath.replaceAll("\\", "/")}"`;
    await writeFile(globalIgnorePath, "global-only.txt\n");
    await writeFile(
      path.join(homePath, ".gitconfig"),
      `[core]\n\texcludesFile = ${globalIgnorePath.replaceAll("\\", "/")}\n[filter "marker"]\n\tclean = ${filterCommand}\n`,
    );
    await writeFile(path.join(repositoryPath, "global-only.txt"), "ignored\n");
    await writeFile(path.join(repositoryPath, "visible.txt"), "visible\n");

    const service = new FileRootGitChangesService({
      /** 独立したグローバル設定でstatusを確認する一時リポジトリを返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      processEnv: {
        ...process.env,
        HOME: homePath,
        USERPROFILE: homePath,
      },
    });

    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });

    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status === "ok") {
      assert.equal(
        result.entries.some(
          (entry) => entry.relativePath === "global-only.txt",
        ),
        false,
      );
      assert.equal(
        result.entries.some((entry) => entry.relativePath === "visible.txt"),
        true,
      );
    }
    assert.deepEqual(
      await service.getFileDiff({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "global-only.txt",
        scope: "working-tree",
      }),
      {
        status: "not-changed",
        message: "The selected file is not changed in this scope.",
      },
    );
    await assert.rejects(() => access(filterMarkerPath));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Gitが認める数値基数や単位付きのboolean表記を受け入れ、表現範囲を超えた値だけを失敗にする。 */
test("FileRootGitChangesService は Git boolean の有効な基数・単位表記を保持し範囲外値を拒否する", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-config-bool-"),
  );
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");
    const configValues = [
      "1k",
      "0x1",
      `${"0".repeat(128)}1`,
      process.platform === "win32" ? "2147483648" : "9223372036854775808",
    ];
    const results: FileRootChangesResult[] = [];
    for (const configValue of configValues) {
      const service = new FileRootGitChangesService({
        /** どのboolean表記も同じ一時リポジトリで比較する。 */
        resolveRootContext: async () => ({ rootPath: repositoryPath }),
        /** 設定取得だけを所定のboolean値へ差し替え、他のコマンドは実Gitへ渡す。 */
        runGit: async (workingDirectoryPath, args, options) => {
          if (args.includes("--get-regexp")) {
            return {
              exitCode: 0,
              stdout: Buffer.from(`core.ignorecase\n${configValue}\0`, "utf8"),
              stderr: "",
            };
          }
          return runGitForTest(workingDirectoryPath, args, options);
        },
      });
      results.push(
        await service.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        }),
      );
    }

    assert.equal(results[0]?.status, "ok", JSON.stringify(results[0]));
    assert.equal(results[1]?.status, "ok", JSON.stringify(results[1]));
    assert.equal(results[2]?.status, "ok", JSON.stringify(results[2]));
    assert.deepEqual(results[3], {
      status: "failed",
      message: "Git work tree config core.ignorecase has an unsupported value.",
    });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** WorkspaceにGitと同名のファイルが存在しても、実行候補とせず起動の痕跡を残さない。 */
test("FileRootGitChangesService は Workspace 内の git command を起動候補にしない", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-decoy-"),
  );
  const markerPath = path.join(repositoryPath, "decoy-ran.txt");
  try {
    await initializeRepository(repositoryPath);
    await writeFile(
      path.join(repositoryPath, "git.cmd"),
      `@echo off\r\necho ran>"${markerPath}"\r\nexit /b 17\r\n`,
    );
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");
    const service = new FileRootGitChangesService({
      /** 同名ファイルを持つ一時リポジトリをChangesの対象にする。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });

    assert.equal(
      (
        await service.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        })
      ).status,
      "ok",
    );
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 実行ファイルの解決エラーを構築直後に発生させず、最初の変更照会で失敗結果として返す。 */
test("FileRootGitChangesService は Git executable resolver を最初のoperationまで起動しない", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-lazy-resolver-"),
  );
  const unhandledReasons: unknown[] = [];
  /** 最初の照会前後に未処理Promise拒否があったかを記録する。 */
  const handleUnhandledRejection = (reason: unknown) =>
    unhandledReasons.push(reason);
  process.on("unhandledRejection", handleUnhandledRejection);
  try {
    const service = new FileRootGitChangesService({
      /** 遅延解決を発火させる変更照会へ、一時Workspaceを対応させる。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** 最初に実行ファイルを要求した場合だけ、合成した解決失敗を投げる。 */
      resolveGitExecutablePath: async () => {
        throw new Error("resolver initialization failed");
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledReasons, []);

    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.deepEqual(result, {
      status: "failed",
      message: "resolver initialization failed",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledReasons, []);
  } finally {
    process.off("unhandledRejection", handleUnhandledRejection);
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** 親環境が日本語でもGitにCロケールを指定し、非リポジトリの既知エラーをnot-gitへ分類する。 */
test("FileRootGitChangesService はGit localeを固定して non-Git rootを分類する", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-localized-not-repo-"),
  );
  try {
    const service = new FileRootGitChangesService({
      /** Git実行時の環境を確認するため、Changes解決から一時Workspaceを得られるようにする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      processEnv: {
        ...process.env,
        LANG: "ja_JP.UTF-8",
        LC_ALL: "ja_JP.UTF-8",
      },
      /** 起動環境がCに固定されたことを検査してから非リポジトリのGitエラーを返す。 */
      runGit: async (_workingDirectoryPath, _args, options) => {
        assert.equal(options.env.LANG, "C");
        assert.equal(options.env.LC_ALL, "C");
        return {
          exitCode: 128,
          stdout: Buffer.alloc(0),
          stderr:
            "fatal: not a git repository (or any of the parent directories): .git",
        };
      },
    });
    assert.deepEqual(
      await service.listChanges({
        sessionId: "session-1",
        rootId: "workspace",
      }),
      {
        status: "not-git",
        message: "File root is not a Git repository.",
      },
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** 実Gitでリポジトリでない一時ディレクトリーを調べ、汎用失敗とせずnot-gitを返す。 */
test("FileRootGitChangesService は実際のnon-Git directoryをnot-gitで返す", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-not-repo-"),
  );
  try {
    const service = new FileRootGitChangesService({
      /** 初期化していない実ディレクトリーを、そのまま解決先にする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
    });
    assert.deepEqual(
      await service.listChanges({
        sessionId: "session-1",
        rootId: "workspace",
      }),
      {
        status: "not-git",
        message: "File root is not a Git repository.",
      },
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "contract"
// claim = "Changes用repository discoveryは認可rootごとのGit判定だけを返し、status取得を実行しない"
// oracle = { type = "contract", ref = "accepted behavior: repository frames before manual Changes refresh" }
// failure_mode = "repository枠の準備でnon-Git rootを含める、または明示Refresh前にGit statusを実行する"
// scope = "FileRootGitChangesService repository discovery"
// lifecycle = "permanent"
// @end-test-value
/** 認可済みルートのうちGitリポジトリだけを抽出し、発見のためにstatusを実行しない。 */
test("FileRootGitChangesService はChanges取得なしでGit repository rootを抽出する", async () => {
  const parentPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-root-discovery-"),
  );
  const repositoryPath = path.join(parentPath, "repository");
  const nonGitPath = path.join(parentPath, "non-git");
  const commands: string[][] = [];
  try {
    await initializeRepository(repositoryPath);
    await mkdir(nonGitPath);
    const roots = new Map([
      ["repository", repositoryPath],
      ["non-git", nonGitPath],
    ]);
    const service = new FileRootGitChangesService({
      /** テストの認可表から対象IDのディレクトリーだけを返し、不明なIDは解決しない。 */
      resolveRootContext: async ({ rootId }) => {
        const rootPath = roots.get(rootId);
        return rootPath ? { rootPath } : null;
      },
      /** 発見時のGit引数を記録しつつ、判定そのものは実Gitで行う。 */
      runGit: async (workspacePath, args, options) => {
        commands.push(args);
        return runGitForTest(workspacePath, args, options);
      },
    });

    assert.deepEqual(
      await service.listChangesRepositories({
        sessionId: "session-1",
        rootIds: ["repository", "non-git", "missing"],
      }),
      {
        status: "ok",
        repositories: [{ rootId: "repository" }],
        failures: [],
      },
    );
    assert.equal(
      commands.some((args) => args.includes("status")),
      false,
    );
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

/** 同じSessionでもrootIdごとに作業ツリーを識別し、他のルートの変更やパッチを混ぜない。 */
test("FileRootGitChangesService は同じSessionのrootIdごとに認可済みdirectoryとdiffを分離する", async () => {
  const parentPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-file-roots-"),
  );
  const workspacePath = path.join(parentPath, "workspace");
  const additionalPath = path.join(parentPath, "additional");
  try {
    await initializeRepository(workspacePath);
    await initializeRepository(additionalPath);
    for (const rootPath of [workspacePath, additionalPath]) {
      await writeFile(path.join(rootPath, "shared.txt"), "base\n");
      assert.equal(
        (await runGitForTest(rootPath, ["add", "shared.txt"])).exitCode,
        0,
      );
      assert.equal(
        (
          await runGitForTest(rootPath, [
            "-c",
            "user.name=WithMate Test",
            "-c",
            "user.email=withmate@example.invalid",
            "commit",
            "-m",
            "base",
          ])
        ).exitCode,
        0,
      );
    }
    await writeFile(path.join(workspacePath, "shared.txt"), "workspace\n");
    await writeFile(path.join(additionalPath, "shared.txt"), "additional\n");

    const resolvedRootIds: string[] = [];
    const service = new FileRootGitChangesService({
      /** 要求されたIDを記録し、Workspaceと追加ディレクトリーを別の作業ツリーに解決する。 */
      resolveRootContext: async (request) => {
        resolvedRootIds.push(request.rootId);
        return request.rootId === "workspace"
          ? { rootPath: workspacePath }
          : request.rootId === "additional:shared"
            ? { rootPath: additionalPath }
            : null;
      },
    });

    const workspaceChanges = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    const additionalChanges = await service.listChanges({
      sessionId: "session-1",
      rootId: "additional:shared",
    });
    assert.equal(workspaceChanges.status, "ok");
    assert.equal(additionalChanges.status, "ok");
    const workspaceDiff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "shared.txt",
      scope: "working-tree",
    });
    const additionalDiff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "additional:shared",
      relativePath: "shared.txt",
      scope: "working-tree",
    });
    assert.equal(workspaceDiff.status, "ok");
    assert.equal(additionalDiff.status, "ok");
    if (workspaceDiff.status === "ok" && additionalDiff.status === "ok") {
      assert.match(workspaceDiff.patch, /\+workspace/);
      assert.match(additionalDiff.patch, /\+additional/);
    }
    assert.deepEqual(resolvedRootIds, [
      "workspace",
      "additional:shared",
      "workspace",
      "additional:shared",
    ]);
    assert.deepEqual(
      await service.listChanges({ sessionId: "session-1", rootId: "stale" }),
      {
        status: "root-not-found",
        message: "File root could not be resolved for this session.",
      },
    );
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

/** 入れ子Workspaceの隔離statusはその作業ディレクトリー内のみを走査し、リポジトリ外側の変更を出力しない。 */
test("FileRootGitChangesService は nested Workspace のisolated statusをrepository全体へ広げない", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-nested-scope-"),
  );
  const workspacePath = path.join(repositoryPath, "src");
  let isolatedStatusOutput = "";
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    const canonicalWorkspacePath = await realpath(workspacePath);
    await writeFile(path.join(workspacePath, "inside.txt"), "base\n");
    await writeFile(path.join(repositoryPath, "outside.txt"), "base\n");
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "add",
          "src/inside.txt",
          "outside.txt",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "nested scope",
        ])
      ).exitCode,
      0,
    );
    await writeFile(path.join(workspacePath, "inside.txt"), "changed\n");
    await writeFile(
      path.join(repositoryPath, "outside.txt"),
      "outside changed\n",
    );
    const service = new FileRootGitChangesService({
      /** リポジトリのトップではなく、内部ディレクトリーを認可ルートにする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** 隔離statusの実行ディレクトリーと生の出力を捕捉し、後段の投影だけで範囲が絞られた場合と区別する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        const result = await runGitForTest(workingDirectoryPath, args, options);
        if (
          args.includes("status") &&
          args.some((arg) => arg.startsWith("--git-dir="))
        ) {
          assert.equal(workingDirectoryPath, canonicalWorkspacePath);
          isolatedStatusOutput = result.stdout.toString("utf8");
        }
        return result;
      },
    });

    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.deepEqual(
        result.entries.map((entry) => entry.relativePath),
        ["inside.txt"],
      );
    }
    assert.match(isolatedStatusOutput, /src\/inside\.txt/);
    assert.doesNotMatch(isolatedStatusOutput, /outside\.txt/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** Workspace相対へ変換するとき、名前が空白から始まる入れ子のプレフィックスを誤って切り落とさない。 */
test("FileRootGitChangesService は先頭空白を含むnested Workspace prefixを保持する", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-space-prefix-"),
  );
  const workspacePath = path.join(repositoryPath, " workspace");
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "inside.txt"), "base\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", " workspace/inside.txt"]))
        .exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "space prefix",
        ])
      ).exitCode,
      0,
    );
    await writeFile(path.join(workspacePath, "inside.txt"), "changed\n");
    const service = new FileRootGitChangesService({
      /** ルート名の先頭に空白があるディレクトリーを、そのままChangesの対象にする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
    });

    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status === "ok") {
      assert.deepEqual(
        result.entries.map((entry) => entry.relativePath),
        ["inside.txt"],
      );
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 隔離インデックスでもassume-unchangedとskip-worktreeを尊重し、intent-to-addはステージ済みでなく作業ツリーの追加として返す。 */
test("FileRootGitChangesService はextended index flagsとintent-to-add semanticsを保つ", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-index-flags-"),
  );
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "assume.txt"), "base\n");
    await writeFile(path.join(repositoryPath, "skip.txt"), "base\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "assume.txt", "skip.txt"]))
        .exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "index flags",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-index",
          "--assume-unchanged",
          "assume.txt",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "update-index",
          "--skip-worktree",
          "skip.txt",
        ])
      ).exitCode,
      0,
    );
    await writeFile(
      path.join(repositoryPath, "assume.txt"),
      "hidden assume change\n",
    );
    await writeFile(
      path.join(repositoryPath, "skip.txt"),
      "hidden skip change\n",
    );
    await writeFile(
      path.join(repositoryPath, "intent.txt"),
      "intent content\n",
    );
    await writeFile(
      path.join(repositoryPath, "tracked.txt"),
      "normal change\n",
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "-N", "intent.txt"]))
        .exitCode,
      0,
    );

    const service = new FileRootGitChangesService({
      /** indexフラグを設定した実リポジトリをそのまま検証ルートにする。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const changes = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.equal(
        changes.entries.some((entry) => entry.relativePath === "assume.txt"),
        false,
      );
      assert.equal(
        changes.entries.some((entry) => entry.relativePath === "skip.txt"),
        false,
      );
      const intentEntry = changes.entries.find(
        (entry) => entry.relativePath === "intent.txt",
      );
      assert.deepEqual(intentEntry?.scopes, ["working-tree"]);
      assert.equal(intentEntry?.kinds["working-tree"], "added");
      assert.ok(
        changes.entries.some((entry) => entry.relativePath === "tracked.txt"),
      );
    }
    assert.equal(
      (
        await service.getFileDiff({
          sessionId: "session-1",
          rootId: "workspace",
          relativePath: "intent.txt",
          scope: "staged",
        })
      ).status,
      "not-changed",
    );
    const intentDiff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "intent.txt",
      scope: "working-tree",
    });
    assert.equal(intentDiff.status, "ok");
    if (intentDiff.status === "ok") {
      assert.match(intentDiff.patch, /\+intent content/);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 空ファイルのステージ済み名前変更をintent-to-addと誤認せず、旧名と新名をパッチに残す。 */
test("FileRootGitChangesService は空fileのstaged renameをintent-to-addへ誤分類しない", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-empty-rename-"),
  );
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "old.txt"), "");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "old.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "empty file",
        ])
      ).exitCode,
      0,
    );
    await rename(
      path.join(repositoryPath, "old.txt"),
      path.join(repositoryPath, "new.txt"),
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "-A"])).exitCode,
      0,
    );

    const service = new FileRootGitChangesService({
      /** 空ファイルの移動を既にステージした作業ツリーを返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const changes = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.deepEqual(changes.entries, [
        {
          relativePath: "new.txt",
          previousRelativePath: "old.txt",
          kinds: { staged: "renamed" },
          scopes: ["staged"],
        },
      ]);
    }
    const diff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "new.txt",
      scope: "staged",
    });
    assert.equal(diff.status, "ok", JSON.stringify(diff));
    if (diff.status === "ok") {
      assert.match(diff.patch, /rename from old\.txt/);
      assert.match(diff.patch, /rename to new\.txt/);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** intent-to-add登録後にファイルを消した場合、作業ツリーの削除として投影する。 */
test("FileRootGitChangesService は削除済みintent-to-addをworking tree deletionとして返す", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-deleted-intent-"),
  );
  try {
    await initializeRepository(repositoryPath);
    const intentPath = path.join(repositoryPath, "intent.txt");
    await writeFile(intentPath, "intent content\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "-N", "intent.txt"]))
        .exitCode,
      0,
    );
    await unlink(intentPath);

    const service = new FileRootGitChangesService({
      /** 仮登録後のファイルを消した実リポジトリを参照させる。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const changes = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.deepEqual(changes.entries, [
        {
          relativePath: "intent.txt",
          previousRelativePath: null,
          kinds: { "working-tree": "deleted" },
          scopes: ["working-tree"],
        },
      ]);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 削除または移動したsymlinkのintent-to-addを通常ファイルに変えず、modeを含む実Gitと同じパッチを返す。 */
test("FileRootGitChangesService は削除・移動済みsymlink intent-to-addのmodeを保持する", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-deleted-symlink-intent-"),
  );
  try {
    await initializeRepository(repositoryPath);
    const relativePaths = ["deleted-intent-link.txt", "moved-intent-link.txt"];
    const intentPatch = Buffer.from(
      relativePaths
        .flatMap((relativePath) => [
          `diff --git a/${relativePath} b/${relativePath}`,
          "new file mode 120000",
          "index 0000000..e69de29",
          "",
        ])
        .join("\n"),
      "utf8",
    );
    assert.equal(
      (
        await runGitForTest(
          repositoryPath,
          [
            "-c",
            "core.symlinks=false",
            "apply",
            "--intent-to-add",
            "--unidiff-zero",
            "-",
          ],
          { env: process.env, stdin: intentPatch },
        )
      ).exitCode,
      0,
    );
    await unlink(path.join(repositoryPath, relativePaths[0]!));
    await rename(
      path.join(repositoryPath, relativePaths[1]!),
      path.join(repositoryPath, "moved-link-target.txt"),
    );

    const service = new FileRootGitChangesService({
      /** symlinkへの仮登録を行ったリポジトリを差分の解決先にする。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    for (const relativePath of relativePaths) {
      const nativeDiff = await runGitForTest(repositoryPath, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
        "--",
        relativePath,
      ]);
      assert.equal(nativeDiff.exitCode, 0, nativeDiff.stderr);
      assert.match(
        nativeDiff.stdout.toString("utf8"),
        /deleted file mode 120000/,
      );

      const diff = await service.getFileDiff({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath,
        scope: "working-tree",
      });
      assert.equal(diff.status, "ok", JSON.stringify(diff));
      if (diff.status === "ok") {
        assert.equal(diff.patch, nativeDiff.stdout.toString("utf8"));
      }
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 複数サービスを合わせた実行を同時2件に抑え、待機枠を越える19件目を拒否する。 */
test("FileRootGitChangesService はactive/pending operation数をprocess全体で制限する", async () => {
  let activeContextRequests = 0;
  let maximumActiveContextRequests = 0;
  let releaseActiveRequests!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActiveRequests = resolve;
  });
  /** 各要求を別インスタンスへ渡しても、実行枠がプロセス全体で共有されるかを調べる。 */
  const createService = () =>
    new FileRootGitChangesService({
      /** ガードが開くまで解決中の数を増やしたままにし、同時実行の最大値を測る。 */
      resolveRootContext: async () => {
        activeContextRequests += 1;
        maximumActiveContextRequests = Math.max(
          maximumActiveContextRequests,
          activeContextRequests,
        );
        await activeGate;
        activeContextRequests -= 1;
        return null;
      },
    });
  const operations = Array.from({ length: 19 }, (_, index) =>
    createService().listChanges({
      sessionId: "session-1",
      rootId: `root-${index}`,
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(maximumActiveContextRequests, 2);
  assert.deepEqual(await operations[18], {
    status: "failed",
    message: "Too many file root Git previews are already waiting.",
  });
  releaseActiveRequests();
  const results = await Promise.all(operations.slice(0, 18));
  assert.ok(results.every((result) => result.status === "root-not-found"));
  assert.equal(maximumActiveContextRequests, 2);
});

/** 同一ファイルの基準からステージ内容まで、ステージ内容から未保存変更までを別々のパッチとして返す。 */
test("FileRootGitChangesService は同じ file の staged / working-tree diff を隔離 index から分けて返す", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-two-scopes-"),
  );
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "staged\n");
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", "tracked.txt"])).exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "tracked.txt"), "working\n");
    const service = new FileRootGitChangesService({
      /** 両scopeの要求を、同じファイルに2段階の変更がある作業ツリーへ解決する。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });

    const changes = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(changes.status, "ok");
    if (changes.status === "ok") {
      const entry = changes.entries.find(
        (candidate) => candidate.relativePath === "tracked.txt",
      );
      assert.deepEqual(entry?.scopes, ["staged", "working-tree"]);
    }
    const staged = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "tracked.txt",
      scope: "staged",
    });
    assert.equal(staged.status, "ok");
    if (staged.status === "ok") {
      assert.match(staged.patch, /-base/);
      assert.match(staged.patch, /\+staged/);
      assert.doesNotMatch(staged.patch, /working/);
    }
    const workingTree = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "tracked.txt",
      scope: "working-tree",
    });
    assert.equal(workingTree.status, "ok");
    if (workingTree.status === "ok") {
      assert.match(workingTree.patch, /-staged/);
      assert.match(workingTree.patch, /\+working/);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 正規化したWorkspaceを保持するleaseの有効中は、ディレクトリーの差し替えを許さない。 */
test("FileRootGitChangesService は lease 中の canonical Workspace 差し替えを成立させない", async () => {
  const parentPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-identity-"),
  );
  const workspacePath = path.join(parentPath, "workspace");
  const movedPath = path.join(parentPath, "workspace-moved");
  let renameBlocked = false;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "only-a.txt"), "a\n");
    const service = new FileRootGitChangesService({
      /** leaseを取得すべきWorkspaceをChangesの認可ルートにする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** status実行中にだけテスト用Workspaceの移動を試し、拒否されたかを記録する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status")) {
          try {
            await rename(workspacePath, movedPath);
          } catch {
            renameBlocked = true;
          }
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(result.status, "ok");
    assert.equal(renameBlocked, true);
    if (result.status === "ok") {
      assert.ok(
        result.entries.some((entry) => entry.relativePath === "only-a.txt"),
      );
    }
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

/** 隔離statusが非ゼロで終了したとき、空の変更一覧と扱わずGitの失敗内容を公開結果へ返す。 */
test("FileRootGitChangesService は隔離 status process failure を failed result として返す", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-process-failure-"),
  );
  try {
    await initializeRepository(workspacePath);
    const service = new FileRootGitChangesService({
      /** ディレクトリー解決を成功させ、失敗がstatusの実行から生じるようにする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** statusだけを標準エラー付き非ゼロ終了にし、他のGit操作は通常実行する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status")) {
          return {
            exitCode: 2,
            stdout: Buffer.alloc(0),
            stderr: "status exploded",
          };
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    assert.deepEqual(
      await service.listChanges({
        sessionId: "session-1",
        rootId: "workspace",
      }),
      {
        status: "failed",
        message: "status exploded",
      },
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** 期限超過で子処理を中止しても、settlementを観測してから一時領域を解放し、timeoutを返す。 */
test("FileRootGitChangesService はoperation deadline後にchild settlementを待ってresourceを解放する", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-operation-timeout-"),
  );
  let isolatedRootPath = "";
  let abortObserved = false;
  let childSettled = false;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const service = new FileRootGitChangesService({
      /** 期限検証を対象不在で終わらせず、実リポジトリの操作へ進める。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      operationTimeoutMs: 5_000,
      /** 隔離statusを中止通知まで待つ合成処理にし、子処理がsettleした時点と一時領域を記録する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status")) {
          const gitDirectoryArg = args.find((arg) =>
            arg.startsWith("--git-dir="),
          );
          assert.ok(gitDirectoryArg);
          isolatedRootPath = path.dirname(
            gitDirectoryArg.slice("--git-dir=".length),
          );
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
                setTimeout(() => {
                  childSettled = true;
                  reject(new Error("simulated child close"));
                }, 25);
              },
              { once: true },
            );
          });
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    const startedAt = Date.now();
    const result = await runWithReferencedEventLoopHandle(() =>
      service.listChanges({ sessionId: "session-1", rootId: "workspace" }),
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /timed out/);
    }
    assert.equal(abortObserved, true);
    assert.equal(childSettled, true);
    assert.ok(Date.now() - startedAt >= 5_000);
    assert.ok(isolatedRootPath);
    await assert.rejects(() => access(isolatedRootPath));
    assert.equal(
      (await readdir(workspacePath)).some((name) =>
        name.startsWith(".withmate-git-preview-"),
      ),
      false,
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** timeout後に一時領域の解放も失敗した場合はcleanup失敗を優先し、次のインスタンスで保留資源を再回収する。 */
test("FileRootGitChangesService はtimeout後のcleanup failureを優先して次のinstanceで再試行する", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-timeout-cleanup-"),
  );
  let allowCleanup = false;
  let retainedDirectoryPath = "";
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const service = new FileRootGitChangesService({
      /** timeoutとcleanup失敗を発生させる元の作業ツリーを返す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      operationTimeoutMs: 5_000,
      cleanupRetryDelayMs: 0,
      /** 削除対象の一時領域を捕捉し、最初の試行ではEPERMを返す。 */
      removeTemporaryDirectory: async (directoryPath) => {
        retainedDirectoryPath = directoryPath;
        if (!allowCleanup) {
          throw Object.assign(new Error("simulated cleanup failure"), {
            code: "EPERM",
          });
        }
        await rm(directoryPath, { recursive: true, force: true });
      },
      /** 隔離statusだけを期限まで保留し、abort後のsettlementを模擬する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (
          args.includes("status") &&
          args.some((arg) => arg.startsWith("--git-dir="))
        ) {
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                setTimeout(
                  () => reject(new Error("simulated child close")),
                  25,
                );
              },
              { once: true },
            );
          });
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    const result = await runWithReferencedEventLoopHandle(() =>
      service.listChanges({ sessionId: "session-1", rootId: "workspace" }),
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /cleanup failed/);
      assert.match(result.message, /EPERM/);
      assert.doesNotMatch(result.message, /timed out/);
    }
    await access(retainedDirectoryPath);

    allowCleanup = true;
    const nextRequestService = new FileRootGitChangesService({
      /** 再作成したインスタンスを同じWorkspaceにつなぎ、以前の失敗で残った資源の回収を観測する。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      cleanupRetryDelayMs: 0,
    });
    assert.equal(
      (
        await nextRequestService.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        })
      ).status,
      "ok",
    );
    await assert.rejects(() => access(retainedDirectoryPath));
  } finally {
    if (retainedDirectoryPath) {
      await rm(retainedDirectoryPath, { recursive: true, force: true });
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** 一時ディレクトリー削除の失敗を型付き結果に返し、次の操作で保留した削除を再試行する。 */
test("FileRootGitChangesService はtemp cleanup failureをtyped failureにして次のoperationで再試行する", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-temp-cleanup-"),
  );
  let allowCleanup = false;
  let cleanupAttempts = 0;
  let retainedDirectoryPath = "";
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    /** 削除試行と対象パスを記録し、許可フラグが立つまではEPERMを返す。 */
    const removeTemporaryDirectory = async (directoryPath: string) => {
      cleanupAttempts += 1;
      retainedDirectoryPath = directoryPath;
      if (!allowCleanup) {
        throw Object.assign(new Error("simulated cleanup failure"), {
          code: "EPERM",
        });
      }
      await rm(directoryPath, { recursive: true, force: true });
    };
    const service = new FileRootGitChangesService({
      /** 最初のインスタンスが隔離操作まで進める作業ツリーを返す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      cleanupRetryDelayMs: 0,
      removeTemporaryDirectory,
    });
    const firstResult = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(firstResult.status, "failed");
    if (firstResult.status === "failed") {
      assert.match(firstResult.message, /cleanup failed/);
      assert.match(firstResult.message, /EPERM/);
    }
    assert.equal(cleanupAttempts, 3);
    await access(retainedDirectoryPath);

    allowCleanup = true;
    const nextRequestService = new FileRootGitChangesService({
      /** 次のインスタンスで同じWorkspaceの操作を始め、残った削除の再試行を促す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      cleanupRetryDelayMs: 0,
      removeTemporaryDirectory,
    });
    assert.equal(
      (
        await nextRequestService.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        })
      ).status,
      "ok",
    );
    await assert.rejects(() => access(retainedDirectoryPath));
  } finally {
    if (retainedDirectoryPath) {
      await rm(retainedDirectoryPath, { recursive: true, force: true });
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** ディレクトリーleaseを閉じられない場合は型付き失敗を返し、次の操作で保留ハンドルを再度閉じる。 */
test("FileRootGitChangesService はlease close failureをtyped failureにして次のoperationで再試行する", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-lease-cleanup-"),
  );
  let allowClose = false;
  let closeAttempts = 0;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    /** leaseを閉じる試行を数え、許可前はEIO、許可後は実際のクローズにする。 */
    const closeDirectoryLease = async (fileHandle: FileHandle) => {
      closeAttempts += 1;
      if (!allowClose) {
        throw Object.assign(new Error("simulated close failure"), {
          code: "EIO",
        });
      }
      await fileHandle.close();
    };
    const service = new FileRootGitChangesService({
      /** 最初の試行でleaseを取得するため、実Workspaceを返す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      cleanupRetryDelayMs: 0,
      closeDirectoryLease,
    });
    const firstResult = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(firstResult.status, "failed");
    if (firstResult.status === "failed") {
      assert.match(firstResult.message, /cleanup failed/);
      assert.match(firstResult.message, /EIO/);
    }
    assert.ok(closeAttempts >= 3);

    allowClose = true;
    const nextRequestService = new FileRootGitChangesService({
      /** 再度の操作にも同じ認可先を返し、以前のlease解放が再試行されるかを確認できるようにする。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      cleanupRetryDelayMs: 0,
      closeDirectoryLease,
    });
    assert.equal(
      (
        await nextRequestService.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        })
      ).status,
      "ok",
    );
    assert.equal(
      (await readdir(workspacePath)).some((name) =>
        name.startsWith(".withmate-git-preview-"),
      ),
      false,
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

/** 有効なcleanフィルターがあるChanges要求を失敗として返し、外部コマンドは実行しない。 */
test("FileRootGitChangesService は active clean filter を実行せず typed failure を返す", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-filter-"),
  );
  const markerPath = path.join(repositoryPath, "filter-ran.txt");
  const filterScriptPath = path.join(repositoryPath, "filter-script.cjs");
  try {
    await initializeRepository(repositoryPath);
    await writeFile(
      path.join(repositoryPath, ".gitattributes"),
      "tracked.txt filter=marker\n",
    );
    assert.equal(
      (await runGitForTest(repositoryPath, ["add", ".gitattributes"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "attributes",
        ])
      ).exitCode,
      0,
    );
    await writeFile(
      filterScriptPath,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n",
    );
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}" "${markerPath.replaceAll("\\", "/")}"`;
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "config",
          "filter.marker.clean",
          command,
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "config",
          "filter.marker.required",
          "true",
        ])
      ).exitCode,
      0,
    );
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");

    const service = new FileRootGitChangesService({
      /** cleanフィルターを持つ試験リポジトリを認可ルートとして返す。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });

    assert.deepEqual(result, {
      status: "failed",
      message:
        "Git clean/process filters are not supported for Workspace changes.",
    });
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** チェックアウト済みsubmoduleを含んでも、親のstatus・diffは子側のcleanフィルターを実行しない。 */
test("FileRootGitChangesService は populated submodule の status / diff で clean filter を実行しない", async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-submodule-filter-"),
  );
  const repositoryPath = path.join(tempRoot, "repository");
  const submoduleSourcePath = path.join(tempRoot, "submodule-source");
  const submodulePath = path.join(repositoryPath, "modules", "child");
  const markerPath = path.join(tempRoot, "submodule-filter-ran.txt");
  const filterScriptPath = path.join(tempRoot, "submodule-filter-script.cjs");
  try {
    await initializeRepository(submoduleSourcePath);
    await writeFile(
      path.join(submoduleSourcePath, ".gitattributes"),
      "tracked.txt filter=marker\n",
    );
    assert.equal(
      (await runGitForTest(submoduleSourcePath, ["add", ".gitattributes"]))
        .exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(submoduleSourcePath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "attributes",
        ])
      ).exitCode,
      0,
    );

    await initializeRepository(repositoryPath);
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          submoduleSourcePath,
          "modules/child",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(repositoryPath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "submodule",
        ])
      ).exitCode,
      0,
    );

    await writeFile(path.join(submodulePath, "next.txt"), "next\n");
    assert.equal(
      (await runGitForTest(submodulePath, ["add", "next.txt"])).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(submodulePath, [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "next",
        ])
      ).exitCode,
      0,
    );

    await writeFile(
      filterScriptPath,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n",
    );
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}" "${markerPath.replaceAll("\\", "/")}"`;
    assert.equal(
      (
        await runGitForTest(submodulePath, [
          "config",
          "filter.marker.clean",
          command,
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runGitForTest(submodulePath, [
          "config",
          "filter.marker.required",
          "true",
        ])
      ).exitCode,
      0,
    );
    await writeFile(path.join(submodulePath, "tracked.txt"), "changed\n");

    const service = new FileRootGitChangesService({
      /** submoduleを参照する親リポジトリだけをChanges要求の対象とする。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
    });
    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });

    assert.equal(result.status, "ok", JSON.stringify(result));
    const diff = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "modules/child",
      scope: "working-tree",
    });
    assert.equal(diff.status, "ok", JSON.stringify(diff));
    if (diff.status === "ok") {
      assert.match(
        diff.patch,
        /Subproject commit [0-9a-f]+\n\+Subproject commit [0-9a-f]+/,
      );
      assert.doesNotMatch(diff.patch, /-dirty/);
    }
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** フィルターの事前確認後に設定が変わっても、隔離Git処理で追加の外部コマンドを実行しない。 */
test("FileRootGitChangesService は filter preflight 後に追加された command も実行しない", async () => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-filter-race-"),
  );
  const markerPath = path.join(repositoryPath, "filter-race-ran.txt");
  const filterScriptPath = path.join(repositoryPath, "filter-race-script.cjs");
  let filterInstalled = false;
  try {
    await initializeRepository(repositoryPath);
    await writeFile(
      filterScriptPath,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n",
    );
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}" "${markerPath.replaceAll("\\", "/")}"`;
    const service = new FileRootGitChangesService({
      /** フィルター確認と隔離statusを同じ試験リポジトリで実行させる。 */
      resolveRootContext: async () => ({ rootPath: repositoryPath }),
      /** 事前検査後に起きる設定変更をテスト用に模擬し、コマンドを実行した痕跡がないか確認できるようにする。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status") && !filterInstalled) {
          filterInstalled = true;
          await writeFile(
            path.join(repositoryPath, ".gitattributes"),
            "tracked.txt filter=marker\n",
          );
          assert.equal(
            (
              await runGitForTest(repositoryPath, [
                "config",
                "filter.marker.clean",
                command,
              ])
            ).exitCode,
            0,
          );
          assert.equal(
            (
              await runGitForTest(repositoryPath, [
                "config",
                "filter.marker.required",
                "true",
              ])
            ).exitCode,
            0,
          );
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });

    assert.equal(
      (
        await service.listChanges({
          sessionId: "session-1",
          rootId: "workspace",
        })
      ).status,
      "ok",
    );
    assert.equal(filterInstalled, true);
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

/** 正規Workspaceの入れ替えを試行しても、diffは認可済みリポジトリの変更だけを返す。 */
test("FileRootGitChangesService は canonical root の A-B-A 差し替えで別 repository の diff を返さない", async () => {
  const parentPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-canonical-aba-"),
  );
  const workspacePath = path.join(parentPath, "workspace");
  const secondRepositoryPath = path.join(parentPath, "second-repository");
  const movedWorkspacePath = path.join(parentPath, "workspace-original");
  let replacementBlocked = false;
  try {
    await initializeRepository(workspacePath);
    await initializeRepository(secondRepositoryPath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "VISIBLE_A\n");
    await writeFile(
      path.join(secondRepositoryPath, "tracked.txt"),
      "SECRET_B\n",
    );
    const service = new FileRootGitChangesService({
      /** 差分で参照を継続すべき元の認可Workspaceを返す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** diff実行中のディレクトリー置換を試験内で試し、leaseが阻止したかを記録する。 */
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("diff")) {
          try {
            await rename(workspacePath, movedWorkspacePath);
            await rename(secondRepositoryPath, workspacePath);
          } catch {
            replacementBlocked = true;
          }
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });

    const result = await service.getFileDiff({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "tracked.txt",
      scope: "working-tree",
    });
    assert.equal(result.status, "ok");
    assert.equal(replacementBlocked, true);
    if (result.status === "ok") {
      assert.match(result.patch, /VISIBLE_A/);
      assert.doesNotMatch(result.patch, /SECRET_B/);
    }
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

/** Workspace junctionの参照先がstatus中に変わっても、結果は先に認可したリポジトリだけを含む。 */
test("FileRootGitChangesService は Workspace junction の ABA 差し替え中も認可済み repository を読む", async () => {
  const parentPath = await mkdtemp(
    path.join(os.tmpdir(), "withmate-git-junction-aba-"),
  );
  const firstTargetPath = path.join(parentPath, "first-target");
  const secondTargetPath = path.join(parentPath, "second-target");
  const workspacePath = path.join(parentPath, "workspace");
  const originalJunctionPath = path.join(parentPath, "workspace-original");
  try {
    await initializeRepository(firstTargetPath);
    await initializeRepository(secondTargetPath);
    await writeFile(path.join(firstTargetPath, "only-a.txt"), "a\n");
    await writeFile(path.join(secondTargetPath, "only-b.txt"), "b\n");
    await symlink(firstTargetPath, workspacePath, "junction");
    const service = new FileRootGitChangesService({
      /** 正規パスでなくjunctionのパスを解決元として渡す。 */
      resolveRootContext: async () => ({ rootPath: workspacePath }),
      /** 認可からstatusまでの間の試験用junction変更を模擬し、サービスから受け取った作業先でGitを実行する。 */
      runGit: async (boundWorkspacePath, args, options) => {
        if (!args.includes("status")) {
          return runGitForTest(boundWorkspacePath, args, options);
        }
        await rename(workspacePath, originalJunctionPath);
        await symlink(secondTargetPath, workspacePath, "junction");
        try {
          return await runGitForTest(boundWorkspacePath, args, options);
        } finally {
          await rm(workspacePath, { recursive: true, force: true });
          await rename(originalJunctionPath, workspacePath);
        }
      },
    });

    const result = await service.listChanges({
      sessionId: "session-1",
      rootId: "workspace",
    });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.ok(
        result.entries.some((entry) => entry.relativePath === "only-a.txt"),
      );
      assert.ok(
        result.entries.every((entry) => entry.relativePath !== "only-b.txt"),
      );
    }
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});
