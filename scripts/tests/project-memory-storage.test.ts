import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { ProjectMemoryStorage } from "../../src-electron/project-memory-storage.js";
import { resolveProjectScope } from "../../src-electron/project-scope.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

function createSession(workspacePath: string) {
  return buildNewSession({
    taskTitle: "Project Memory foundation",
    workspaceLabel: path.basename(workspacePath),
    workspacePath,
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("ProjectMemoryStorage", () => {
  it("git root を優先して project scope を解決して保存できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const repoRoot = path.join(tempDirectory, "repo");
    const nestedWorkspace = path.join(repoRoot, "packages", "app");
    let storage: ProjectMemoryStorage | null = null;

    try {
      await mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await mkdir(nestedWorkspace, { recursive: true });

      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(nestedWorkspace));

      assert.equal(scope.projectType, "git");
      assert.equal(scope.gitRoot?.replace(/\\/g, "/"), repoRoot.replace(/\\/g, "/"));
      assert.equal(scope.projectKey, `git:${repoRoot.replace(/\\/g, "/")}`);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("git remote url がある時は repository 単位の key を優先する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const nestedWorkspace = path.join(repoRoot, "packages", "app");

    try {
      await mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await mkdir(nestedWorkspace, { recursive: true });
      await writeFile(
        path.join(repoRoot, ".git", "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "[remote \"origin\"]",
          "\turl = git@github.com:natumekazuki/WithMate.git",
        ].join("\n"),
      );

      const scope = resolveProjectScope(nestedWorkspace);

      assert.equal(scope.projectType, "git");
      assert.equal(scope.gitRoot?.replace(/\\/g, "/"), repoRoot.replace(/\\/g, "/"));
      assert.equal(scope.gitRemoteUrl, "git@github.com:natumekazuki/WithMate.git");
      assert.equal(scope.projectKey, "git:git@github.com:natumekazuki/WithMate.git");
      assert.equal(scope.displayName, "WithMate");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("worktree の legacy scope は repository key へ移行する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreeRoot = path.join(tempDirectory, "repo-feature");
    const worktreeGitDir = path.join(repoRoot, ".git", "worktrees", "repo-feature");
    let storage: ProjectMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await writeFile(
        path.join(repoRoot, ".git", "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "[remote \"origin\"]",
          "\turl = git@github.com:natumekazuki/WithMate.git",
        ].join("\n"),
      );
      await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir.replace(/\\/g, "/")}\n`);

      sessionStorage = new SessionStorage(dbPath);
      storage = new ProjectMemoryStorage(dbPath);
      const legacyScope = storage.ensureProjectScope({
        projectType: "git",
        projectKey: `git:${worktreeRoot.replace(/\\/g, "/")}`,
        workspacePath: worktreeRoot.replace(/\\/g, "/"),
        gitRoot: worktreeRoot.replace(/\\/g, "/"),
        gitRemoteUrl: null,
        displayName: "repo-feature",
      });
      storage.upsertProjectMemoryEntry({
        projectScopeId: legacyScope.id,
        sourceSessionId: null,
        category: "context",
        title: "worktree migration",
        detail: "legacy key から移行する",
        keywords: [],
        evidence: [],
      });

      const migratedScope = storage.ensureProjectScope(resolveProjectScope(worktreeRoot));

      assert.equal(migratedScope.id, legacyScope.id);
      assert.equal(migratedScope.projectKey, "git:git@github.com:natumekazuki/WithMate.git");
      assert.equal(migratedScope.gitRemoteUrl, "git@github.com:natumekazuki/WithMate.git");
      assert.equal(migratedScope.displayName, "WithMate");
      assert.equal(storage.listProjectMemoryEntries(migratedScope.id).length, 1);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("git root が無い workspace は directory scope として保存する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "scratch");
    let storage: ProjectMemoryStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(workspacePath));

      assert.equal(scope.projectType, "directory");
      assert.equal(scope.gitRoot, null);
      assert.equal(scope.projectKey, `directory:${workspacePath.replace(/\\/g, "/")}`);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("同一 category/title/detail の entry は再利用する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: ProjectMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      sessionStorage = new SessionStorage(dbPath);
      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(workspacePath));

      const first = storage.upsertProjectMemoryEntry({
        projectScopeId: scope.id,
        sourceSessionId: null,
        category: "decision",
        title: "memory の方針",
        detail: "Character Memory は coding plane の prompt に入れない",
        keywords: ["memory", "character"],
        evidence: ["docs/design/memory-architecture.md"],
      });
      const second = storage.upsertProjectMemoryEntry({
        projectScopeId: scope.id,
        sourceSessionId: null,
        category: "decision",
        title: "memory の方針",
        detail: "Character Memory は coding plane の prompt に入れない",
        keywords: ["memory"],
        evidence: [],
      });

      assert.equal(first.id, second.id);
      assert.equal(storage.listProjectMemoryEntries(scope.id).length, 1);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("source_session_id は session 削除時に null へ落ちる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: ProjectMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession(workspacePath));
      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(workspacePath));

      const entry = storage.upsertProjectMemoryEntry({
        projectScopeId: scope.id,
        sourceSessionId: session.id,
        category: "context",
        title: "repo 背景",
        detail: "簡易 workspace でも Project Memory は directory scope で扱う",
        keywords: [],
        evidence: [],
      });

      sessionStorage.deleteSession(session.id);

      const loaded = storage.listProjectMemoryEntries(scope.id).find((candidate) => candidate.id === entry.id);
      assert.ok(loaded);
      assert.equal(loaded.sourceSessionId, null);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("retrieval に使った entry の lastUsedAt を更新できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: ProjectMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      sessionStorage = new SessionStorage(dbPath);
      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(workspacePath));

      const entry = storage.upsertProjectMemoryEntry({
        projectScopeId: scope.id,
        sourceSessionId: null,
        category: "decision",
        title: "memory の方針",
        detail: "Project Memory は retrieval 後に lastUsedAt を更新する",
        keywords: [],
        evidence: [],
      });

      assert.equal(entry.lastUsedAt, null);
      storage.markProjectMemoryEntriesUsed([entry.id]);

      const loaded = storage.listProjectMemoryEntries(scope.id).find((candidate) => candidate.id === entry.id);
      assert.ok(loaded?.lastUsedAt);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("entry 削除時に最後の scope も自動で掃除する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: ProjectMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      sessionStorage = new SessionStorage(dbPath);
      storage = new ProjectMemoryStorage(dbPath);
      const scope = storage.ensureProjectScope(resolveProjectScope(workspacePath));
      const entry = storage.upsertProjectMemoryEntry({
        projectScopeId: scope.id,
        sourceSessionId: null,
        category: "context",
        title: "scope cleanup",
        detail: "最後の entry を消したら scope も掃除する",
        keywords: [],
        evidence: [],
      });

      storage.deleteProjectMemoryEntry(entry.id);

      assert.equal(storage.listProjectScopes().length, 0);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
