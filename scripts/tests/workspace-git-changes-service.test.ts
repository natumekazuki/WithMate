import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
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

import {
  parseGitPorcelainV1Z,
  WorkspaceGitChangesService,
} from "../../src-electron/workspace-git-changes-service.js";

const EXPECTED_GIT_GLOBAL_ARGS = ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false"];

function runGitForTest(
  workspacePath: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; executablePath?: string; stdin?: Buffer; signal?: AbortSignal } = { env: process.env },
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath ?? "git", ["-C", workspacePath, ...args], {
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
    child.stdin.end(options.stdin);
  });
}

async function initializeRepository(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  assert.equal((await runGitForTest(repositoryPath, ["init", "--quiet"])).exitCode, 0);
  await writeFile(path.join(repositoryPath, "tracked.txt"), "base\n");
  assert.equal((await runGitForTest(repositoryPath, ["add", "tracked.txt"])).exitCode, 0);
  assert.equal((await runGitForTest(repositoryPath, [
    "-c",
    "user.name=WithMate Test",
    "-c",
    "user.email=withmate@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  ])).exitCode, 0);
}

test("parseGitPorcelainV1Z は working tree / staged / untracked / rename を scope 付きで返す", () => {
  const output = Buffer.from(" M src/a.ts\0M  src/b.ts\0?? src/new.ts\0R  src/to.ts\0src/from.ts\0", "utf8");
  assert.deepEqual(parseGitPorcelainV1Z(output), [
    { relativePath: "src/a.ts", previousRelativePath: null, kinds: { "working-tree": "modified" }, scopes: ["working-tree"] },
    { relativePath: "src/b.ts", previousRelativePath: null, kinds: { staged: "modified" }, scopes: ["staged"] },
    { relativePath: "src/new.ts", previousRelativePath: null, kinds: { "working-tree": "untracked" }, scopes: ["working-tree"] },
    { relativePath: "src/to.ts", previousRelativePath: "src/from.ts", kinds: { staged: "renamed" }, scopes: ["staged"] },
  ]);
});

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

test("WorkspaceGitChangesService は隔離した status / diff と非継承 Git 環境を使う", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-changes-"));
  const workspacePath = path.join(repositoryPath, "src");
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "a.ts"), "old\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "src/a.ts"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c", "user.name=WithMate Test", "-c", "user.email=withmate@example.invalid",
      "commit", "--quiet", "-m", "nested",
    ])).exitCode, 0);
    await writeFile(path.join(workspacePath, "a.ts"), "new\n");
    await writeFile(path.join(workspacePath, "new.ts"), "untracked\n");

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      processEnv: {
        ...process.env,
        GIT_DIR: "redirected-dir",
        git_work_tree: "redirected-worktree",
        GIT_TRACE: path.join(repositoryPath, "trace.txt"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "external-command",
      },
      runGit: async (workingDirectoryPath, args, options) => {
        calls.push({ args, env: options.env });
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });

    const changes = await service.listChanges("session-1");
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.ok(changes.entries.some((entry) => entry.relativePath === "a.ts"));
      assert.ok(changes.entries.some((entry) => entry.relativePath === "new.ts"));
    }
    const diff = await service.getFileDiff({ sessionId: "session-1", relativePath: "a.ts", scope: "working-tree" });
    assert.equal(diff.status, "ok");
    if (diff.status === "ok") {
      assert.match(diff.patch, /-old/);
      assert.match(diff.patch, /\+new/);
    }
    for (const { args, env } of calls) {
      assert.deepEqual(args.slice(0, EXPECTED_GIT_GLOBAL_ARGS.length), EXPECTED_GIT_GLOBAL_ARGS);
      assert.equal(env.GIT_TRACE, undefined);
      assert.equal(env.GIT_DIR, undefined);
      assert.equal(env.git_work_tree, undefined);
      assert.equal(env.GIT_CONFIG_COUNT, undefined);
    }
    const diffArgs = [...calls].reverse().find(({ args }) => args.includes("diff"))?.args;
    assert.ok(diffArgs);
    assert.ok(diffArgs.some((arg) => arg.startsWith("--git-dir=") && !arg.endsWith(`${path.sep}.git`)));
    assert.deepEqual(diffArgs.slice(diffArgs.indexOf("diff")), [
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3",
      "--", ":(top,literal)src/a.ts",
    ]);
    await assert.rejects(() => access(path.join(repositoryPath, "trace.txt")));
    await assert.rejects(
      () => service.getFileDiff({ sessionId: "session-1", relativePath: "../escape", scope: "working-tree" }),
      /invalid segment/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は Workspace 内の git command を起動候補にしない", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-decoy-"));
  const markerPath = path.join(repositoryPath, "decoy-ran.txt");
  try {
    await initializeRepository(repositoryPath);
    await writeFile(
      path.join(repositoryPath, "git.cmd"),
      `@echo off\r\necho ran>"${markerPath}"\r\nexit /b 17\r\n`,
    );
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });

    assert.equal((await service.listChanges("session-1")).status, "ok");
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は Git executable resolver を最初のoperationまで起動しない", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-lazy-resolver-"));
  const unhandledReasons: unknown[] = [];
  const handleUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
  process.on("unhandledRejection", handleUnhandledRejection);
  try {
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      resolveGitExecutablePath: async () => {
        throw new Error("resolver initialization failed");
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledReasons, []);

    const result = await service.listChanges("session-1");
    assert.deepEqual(result, { status: "failed", message: "resolver initialization failed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledReasons, []);
  } finally {
    process.off("unhandledRejection", handleUnhandledRejection);
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はGit localeを固定して non-Git Workspaceを分類する", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-localized-not-repo-"));
  try {
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      processEnv: { ...process.env, LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" },
      runGit: async (_workingDirectoryPath, _args, options) => {
        assert.equal(options.env.LANG, "C");
        assert.equal(options.env.LC_ALL, "C");
        return {
          exitCode: 128,
          stdout: Buffer.alloc(0),
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        };
      },
    });
    assert.deepEqual(await service.listChanges("session-1"), {
      status: "not-git",
      message: "Workspace is not a Git repository.",
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は実際のnon-Git directoryをnot-gitで返す", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-not-repo-"));
  try {
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
    });
    assert.deepEqual(await service.listChanges("session-1"), {
      status: "not-git",
      message: "Workspace is not a Git repository.",
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は nested Workspace のisolated statusをrepository全体へ広げない", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-nested-scope-"));
  const workspacePath = path.join(repositoryPath, "src");
  let isolatedStatusOutput = "";
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "inside.txt"), "base\n");
    await writeFile(path.join(repositoryPath, "outside.txt"), "base\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "src/inside.txt", "outside.txt"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c", "user.name=WithMate Test", "-c", "user.email=withmate@example.invalid",
      "commit", "--quiet", "-m", "nested scope",
    ])).exitCode, 0);
    await writeFile(path.join(workspacePath, "inside.txt"), "changed\n");
    await writeFile(path.join(repositoryPath, "outside.txt"), "outside changed\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      runGit: async (workingDirectoryPath, args, options) => {
        const result = await runGitForTest(workingDirectoryPath, args, options);
        if (args.includes("status") && args.some((arg) => arg.startsWith("--git-dir="))) {
          assert.equal(workingDirectoryPath, workspacePath);
          isolatedStatusOutput = result.stdout.toString("utf8");
        }
        return result;
      },
    });

    const result = await service.listChanges("session-1");
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.deepEqual(result.entries.map((entry) => entry.relativePath), ["inside.txt"]);
    }
    assert.match(isolatedStatusOutput, /src\/inside\.txt/);
    assert.doesNotMatch(isolatedStatusOutput, /outside\.txt/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は先頭空白を含むnested Workspace prefixを保持する", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-space-prefix-"));
  const workspacePath = path.join(repositoryPath, " workspace");
  try {
    await initializeRepository(repositoryPath);
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "inside.txt"), "base\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", " workspace/inside.txt"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c", "user.name=WithMate Test", "-c", "user.email=withmate@example.invalid",
      "commit", "--quiet", "-m", "space prefix",
    ])).exitCode, 0);
    await writeFile(path.join(workspacePath, "inside.txt"), "changed\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
    });

    const result = await service.listChanges("session-1");
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status === "ok") {
      assert.deepEqual(result.entries.map((entry) => entry.relativePath), ["inside.txt"]);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はextended index flagsとintent-to-add semanticsを保つ", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-index-flags-"));
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "assume.txt"), "base\n");
    await writeFile(path.join(repositoryPath, "skip.txt"), "base\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "assume.txt", "skip.txt"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c", "user.name=WithMate Test", "-c", "user.email=withmate@example.invalid",
      "commit", "--quiet", "-m", "index flags",
    ])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, ["update-index", "--assume-unchanged", "assume.txt"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, ["update-index", "--skip-worktree", "skip.txt"])).exitCode, 0);
    await writeFile(path.join(repositoryPath, "assume.txt"), "hidden assume change\n");
    await writeFile(path.join(repositoryPath, "skip.txt"), "hidden skip change\n");
    await writeFile(path.join(repositoryPath, "intent.txt"), "intent content\n");
    await writeFile(path.join(repositoryPath, "tracked.txt"), "normal change\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "-N", "intent.txt"])).exitCode, 0);

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });
    const changes = await service.listChanges("session-1");
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.equal(changes.entries.some((entry) => entry.relativePath === "assume.txt"), false);
      assert.equal(changes.entries.some((entry) => entry.relativePath === "skip.txt"), false);
      const intentEntry = changes.entries.find((entry) => entry.relativePath === "intent.txt");
      assert.deepEqual(intentEntry?.scopes, ["working-tree"]);
      assert.equal(intentEntry?.kinds["working-tree"], "added");
      assert.ok(changes.entries.some((entry) => entry.relativePath === "tracked.txt"));
    }
    assert.equal((await service.getFileDiff({
      sessionId: "session-1",
      relativePath: "intent.txt",
      scope: "staged",
    })).status, "not-changed");
    const intentDiff = await service.getFileDiff({
      sessionId: "session-1",
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

test("WorkspaceGitChangesService は空fileのstaged renameをintent-to-addへ誤分類しない", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-empty-rename-"));
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "old.txt"), "");
    assert.equal((await runGitForTest(repositoryPath, ["add", "old.txt"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c", "user.name=WithMate Test", "-c", "user.email=withmate@example.invalid",
      "commit", "--quiet", "-m", "empty file",
    ])).exitCode, 0);
    await rename(path.join(repositoryPath, "old.txt"), path.join(repositoryPath, "new.txt"));
    assert.equal((await runGitForTest(repositoryPath, ["add", "-A"])).exitCode, 0);

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });
    const changes = await service.listChanges("session-1");
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.deepEqual(changes.entries, [{
        relativePath: "new.txt",
        previousRelativePath: "old.txt",
        kinds: { staged: "renamed" },
        scopes: ["staged"],
      }]);
    }
    const diff = await service.getFileDiff({
      sessionId: "session-1",
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

test("WorkspaceGitChangesService は削除済みintent-to-addをworking tree deletionとして返す", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-deleted-intent-"));
  try {
    await initializeRepository(repositoryPath);
    const intentPath = path.join(repositoryPath, "intent.txt");
    await writeFile(intentPath, "intent content\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "-N", "intent.txt"])).exitCode, 0);
    await unlink(intentPath);

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });
    const changes = await service.listChanges("session-1");
    assert.equal(changes.status, "ok", JSON.stringify(changes));
    if (changes.status === "ok") {
      assert.deepEqual(changes.entries, [{
        relativePath: "intent.txt",
        previousRelativePath: null,
        kinds: { "working-tree": "deleted" },
        scopes: ["working-tree"],
      }]);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は削除・移動済みsymlink intent-to-addのmodeを保持する", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-deleted-symlink-intent-"));
  try {
    await initializeRepository(repositoryPath);
    const relativePaths = ["deleted-intent-link.txt", "moved-intent-link.txt"];
    const intentPatch = Buffer.from(relativePaths.flatMap((relativePath) => [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 120000",
      "index 0000000..e69de29",
      "",
    ]).join("\n"), "utf8");
    assert.equal((await runGitForTest(repositoryPath, [
      "apply",
      "--intent-to-add",
      "--unidiff-zero",
      "-",
    ], { env: process.env, stdin: intentPatch })).exitCode, 0);
    await unlink(path.join(repositoryPath, relativePaths[0]!));
    await rename(
      path.join(repositoryPath, relativePaths[1]!),
      path.join(repositoryPath, "moved-link-target.txt"),
    );

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
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
      assert.match(nativeDiff.stdout.toString("utf8"), /deleted file mode 120000/);

      const diff = await service.getFileDiff({
        sessionId: "session-1",
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

test("WorkspaceGitChangesService はactive/pending operation数をprocess全体で制限する", async () => {
  let activeContextRequests = 0;
  let maximumActiveContextRequests = 0;
  let releaseActiveRequests!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActiveRequests = resolve;
  });
  const service = new WorkspaceGitChangesService({
    getWorkspaceContext: async () => {
      activeContextRequests += 1;
      maximumActiveContextRequests = Math.max(maximumActiveContextRequests, activeContextRequests);
      await activeGate;
      activeContextRequests -= 1;
      return null;
    },
  });
  const operations = Array.from({ length: 19 }, (_, index) => service.listChanges(`session-${index}`));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(maximumActiveContextRequests, 2);
  assert.deepEqual(await operations[18], {
    status: "failed",
    message: "Too many Workspace Git previews are already waiting.",
  });
  releaseActiveRequests();
  const results = await Promise.all(operations.slice(0, 18));
  assert.ok(results.every((result) => result.status === "workspace-not-found"));
  assert.equal(maximumActiveContextRequests, 2);
});

test("WorkspaceGitChangesService は同じ file の staged / working-tree diff を隔離 index から分けて返す", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-two-scopes-"));
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "staged\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", "tracked.txt"])).exitCode, 0);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "working\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });

    const changes = await service.listChanges("session-1");
    assert.equal(changes.status, "ok");
    if (changes.status === "ok") {
      const entry = changes.entries.find((candidate) => candidate.relativePath === "tracked.txt");
      assert.deepEqual(entry?.scopes, ["staged", "working-tree"]);
    }
    const staged = await service.getFileDiff({
      sessionId: "session-1",
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

test("WorkspaceGitChangesService は lease 中の canonical Workspace 差し替えを成立させない", async () => {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-identity-"));
  const workspacePath = path.join(parentPath, "workspace");
  const movedPath = path.join(parentPath, "workspace-moved");
  let renameBlocked = false;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "only-a.txt"), "a\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
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
    const result = await service.listChanges("session-1");
    assert.equal(result.status, "ok");
    assert.equal(renameBlocked, true);
    if (result.status === "ok") {
      assert.ok(result.entries.some((entry) => entry.relativePath === "only-a.txt"));
    }
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は隔離 status process failure を failed result として返す", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-process-failure-"));
  try {
    await initializeRepository(workspacePath);
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status")) {
          return { exitCode: 2, stdout: Buffer.alloc(0), stderr: "status exploded" };
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    assert.deepEqual(await service.listChanges("session-1"), {
      status: "failed",
      message: "status exploded",
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はoperation deadline後にchild settlementを待ってresourceを解放する", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-operation-timeout-"));
  let isolatedRootPath = "";
  let abortObserved = false;
  let childSettled = false;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      operationTimeoutMs: 5_000,
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status")) {
          const gitDirectoryArg = args.find((arg) => arg.startsWith("--git-dir="));
          assert.ok(gitDirectoryArg);
          isolatedRootPath = path.dirname(gitDirectoryArg.slice("--git-dir=".length));
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              abortObserved = true;
              setTimeout(() => {
                childSettled = true;
                reject(new Error("simulated child close"));
              }, 25);
            }, { once: true });
          });
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    const startedAt = Date.now();
    const result = await service.listChanges("session-1");

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /timed out/);
    }
    assert.equal(abortObserved, true);
    assert.equal(childSettled, true);
    assert.ok(Date.now() - startedAt >= 5_000);
    assert.ok(isolatedRootPath);
    await assert.rejects(() => access(isolatedRootPath));
    assert.equal((await readdir(workspacePath)).some((name) => name.startsWith(".withmate-git-preview-")), false);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はtimeout後のcleanup failureを優先して次のinstanceで再試行する", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-timeout-cleanup-"));
  let allowCleanup = false;
  let retainedDirectoryPath = "";
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      operationTimeoutMs: 5_000,
      cleanupRetryDelayMs: 0,
      removeTemporaryDirectory: async (directoryPath) => {
        retainedDirectoryPath = directoryPath;
        if (!allowCleanup) {
          throw Object.assign(new Error("simulated cleanup failure"), { code: "EPERM" });
        }
        await rm(directoryPath, { recursive: true, force: true });
      },
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status") && args.some((arg) => arg.startsWith("--git-dir="))) {
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              setTimeout(() => reject(new Error("simulated child close")), 25);
            }, { once: true });
          });
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });
    const result = await service.listChanges("session-1");

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /cleanup failed/);
      assert.match(result.message, /EPERM/);
      assert.doesNotMatch(result.message, /timed out/);
    }
    await access(retainedDirectoryPath);

    allowCleanup = true;
    const nextRequestService = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      cleanupRetryDelayMs: 0,
    });
    assert.equal((await nextRequestService.listChanges("session-1")).status, "ok");
    await assert.rejects(() => access(retainedDirectoryPath));
  } finally {
    if (retainedDirectoryPath) {
      await rm(retainedDirectoryPath, { recursive: true, force: true });
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はtemp cleanup failureをtyped failureにして次のoperationで再試行する", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-temp-cleanup-"));
  let allowCleanup = false;
  let cleanupAttempts = 0;
  let retainedDirectoryPath = "";
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const removeTemporaryDirectory = async (directoryPath: string) => {
      cleanupAttempts += 1;
      retainedDirectoryPath = directoryPath;
      if (!allowCleanup) {
        throw Object.assign(new Error("simulated cleanup failure"), { code: "EPERM" });
      }
      await rm(directoryPath, { recursive: true, force: true });
    };
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      cleanupRetryDelayMs: 0,
      removeTemporaryDirectory,
    });
    const firstResult = await service.listChanges("session-1");
    assert.equal(firstResult.status, "failed");
    if (firstResult.status === "failed") {
      assert.match(firstResult.message, /cleanup failed/);
      assert.match(firstResult.message, /EPERM/);
    }
    assert.equal(cleanupAttempts, 3);
    await access(retainedDirectoryPath);

    allowCleanup = true;
    const nextRequestService = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      cleanupRetryDelayMs: 0,
      removeTemporaryDirectory,
    });
    assert.equal((await nextRequestService.listChanges("session-1")).status, "ok");
    await assert.rejects(() => access(retainedDirectoryPath));
  } finally {
    if (retainedDirectoryPath) {
      await rm(retainedDirectoryPath, { recursive: true, force: true });
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService はlease close failureをtyped failureにして次のoperationで再試行する", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-lease-cleanup-"));
  let allowClose = false;
  let closeAttempts = 0;
  try {
    await initializeRepository(workspacePath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    const closeDirectoryLease = async (fileHandle: FileHandle) => {
      closeAttempts += 1;
      if (!allowClose) {
        throw Object.assign(new Error("simulated close failure"), { code: "EIO" });
      }
      await fileHandle.close();
    };
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      cleanupRetryDelayMs: 0,
      closeDirectoryLease,
    });
    const firstResult = await service.listChanges("session-1");
    assert.equal(firstResult.status, "failed");
    if (firstResult.status === "failed") {
      assert.match(firstResult.message, /cleanup failed/);
      assert.match(firstResult.message, /EIO/);
    }
    assert.ok(closeAttempts >= 3);

    allowClose = true;
    const nextRequestService = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
      cleanupRetryDelayMs: 0,
      closeDirectoryLease,
    });
    assert.equal((await nextRequestService.listChanges("session-1")).status, "ok");
    assert.equal((await readdir(workspacePath)).some((name) => name.startsWith(".withmate-git-preview-")), false);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は active clean filter を実行せず typed failure を返す", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-filter-"));
  const markerPath = path.join(repositoryPath, "filter-ran.txt");
  const filterScriptPath = path.join(repositoryPath, "filter-script.cjs");
  try {
    await initializeRepository(repositoryPath);
    await writeFile(path.join(repositoryPath, ".gitattributes"), "tracked.txt filter=marker\n");
    assert.equal((await runGitForTest(repositoryPath, ["add", ".gitattributes"])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, [
      "-c",
      "user.name=WithMate Test",
      "-c",
      "user.email=withmate@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "attributes",
    ])).exitCode, 0);
    await writeFile(
      filterScriptPath,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n",
    );
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}" "${markerPath.replaceAll("\\", "/")}"`;
    assert.equal((await runGitForTest(repositoryPath, ["config", "filter.marker.clean", command])).exitCode, 0);
    assert.equal((await runGitForTest(repositoryPath, ["config", "filter.marker.required", "true"])).exitCode, 0);
    await writeFile(path.join(repositoryPath, "tracked.txt"), "changed\n");

    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
    });
    const result = await service.listChanges("session-1");

    assert.deepEqual(result, {
      status: "failed",
      message: "Git clean/process filters are not supported for Workspace changes.",
    });
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は filter preflight 後に追加された command も実行しない", async () => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-filter-race-"));
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
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath: repositoryPath }),
      runGit: async (workingDirectoryPath, args, options) => {
        if (args.includes("status") && !filterInstalled) {
          filterInstalled = true;
          await writeFile(path.join(repositoryPath, ".gitattributes"), "tracked.txt filter=marker\n");
          assert.equal((await runGitForTest(repositoryPath, ["config", "filter.marker.clean", command])).exitCode, 0);
          assert.equal((await runGitForTest(repositoryPath, ["config", "filter.marker.required", "true"])).exitCode, 0);
        }
        return runGitForTest(workingDirectoryPath, args, options);
      },
    });

    assert.equal((await service.listChanges("session-1")).status, "ok");
    assert.equal(filterInstalled, true);
    await assert.rejects(() => access(markerPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("WorkspaceGitChangesService は canonical root の A-B-A 差し替えで別 repository の diff を返さない", async () => {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-canonical-aba-"));
  const workspacePath = path.join(parentPath, "workspace");
  const secondRepositoryPath = path.join(parentPath, "second-repository");
  const movedWorkspacePath = path.join(parentPath, "workspace-original");
  let replacementBlocked = false;
  try {
    await initializeRepository(workspacePath);
    await initializeRepository(secondRepositoryPath);
    await writeFile(path.join(workspacePath, "tracked.txt"), "VISIBLE_A\n");
    await writeFile(path.join(secondRepositoryPath, "tracked.txt"), "SECRET_B\n");
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
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

test("WorkspaceGitChangesService は Workspace junction の ABA 差し替え中も認可済み repository を読む", async () => {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-junction-aba-"));
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
    const service = new WorkspaceGitChangesService({
      getWorkspaceContext: async () => ({ workspacePath }),
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

    const result = await service.listChanges("session-1");
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.ok(result.entries.some((entry) => entry.relativePath === "only-a.txt"));
      assert.ok(result.entries.every((entry) => entry.relativePath !== "only-b.txt"));
    }
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});
