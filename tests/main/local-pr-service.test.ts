import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { LocalPrInput, LocalPrResult, LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import { LocalPrService, resolveLocalPrRepository, type LocalPrCoreOperation, type LocalPrStore } from "../../src-electron/local-pr/local-pr-service.js";
import { withPreparedLocalPrRefs } from "../../src-electron/local-pr/local-pr-git.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";

const actor = { kind: "main", sessionId: "review-session", incarnationId: "generation" } as const;
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

/** Runs Git only inside the supplied fixture using local, unsigned commits. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `core.hooksPath=${gitNullDevice}`, ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNullDevice },
  }).trimEnd();
}

/** Narrows a successful response while preserving any unexpected error in the failure message. */
function value<T extends LocalPrCoreOperation>(result: LocalPrResult<T>) {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.data;
}

/** Asserts that a rejection reports its effect as well as a stable reason. */
function rejected(result: LocalPrResult<LocalPrCoreOperation>, code: string, effect = "none") {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.deepEqual([result.code, result.effect], [code, effect], result.message);
}

/** Provides Git, a linked source worktree, and the real storage Worker, all with disposable data. */
async function fixture(t: TestContext, options: { conflict?: boolean; detachedTarget?: boolean } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), "withmate-pr-"));
  const root = path.join(folder, "repo");
  const source = path.join(folder, "source");
  await mkdir(root);
  let worker: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  t.after(async () => {
    await worker?.client.close();
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Local PR Fixture");
  git(root, "config", "user.email", "local-pr@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await writeFile(path.join(root, "deleted.txt"), "remove me\n");
  await writeFile(path.join(root, "old name.txt"), Array.from({ length: 15 }, (_, i) => `line ${i + 1}\n`).join(""));
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", "-qb", "topic", source);
  await rename(path.join(source, "old name.txt"), path.join(source, "new name.txt"));
  const text = await readFile(path.join(source, "new name.txt"), "utf8");
  await writeFile(path.join(source, "new name.txt"), text.replace("line 4\n", "changed line 4\n"));
  await rm(path.join(source, "deleted.txt"));
  await writeFile(path.join(source, "[literal].txt"), "literal name\n");
  await writeFile(path.join(source, "l.txt"), "other file\n");
  if (options.conflict) await writeFile(path.join(source, "base.txt"), "source\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "topic");
  const head = git(source, "rev-parse", "HEAD");
  if (options.conflict) {
    await writeFile(path.join(root, "base.txt"), "target\n");
    git(root, "commit", "-qam", "target");
  }
  if (options.detachedTarget) git(root, "switch", "-qc", "parking");
  const repository = await resolveLocalPrRepository(source);
  const changed: string[] = [];
  const dbPath = path.join(folder, APP_DATABASE_V6_FILENAME);
  let storeOverride: ((store: LocalPrStore) => LocalPrStore) | undefined;
  const service = new LocalPrService({
    getActiveOwner: () => worker ?? null,
    getStore: () => worker ? storeOverride?.(worker.stores.localPr) ?? worker.stores.localPr : null,
    onChanged: (id) => { changed.push(id); },
  });
  const restart = async () => {
    await worker?.client.close();
    worker = createV6StorageWorkerBundle({ dbPath, userDataPath: folder });
    await worker.initialize();
  };
  await restart();
  const execute = <T extends LocalPrCoreOperation>(operation: T, input: LocalPrInput<T>, origin: "agent" | "gui" = "agent") =>
    service.execute(repository, actor, origin, operation, input);
  const create = async (title = "Review fixture") => value<"pr_create">(await execute("pr_create", {
    title, headCommit: head, targetBranch: "refs/heads/main", sourceBranch: "refs/heads/topic",
  }));
  return { root, source, base, head, repository, service, changed, execute, create, restart, override: (fn: typeof storeOverride) => { storeOverride = fn; } };
}

/** Constructs a request for the exact tips shown to the approver. */
function tuple(prId: string, { version, headCommit, targetCommit }: LocalPrVersion) {
  return { prId, version, headCommit, targetCommit };
}

/** Renames, literal metacharacters, missing sides, replies and GUI drafts stay bound to the original pinned version. */
test("Local PR persists fixed comparisons and private drafts across storage restart and Git GC", async (t) => {
  const f = await fixture(t);
  const main = await resolveLocalPrRepository(f.root);
  assert.equal(f.repository.repositoryId, main.repositoryId);
  assert.notEqual(f.repository.root, main.root);
  const pr = await f.create();
  const request = { prId: pr.id, version: 1, mode: "full" } as const;
  const diff = value<"pr_diff">(await f.execute("pr_diff", request));
  assert.deepEqual([diff.beforeCommit, diff.afterCommit], [f.base, f.head]);
  assert.deepEqual(diff.files.find((file) => file.path === "new name.txt"), {
    path: "new name.txt", previousPath: "old name.txt", kind: "renamed",
  });
  const literal = value<"pr_diff">(await f.execute("pr_diff", { ...request, path: "[literal].txt" }));
  assert.match(literal.patch!, /\+literal name/);
  assert.doesNotMatch(literal.patch!, /other file/);
  rejected(await f.execute("pr_diff", { ...request, path: ":(glob)*" }), "FILE_NOT_CHANGED");
  rejected(await f.execute("pr_diff", { ...request, mode: "previous" }), "NO_PREVIOUS_VERSION");
  const line = { mode: "full", path: "new name.txt", side: "before", startLine: 4, endLine: 5 } as const;
  const file = { ...line, startLine: null, endLine: null };
  const published = value<"pr_comment">(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "rename range", anchor: line }));
  const publicBeforeDraft = value<"pr_get">(await f.execute("pr_get", { prId: pr.id }));
  const draft = value<"save_draft">(await f.execute("save_draft", { prId: pr.id, version: 1, body: "private", anchor: file }, "gui"));
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.anchor, file);
  rejected(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "body", replyTo: draft.id }), "REPLY_NOT_FOUND");
  rejected(await f.execute("pr_comment", {
    prId: pr.id, version: 1, body: "invalid side", anchor: { ...file, path: "deleted.txt", side: "after" },
  }), "INVALID_ANCHOR");
  rejected(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "not shown", anchor: { ...line, startLine: 13, endLine: 14 } }), "INVALID_ANCHOR");
  rejected(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "moved reply", replyTo: published.id, anchor: file }), "INVALID_ANCHOR");

  // Remove the only branch pointing at the head, then prune reflogs and loose objects in the fixture.
  git(f.source, "switch", "--detach", f.base);
  git(f.root, "branch", "-D", "topic");
  git(f.root, "reflog", "expire", "--expire=now", "--all");
  git(f.root, "gc", "--prune=now");
  await f.restart();
  const fromMain = value<"pr_get">(await f.service.execute(main, actor, "gui", "pr_get", { prId: pr.id }));
  assert.deepEqual(fromMain.comments.map(({ id }) => id).sort(), [published.id, draft.id].sort());
  const fromAgent = value<"pr_get">(await f.execute("pr_get", { prId: pr.id }));
  assert.deepEqual(fromAgent, publicBeforeDraft);
  assert.deepEqual(value<"pr_diff">(await f.execute("pr_diff", request)), diff);
  const reply = value<"pr_comment">(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "reply", replyTo: published.id }));
  assert.deepEqual(reply.anchor, line);
  rejected(await f.execute("publish_drafts", { prId: pr.id, commentIds: [draft.id, published.id] }, "gui"), "DRAFT_NOT_FOUND");
  assert.equal(value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).comments.length, 2);
  assert.equal(value<"publish_drafts">(await f.execute("publish_drafts", { prId: pr.id, commentIds: [draft.id] }, "gui")).comments[0].draft, false);
  rejected(await f.execute("discard_draft", { prId: pr.id, commentId: draft.id }, "gui"), "DRAFT_NOT_FOUND");
  assert.ok(f.changed.every((id) => id === f.repository.repositoryId));
});

/** Fresh GUI approval is required even for a target-only resubmission; checked-out merges update real files as well as refs. */
test("Local PR rejects stale approval, dirty or locked checkout, and merges cleanly without CI", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const v1 = tuple(pr.id, pr.versions[0]);
  const oldComment = value<"pr_comment">(await f.execute("pr_comment", { prId: pr.id, version: 1, body: "First review" }));
  rejected(await f.execute("approve", v1), "GUI_REQUIRED");
  rejected(await f.execute("revoke", v1), "GUI_REQUIRED");
  rejected(await f.execute("pr_merge", v1), "APPROVAL_REQUIRED");
  value(await f.execute("approve", v1, "gui"));
  await writeFile(path.join(f.root, "target.txt"), "target advance\n");
  git(f.root, "add", "target.txt");
  git(f.root, "commit", "-qm", "target advances");
  const target = git(f.root, "rev-parse", "HEAD");
  rejected(await f.execute("pr_merge", v1), "TARGET_CHANGED");
  const submitted = value<"pr_submit">(await f.execute("pr_submit", { prId: pr.id, expectedVersion: 1, headCommit: f.head, expectedTargetCommit: target }));
  assert.equal(submitted.latestVersion, 2);
  assert.equal(submitted.approval, null);
  assert.equal(submitted.versions[1].mergeBaseCommit, f.base);
  const increment = value<"pr_diff">(await f.execute("pr_diff", { prId: pr.id, version: 2, mode: "previous" }));
  assert.deepEqual(increment, { beforeCommit: f.head, afterCommit: f.head, files: [], patch: null });
  const v2 = tuple(pr.id, submitted.versions[1]);
  rejected(await f.execute("pr_comment", { prId: pr.id, version: 2, body: "wrong version", replyTo: oldComment.id }), "REPLY_NOT_FOUND");
  rejected(await f.execute("approve", v1, "gui"), "VERSION_CHANGED");
  value(await f.execute("approve", v2, "gui"));
  value(await f.execute("revoke", v2, "gui"));
  rejected(await f.execute("pr_merge", v2), "APPROVAL_REQUIRED");
  value(await f.execute("approve", v2, "gui"));

  const dirty = path.join(f.root, "base.txt");
  await writeFile(dirty, "unsaved edit\n");
  rejected(await f.execute("pr_merge", v2), "WORKTREE_DIRTY");
  assert.equal(await readFile(dirty, "utf8"), "unsaved edit\n");
  await writeFile(dirty, "base\n");
  const ignored = path.join(f.root, "l.txt");
  await writeFile(path.join(f.root, ".git", "info", "exclude"), "l.txt\n");
  await writeFile(ignored, "ignored user content\n");
  rejected(await f.execute("pr_merge", v2), "WORKTREE_DIRTY");
  assert.equal(await readFile(ignored, "utf8"), "ignored user content\n");
  await rm(ignored);
  const indexLock = path.join(f.root, ".git", "index.lock");
  await writeFile(indexLock, "another Git command");
  rejected(await f.execute("pr_merge", v2), "GIT_FAILED");
  assert.equal(await readFile(indexLock, "utf8"), "another Git command");
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  await rm(indexLock);

  // The app must not execute a repository's external checkout program on behalf of an Agent.
  git(f.root, "config", "filter.fixture.smudge", "false");
  const attributes = path.join(f.root, ".git", "info", "attributes");
  await writeFile(attributes, "l.txt filter=fixture\n");
  rejected(await f.execute("pr_merge", v2), "UNSUPPORTED_WORKTREE");
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  await rm(attributes);

  const merged = value<"pr_merge">(await f.execute("pr_merge", v2));
  assert.equal(merged.state, "merged");
  assert.equal(git(f.root, "rev-parse", "HEAD"), merged.mergedCommit);
  assert.equal(git(f.root, "show", "-s", "--format=%P", "HEAD"), `${target} ${f.head}`);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.root, "l.txt"), "utf8"), "other file\n");
  await f.restart();
  assert.equal(value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).mergedCommit, merged.mergedCommit);
});

/** Unattached branches are advanced under worktree HEAD checks, without modifying unrelated user work. */
test("Local PR merges an unattached target without changing an unrelated checkout", async (t) => {
  const f = await fixture(t, { detachedTarget: true });
  const pr = await f.create();
  git(f.source, "switch", "--detach", f.head);
  await writeFile(path.join(f.root, "base.txt"), "unrelated work\n");
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  const merged = value<"pr_merge">(await f.execute("pr_merge", approved));
  assert.equal(git(f.root, "rev-parse", "refs/heads/main"), merged.mergedCommit);
  assert.equal(git(f.root, "symbolic-ref", "HEAD"), "refs/heads/parking");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.equal(await readFile(path.join(f.root, "base.txt"), "utf8"), "unrelated work\n");
});

/** Conflict detection produces no ref, index or worktree update. */
test("Local PR does not treat a Git merge conflict as a merged PR", async (t) => {
  const f = await fixture(t, { conflict: true });
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  rejected(await f.execute("pr_merge", approved), "MERGE_CONFLICT");
  assert.equal(git(f.root, "rev-parse", "HEAD"), approved.targetCommit);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.root, "base.txt"), "utf8"), "target\n");
  assert.equal(value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state, "open");
});

/** The production ref transaction acquires both locks and aborts without updating Git on guard failure. */
test("a prepared Git HEAD update holds both locks and aborts if the guarded operation rejects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(withPreparedLocalPrRefs(f.root, [`update HEAD ${f.head} ${f.base}`], async (_commit, assertHeld) => {
    assertHeld();
    assert.equal(git(f.root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.throws(() => git(f.root, "symbolic-ref", "HEAD", "refs/heads/topic"), /lock/u);
    assert.throws(() => git(f.source, "update-ref", "refs/heads/main", f.head, f.base), /lock/u);
    throw new Error("reject operation");
  }), /reject operation/u);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  git(f.root, "branch", "abort-released", f.base);
});

/** If a real Git failure interrupts ref commit after checkout, never report success or run an unguarded rollback. */
test("Local PR preserves the observed worktree and reports unknown when Git cannot commit the ref", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  const reflog = path.join(f.root, ".git", "logs", "refs", "heads", "main");
  await rename(reflog, reflog + ".saved");
  await mkdir(reflog);
  await writeFile(path.join(reflog, "blocker"), "occupied\n");
  rejected(await f.execute("pr_merge", approved), "MERGE_EFFECT_UNKNOWN", "unknown");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.equal(await readFile(path.join(f.root, "l.txt"), "utf8"), "other file\n");
  assert.equal(await readFile(path.join(reflog, "blocker"), "utf8"), "occupied\n");
  assert.equal(value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state, "open");
});

/** A disconnected save after ref commit is not retried blindly or reported as a clean rejection. */
test("Local PR reports an uncertain overall effect when Git succeeds but review persistence does not", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  f.override((store) => ({
    listLocalPrs: store.listLocalPrs,
    readLocalPr: store.readLocalPr,
    createLocalPr: store.createLocalPr,
    saveLocalPr: async () => { throw new Error("test store disconnect"); },
  }));
  rejected(await f.execute("pr_merge", approved), "MERGE_EFFECT_UNKNOWN", "unknown");
  const branch = git(f.root, "rev-parse", "HEAD");
  assert.notEqual(branch, f.base);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  f.override(undefined);
  const observed = value<"pr_get">(await f.execute("pr_get", { prId: pr.id }));
  assert.equal(observed.state, "open");
  assert.equal(observed.currentTargetCommit, branch);
  rejected(await f.execute("pr_merge", approved), "TARGET_CHANGED");
});
