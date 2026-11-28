import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  LocalPrInput,
  LocalPrOperation,
  LocalPrResult,
  LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { formatMarkdownImageReference } from "../../src-shared/files/composer-image-reference.js";
import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { LocalPrApplication } from "../../src-electron/local-pr/local-pr-application.js";
import { enqueueLocalPrDiscussion } from "../../src-electron/local-pr/local-pr-session-bridge.js";
import {
  LocalPrService,
  resolveLocalPrRepository,
  type LocalPrCoreOperation,
  type LocalPrStore,
} from "../../src-electron/local-pr/local-pr-service.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";

const actor = {
  kind: "main",
  sessionId: "review-session",
  incarnationId: "generation",
} as const;
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

/** 指定された fixture の内部だけで Git を実行し、ローカルの署名なしコミットを使う。 */
function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", `core.hooksPath=${gitNullDevice}`, ...args],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitNullDevice,
      },
    },
  ).trimEnd();
}

/** 成功レスポンスに型を絞り込み、予期しないエラーは失敗メッセージに残す。 */
function value<T extends LocalPrCoreOperation>(result: LocalPrResult<T>) {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.data;
}

/** 拒否応答に安定した理由と処理の効果の両方が含まれることを確認する。 */
function rejected(
  result: LocalPrResult<LocalPrCoreOperation>,
  code: string,
  effect = "none",
) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok)
    assert.deepEqual(
      [result.code, result.effect],
      [code, effect],
      result.message,
    );
}

/** 使い捨てのデータで Git、リンクされたソース worktree、実際のストレージ Worker を用意する。 */
async function fixture(
  t: TestContext,
  options: { conflict?: boolean; detachedTarget?: boolean } = {},
) {
  const folder = await mkdtemp(path.join(tmpdir(), "withmate-pr-"));
  const root = path.join(folder, "repo");
  const source = path.join(folder, "source");
  await mkdir(root);
  let worker: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  /** 一時リポジトリを削除する前に、実 SQLite を所有する Worker を閉じる。 */
  t.after(async () => {
    await worker?.client.close();
    await rm(folder, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Local PR Fixture");
  git(root, "config", "user.email", "local-pr@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await writeFile(path.join(root, "deleted.txt"), "remove me\n");
  await writeFile(
    path.join(root, "old name.txt"),
    Array.from({ length: 15 }, (_, i) => `line ${i + 1}\n`).join(""),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", "-qb", "topic", source);
  await rename(
    path.join(source, "old name.txt"),
    path.join(source, "new name.txt"),
  );
  const text = await readFile(path.join(source, "new name.txt"), "utf8");
  await writeFile(
    path.join(source, "new name.txt"),
    text.replace("line 4\n", "changed line 4\n"),
  );
  await rm(path.join(source, "deleted.txt"));
  await writeFile(path.join(source, "[literal].txt"), "literal name\n");
  await writeFile(path.join(source, "l.txt"), "other file\n");
  if (options.conflict)
    await writeFile(path.join(source, "base.txt"), "source\n");
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
    /** 再起動後もその時点の Worker を現在の実行所有者として返す。 */
    getActiveOwner: () => worker ?? null,
    /** 実ストアを既定とし、障害を再現するケースでは差し替えを許す。 */
    getStore: () =>
      worker
        ? (storeOverride?.(worker.stores.localPr) ?? worker.stores.localPr)
        : null,
    /** 変更通知が届いたリポジトリの識別子を保存する。 */
    onChanged: (id) => {
      changed.push(id);
    },
  });
  /** 同じ一時 DB を新しい Worker で開き、永続化を再起動越しに確認できるようにする。 */
  const restart = async () => {
    await worker?.client.close();
    worker = createV6StorageWorkerBundle({ dbPath, userDataPath: folder });
    await worker.initialize();
  };
  await restart();
  /** 同じリポジトリと呼び出し元で、操作ごとに型付けされた要求を送る。 */
  const execute = <T extends LocalPrCoreOperation>(
    operation: T,
    input: LocalPrInput<T>,
    origin: "agent" | "gui" = "agent",
  ) => service.execute(repository, actor, origin, operation, input);
  /** 固定した topic の先端をもとに、main 向けの新しいローカル PR を起票する。 */
  const create = async (title = "Review fixture") =>
    value<"pr_create">(
      await execute("pr_create", {
        title,
        headCommit: head,
        targetBranch: "refs/heads/main",
        sourceBranch: "refs/heads/topic",
      }),
    );
  return {
    root,
    source,
    base,
    head,
    repository,
    service,
    changed,
    execute,
    create,
    restart,
    /** 現在の Worker のストアを直接参照して、受付や再起動後の保存結果を検査する。 */
    get stores() {
      return worker!.stores;
    },
    /** 指定ケースだけ実ストアを包み、障害解除時に元の経路に戻す。 */
    override: (fn: typeof storeOverride) => {
      storeOverride = fn;
    },
  };
}

/** 承認者に提示した正確な先端コミットを指定する要求を組み立てる。 */
function tuple(
  prId: string,
  { version, headCommit, targetCommit }: LocalPrVersion,
) {
  return { prId, version, headCommit, targetCommit };
}

/** レビューで示した固定行と返信の関連を保存し、同じ PR の再提出を新しい版として扱う。 */
test("Local PR review exposes the selected fixed range, reply, and resubmission on the same PR", async (t) => {
  const f = await fixture(t);
  const { repository } = f;
  const receivingSession = await f.stores.session.insertSession({
    ...buildNewSession({
      id: "fixer",
      taskTitle: "Review Agent",
      workspaceLabel: "Review Fixture",
      workspacePath: f.source,
      branch: "topic",
      characterId: "fixture",
      character: "Fixture",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: "on-request",
    }),
    model: "fixture-model",
    reasoningEffort: "high",
  });
  const recipient = {
    kind: "main",
    sessionId: receivingSession.id,
    incarnationId: getSessionIncarnationId(receivingSession),
  } as const;
  const store = f.stores.queue;
  const queueService = new SessionTurnQueueService({
    store,
    /** セッションを実行中として、送信を開始せずキューに留める。 */
    isRunInFlight: () => true,
    /** この経路は相談のキュー受付までなので、実際のプロバイダー実行を拒否する。 */
    dispatch: async () => {
      throw new Error(
        "The fixture verifies queue acceptance without making a provider request.",
      );
    },
  });
  /** テストを抜ける際はキューの待機処理も終了する。 */
  t.after(() => queueService.close());
  const queue = new MainSessionTurnQueueFacade({
    store,
    service: queueService,
    /** 停止済みのアプリ状態ではなく、稼働中の受付を想定する。 */
    assertActive() {},
    /** 受付自体は許可し、保存したキュー項目を観測できるようにする。 */
    assertAccepting() {},
    /** 宛先情報を現在の Worker の実セッション保存先から取得する。 */
    getSession: (id) => f.stores.session.getSession(id),
    /** テストが本番利用者の設定に依存しないよう既定設定を返す。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** 受付に使うセッションが起票側の worktree を参照していることを確認する。 */
    validateWorkspace: async (session) => {
      assert.equal(session.workspacePath, f.source);
    },
    /** 実通信せず、宛先セッションで選択済みのモデルを有効として返す。 */
    validateProvider: async () => ({
      provider: {
        id: "codex",
        label: "Codex",
        defaultModelId: receivingSession.model,
        defaultReasoningEffort: receivingSession.reasoningEffort,
        models: [
          {
            id: receivingSession.model,
            label: "Fixture Model",
            reasoningEfforts: [receivingSession.reasoningEffort],
          },
        ],
      },
    }),
    /** 画像や文面の配送を観測するケースのため、添付解析失敗は注入しない。 */
    preview: async () => ({ errors: [], attachments: [] }),
  });
  const app = new LocalPrApplication<typeof repository>({
    /** アプリケーションからの主要操作をテスト用 Git と実ストレージを持つサービスへ渡す。 */
    core: (repo, caller, origin, operation, input) =>
      f.service.execute(repo, caller, origin, operation, input),
    /** レビュー相談には CI を要求しないため、起動されたら失敗させる。 */
    ci: async () => {
      throw new Error("This review does not run CI.");
    },
    /** 相談先として同じ incarnation の受信セッションだけを提示する。 */
    sessionChoices: async () => ({
      ok: true,
      data: {
        sessions: [{ target: recipient, title: "Review Agent" }],
        hasMore: false,
      },
    }),
    /** 相談先の identity と PR の所属リポジトリがともに一致することを確認する。 */
    assertDiscussionTarget: async (target, ownerRepository) => {
      assert.deepEqual(target, recipient);
      assert.equal(ownerRepository.repositoryId, repository.repositoryId);
    },
    /** 生成したレビュー相談を、宛先を再確認しながら実際のキューへ登録する。 */
    sendDiscussion: (request, message, assertCurrent) =>
      enqueueLocalPrDiscussion(
        queue,
        request,
        message,
        (target) => f.stores.session.getSession(target.sessionId),
        assertCurrent,
      ),
  });
  /** 同じリポジトリで、GUI とエージェントの呼び出し元を切り替えて操作する。 */
  const execute = <T extends LocalPrOperation>(
    session: typeof actor | typeof recipient,
    origin: "gui" | "agent",
    operation: T,
    input: LocalPrInput<T>,
  ) =>
    app.execute(repository, session, origin, operation, input, () => undefined);
  const description = `## What changed\n\n${formatMarkdownImageReference(path.join(f.root, "Design Notes.png"))}`;
  const created = await execute(recipient, "agent", "pr_create", {
    title: "Review with screenshots",
    description,
    targetBranch: "refs/heads/main",
    sourceBranch: "refs/heads/topic",
    headCommit: f.head,
  });
  assert.ok(created.ok);
  const { id: prId } = created.data;
  const anchor = {
    mode: "full",
    path: "new name.txt",
    side: "before",
    startLine: 4,
    endLine: 5,
  } as const;
  const saved = await execute(actor, "gui", "save_draft", {
    prId,
    version: 1,
    anchor,
    body: "Cover this failure case.",
  });
  assert.ok(saved.ok);
  assert.equal(saved.data.draft, true);
  const request = {
    prId,
    version: 1,
    target: recipient,
    commentIds: [saved.data.id],
    message: "Please fix and resubmit.",
    requestId: "131cd4f2-3be4-4151-a256-c80df17145f0",
  };
  const sent = await execute(actor, "gui", "discuss", request);
  assert.ok(sent.ok, JSON.stringify(sent));
  const owner = {
    sessionId: recipient.sessionId,
    incarnationId: recipient.incarnationId,
  };
  const receipt = await store.getReceipt(owner, request.requestId);
  assert.equal(receipt?.id, sent.data.receiptId);
  assert.equal(receipt?.state, "queued");
  assert.equal(receipt?.accepted?.origin?.kind, "gui");
  assert.deepEqual(await execute(actor, "gui", "discuss", request), sent);
  assert.equal((await store.listActive(owner)).length, 1);
  const message = receipt?.accepted?.request.userMessage ?? "";
  assert.match(message, new RegExp(`^headCommit: "${f.head}"$`, "m"));
  for (const [key, expected] of Object.entries(anchor)) {
    assert.ok(
      message.split("\n").includes(`${key}: ${JSON.stringify(expected)}`),
      key,
    );
  }
  const lines = Array.from(
    message.matchAll(/^- Line (\d+): (.+)$/gm),
    (match) => ({ line: Number(match[1]), text: JSON.parse(match[2]) }),
  );
  assert.deepEqual(
    lines,
    [2, 3, 4, 5, 6, 7].map((line) => ({ line, text: `line ${line}` })),
  );
  const reply = await execute(recipient, "agent", "pr_comment", {
    prId,
    version: 1,
    replyTo: saved.data.id,
    body: "Test added; submitting a new version.",
  });
  assert.ok(reply.ok);
  assert.deepEqual(reply.data.author, recipient);
  assert.deepEqual(reply.data.anchor, anchor);
  await writeFile(path.join(f.source, "l.txt"), "Regression test on retry\n");
  git(f.source, "commit", "-qam", "Cover failure and retry");
  const newHead = git(f.source, "rev-parse", "HEAD");
  const submitted = await execute(recipient, "agent", "pr_submit", {
    prId,
    expectedVersion: 1,
    headCommit: newHead,
    expectedTargetCommit: f.base,
  });
  assert.ok(submitted.ok);
  const pins = tuple(
    prId,
    submitted.data.versions.find((v) => v.version === 2)!,
  );
  assert.deepEqual(pins, {
    prId,
    version: 2,
    headCommit: newHead,
    targetCommit: f.base,
  });
  assert.equal(submitted.data.approval, null);
  rejected(await execute(recipient, "agent", "approve", pins), "PR_FORBIDDEN");
  assert.ok((await execute(actor, "gui", "approve", pins)).ok);
  await queueService.close();
  await f.restart();
  assert.equal(
    (await f.stores.queue.getReceipt(owner, request.requestId))?.id,
    sent.data.receiptId,
  );
  const result = value<"pr_get">(await f.execute("pr_get", { prId }, "gui"));
  assert.equal(result.description, description);
  assert.equal(result.approval?.headCommit, newHead);
  assert.equal(
    result.comments.find((comment) => comment.id === saved.data.id)?.draft,
    false,
  );
  assert.equal(
    result.comments.find((comment) => comment.id === reply.data.id)?.replyTo,
    saved.data.id,
  );
});

/** 名前変更、文字どおりのメタ文字、片側の欠落、返信、GUI の下書きは、最初に固定した比較版にひも付き続ける。 */
test("Local PR persists fixed comparisons and private drafts across storage restart and Git GC", async (t) => {
  const f = await fixture(t);
  const main = await resolveLocalPrRepository(f.root);
  assert.equal(f.repository.repositoryId, main.repositoryId);
  assert.notEqual(f.repository.root, main.root);
  const pr = await f.create();
  const request = { prId: pr.id, version: 1, mode: "full" } as const;
  const diff = value<"pr_diff">(await f.execute("pr_diff", request));
  assert.deepEqual([diff.beforeCommit, diff.afterCommit], [f.base, f.head]);
  assert.deepEqual(
    diff.files.find((file) => file.path === "new name.txt"),
    {
      path: "new name.txt",
      previousPath: "old name.txt",
      kind: "renamed",
    },
  );
  const literal = value<"pr_diff">(
    await f.execute("pr_diff", { ...request, path: "[literal].txt" }),
  );
  assert.match(literal.patch!, /\+literal name/);
  assert.doesNotMatch(literal.patch!, /other file/);
  rejected(
    await f.execute("pr_diff", { ...request, path: ":(glob)*" }),
    "FILE_NOT_CHANGED",
  );
  rejected(
    await f.execute("pr_diff", { ...request, mode: "previous" }),
    "NO_PREVIOUS_VERSION",
  );
  const line = {
    mode: "full",
    path: "new name.txt",
    side: "before",
    startLine: 4,
    endLine: 5,
  } as const;
  const file = { ...line, startLine: null, endLine: null };
  const published = value<"pr_comment">(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "rename range",
      anchor: line,
    }),
  );
  const publicBeforeDraft = value<"pr_get">(
    await f.execute("pr_get", { prId: pr.id }),
  );
  const draft = value<"save_draft">(
    await f.execute(
      "save_draft",
      { prId: pr.id, version: 1, body: "private", anchor: file },
      "gui",
    ),
  );
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.anchor, file);
  rejected(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "body",
      replyTo: draft.id,
    }),
    "REPLY_NOT_FOUND",
  );
  rejected(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "invalid side",
      anchor: { ...file, path: "deleted.txt", side: "after" },
    }),
    "INVALID_ANCHOR",
  );
  rejected(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "not shown",
      anchor: { ...line, startLine: 13, endLine: 14 },
    }),
    "INVALID_ANCHOR",
  );
  rejected(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "moved reply",
      replyTo: published.id,
      anchor: file,
    }),
    "INVALID_ANCHOR",
  );

  // fixture 内でソース側の先端コミットを指す唯一のブランチを削除し、reflog と loose object を整理する。
  git(f.source, "switch", "--detach", f.base);
  git(f.root, "branch", "-D", "topic");
  git(f.root, "reflog", "expire", "--expire=now", "--all");
  git(f.root, "gc", "--prune=now");
  await f.restart();
  const fromMain = value<"pr_get">(
    await f.service.execute(main, actor, "gui", "pr_get", { prId: pr.id }),
  );
  assert.deepEqual(
    fromMain.comments.map(({ id }) => id).sort(),
    [published.id, draft.id].sort(),
  );
  const fromAgent = value<"pr_get">(await f.execute("pr_get", { prId: pr.id }));
  assert.deepEqual(fromAgent, publicBeforeDraft);
  assert.deepEqual(value<"pr_diff">(await f.execute("pr_diff", request)), diff);
  const reply = value<"pr_comment">(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "reply",
      replyTo: published.id,
    }),
  );
  assert.deepEqual(reply.anchor, line);
  rejected(
    await f.execute(
      "publish_drafts",
      { prId: pr.id, commentIds: [draft.id, published.id] },
      "gui",
    ),
    "DRAFT_NOT_FOUND",
  );
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).comments.length,
    2,
  );
  assert.equal(
    value<"publish_drafts">(
      await f.execute(
        "publish_drafts",
        { prId: pr.id, commentIds: [draft.id] },
        "gui",
      ),
    ).comments[0].draft,
    false,
  );
  rejected(
    await f.execute(
      "discard_draft",
      { prId: pr.id, commentId: draft.id },
      "gui",
    ),
    "DRAFT_NOT_FOUND",
  );
  assert.ok(f.changed.every((id) => id === f.repository.repositoryId));
});

/** 承認は正確なソースとターゲットにひも付き、追跡対象に未コミットの編集がある間はネイティブ Git を起動しない。 */
test("Local PR rejects stale approval, dirty or locked checkout, and merges cleanly without CI", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const v1 = tuple(pr.id, pr.versions[0]);
  const oldComment = value<"pr_comment">(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 1,
      body: "First review",
    }),
  );
  rejected(await f.execute("approve", v1), "GUI_REQUIRED");
  rejected(await f.execute("revoke", v1), "GUI_REQUIRED");
  rejected(await f.execute("pr_merge", v1), "APPROVAL_REQUIRED");
  value(await f.execute("approve", v1, "gui"));
  await writeFile(path.join(f.root, "target.txt"), "target advance\n");
  git(f.root, "add", "target.txt");
  git(f.root, "commit", "-qm", "target advances");
  const target = git(f.root, "rev-parse", "HEAD");
  rejected(await f.execute("pr_merge", v1), "TARGET_CHANGED");
  const submitted = value<"pr_submit">(
    await f.execute("pr_submit", {
      prId: pr.id,
      expectedVersion: 1,
      headCommit: f.head,
      expectedTargetCommit: target,
    }),
  );
  assert.equal(submitted.latestVersion, 2);
  assert.equal(submitted.approval, null);
  assert.equal(submitted.versions[1].mergeBaseCommit, f.base);
  const increment = value<"pr_diff">(
    await f.execute("pr_diff", { prId: pr.id, version: 2, mode: "previous" }),
  );
  assert.deepEqual(increment, {
    beforeCommit: f.head,
    afterCommit: f.head,
    files: [],
    patch: null,
  });
  const v2 = tuple(pr.id, submitted.versions[1]);
  rejected(
    await f.execute("pr_comment", {
      prId: pr.id,
      version: 2,
      body: "wrong version",
      replyTo: oldComment.id,
    }),
    "REPLY_NOT_FOUND",
  );
  rejected(await f.execute("approve", v1, "gui"), "VERSION_CHANGED");
  value(await f.execute("approve", v2, "gui"));
  value(await f.execute("revoke", v2, "gui"));
  rejected(await f.execute("pr_merge", v2), "APPROVAL_REQUIRED");
  value(await f.execute("approve", v2, "gui"));

  const dirty = path.join(f.root, "base.txt");
  await writeFile(dirty, "unsaved edit\n");
  rejected(await f.execute("pr_merge", v2), "WORKTREE_DIRTY", "unknown");
  assert.equal(await readFile(dirty, "utf8"), "unsaved edit\n");
  git(f.root, "add", "base.txt");
  rejected(await f.execute("pr_merge", v2), "WORKTREE_DIRTY", "unknown");
  assert.equal(git(f.root, "show", ":base.txt"), "unsaved edit");
  await writeFile(dirty, "base\n");
  git(f.root, "add", "base.txt");
  const missing = path.join(f.root, "old name.txt");
  const contents = await readFile(missing);
  const index = await readFile(path.join(f.root, ".git", "index"));
  await rm(missing);
  rejected(await f.execute("pr_merge", v2), "WORKTREE_DIRTY", "unknown");
  await assert.rejects(readFile(missing), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(f.root, ".git", "index")), index);
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  await writeFile(missing, contents);
  const indexLock = path.join(f.root, ".git", "index.lock");
  await writeFile(indexLock, "another Git command");
  rejected(await f.execute("pr_merge", v2), "GIT_FAILED", "unknown");
  assert.equal(await readFile(indexLock, "utf8"), "another Git command");
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  await rm(indexLock);

  // 衝突する未追跡ファイルは Git に拒否させ、無関係な未追跡の作業は維持する。
  const untracked = path.join(f.root, "l.txt");
  await writeFile(untracked, "untracked user content\n");
  rejected(await f.execute("pr_merge", v2), "GIT_FAILED", "unknown");
  assert.equal(await readFile(untracked, "utf8"), "untracked user content\n");
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  await rm(untracked);
  await writeFile(path.join(f.root, "scratch.txt"), "unrelated draft\n");
  // 対策がなければ、Git は明示的に要求した `ort` より先にこの戦略を試す。
  git(f.root, "config", "branch.main.mergeOptions", "-s ours");

  // ソースブランチが進んでも、ユーザーがレビューしたコミットを置き換えてはならない。
  await writeFile(path.join(f.source, "not-submitted.txt"), "moving branch\n");
  git(f.source, "add", "not-submitted.txt");
  git(f.source, "commit", "-qm", "not part of this PR version");
  const merged = value<"pr_merge">(await f.execute("pr_merge", v2));
  assert.equal(merged.state, "merged");
  assert.equal(git(f.root, "rev-parse", "HEAD"), merged.mergedCommit);
  assert.equal(
    git(f.root, "show", "-s", "--format=%P", "HEAD"),
    `${target} ${f.head}`,
  );
  assert.equal(git(f.root, "status", "--porcelain"), "?? scratch.txt");
  assert.equal(
    await readFile(path.join(f.root, "scratch.txt"), "utf8"),
    "unrelated draft\n",
  );
  assert.equal(
    await readFile(path.join(f.root, "l.txt"), "utf8"),
    "other file\n",
  );
  await assert.rejects(readFile(path.join(f.root, "not-submitted.txt")), {
    code: "ENOENT",
  });
  await f.restart();
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).mergedCommit,
    merged.mergedCommit,
  );
});

/** 照合済みの GUI 承認があれば、Git が選んだプログラムを実行でき、使われない設定を理由に拒否しない。 */
test("Local PR uses the checkout's Git driver and filter only after approval", async (t) => {
  const f = await fixture(t, { conflict: true });
  const target = git(f.root, "rev-parse", "HEAD");
  const driverLog = path.join(f.root, "driver-ran.txt");
  const filterLog = path.join(f.root, "filter-ran.txt");
  const unusedLog = path.join(f.root, "unused-program-ran.txt");
  await writeFile(
    path.join(f.root, ".git", "info", "attributes"),
    "base.txt merge=fixture\nl.txt filter=fixture\n",
  );
  git(
    f.root,
    "config",
    "merge.fixture.driver",
    "echo driver > driver-ran.txt; cp -- %B %A",
  );
  git(f.root, "config", "filter.fixture.clean", "cat");
  git(
    f.root,
    "config",
    "filter.fixture.smudge",
    "echo filter > filter-ran.txt; cat",
  );
  git(f.root, "config", "filter.fixture.required", "true");
  git(
    f.root,
    "config",
    "merge.unused.driver",
    "echo unused > unused-program-ran.txt",
  );
  git(
    f.root,
    "config",
    "filter.unused.smudge",
    "echo unused > unused-program-ran.txt; cat",
  );
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);

  // エージェントは自ら承認できず、GUI 承認より前に選択されたプログラムを実行させることもできない。
  rejected(await f.execute("approve", approved, "agent"), "GUI_REQUIRED");
  rejected(await f.execute("pr_merge", approved, "agent"), "APPROVAL_REQUIRED");
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  for (const file of [driverLog, filterLog, unusedLog])
    await assert.rejects(readFile(file), { code: "ENOENT" });
  value(await f.execute("approve", approved, "gui"));
  for (const file of [driverLog, filterLog])
    await assert.rejects(readFile(file), { code: "ENOENT" });

  const merged = value<"pr_merge">(
    await f.execute("pr_merge", approved, "agent"),
  );
  assert.equal(merged.state, "merged");
  assert.equal(merged.mergedCommit, git(f.root, "rev-parse", "HEAD"));
  assert.equal(
    git(f.root, "show", "-s", "--format=%P", "HEAD"),
    `${target} ${f.head}`,
  );
  assert.equal(git(f.root, "show", "HEAD:base.txt"), "source");
  assert.equal(
    await readFile(path.join(f.root, "l.txt"), "utf8"),
    "other file\n",
  );
  assert.match(await readFile(driverLog, "utf8"), /^driver\r?\n$/u);
  assert.match(await readFile(filterLog, "utf8"), /^filter\r?\n$/u);
  await assert.rejects(readFile(unusedLog), { code: "ENOENT" });
  await f.restart();
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).mergedCommit,
    merged.mergedCommit,
  );
});

/** Git がマージを開始しなくても、worktree の検査中に clean フィルターが動く場合がある。 */
test("Local PR reports possible filter effects when the target checkout is dirty", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, ".git", "info", "attributes"),
    "base.txt filter=fixture\n",
  );
  git(
    f.root,
    "config",
    "filter.fixture.clean",
    "echo filter-ran > deleted.txt; cat",
  );
  await writeFile(path.join(f.root, "base.txt"), "edit\n");
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  rejected(await f.execute("pr_merge", approved), "APPROVAL_REQUIRED");
  assert.equal(
    await readFile(path.join(f.root, "deleted.txt"), "utf8"),
    "remove me\n",
  );

  value(await f.execute("approve", approved, "gui"));
  rejected(await f.execute("pr_merge", approved), "WORKTREE_DIRTY", "unknown");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.equal(git(f.root, "show", ":deleted.txt"), "remove me");
  assert.equal(await readFile(path.join(f.root, "base.txt"), "utf8"), "edit\n");
  assert.match(
    await readFile(path.join(f.root, "deleted.txt"), "utf8"),
    /^filter-ran\r?\n$/u,
  );
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state,
    "open",
  );
});

/** アプリは必要に応じてチェックアウトを求め、その後は他の作業を変更せず、選ばれたリンク先 worktree を使う。 */
test("Local PR requires a manual checkout, then merges in the linked worktree", async (t) => {
  const f = await fixture(t, { detachedTarget: true });
  const pr = await f.create();
  await writeFile(path.join(f.root, "base.txt"), "unrelated work\n");
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  rejected(await f.execute("pr_merge", approved), "TARGET_NOT_CHECKED_OUT");
  assert.equal(git(f.root, "rev-parse", "refs/heads/main"), f.base);
  git(f.source, "switch", "main");
  const workspace = await resolveLocalPrRepository(f.root);
  const merged = value<"pr_merge">(
    await f.service.execute(workspace, actor, "agent", "pr_merge", approved),
  );
  assert.equal(
    git(f.root, "rev-parse", "refs/heads/main"),
    merged.mergedCommit,
  );
  assert.equal(git(f.source, "rev-parse", "HEAD"), merged.mergedCommit);
  assert.equal(
    await readFile(path.join(f.source, "l.txt"), "utf8"),
    "other file\n",
  );
  assert.equal(git(f.root, "symbolic-ref", "HEAD"), "refs/heads/parking");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.equal(
    await readFile(path.join(f.root, "base.txt"), "utf8"),
    "unrelated work\n",
  );
});

/** Git はブランチ名の `=` を許容する。この場合も `branch.mergeOptions` ではなく通常の戦略を使う必要がある。 */
test("Local PR applies the submitted files to a branch whose name contains equals", async (t) => {
  const f = await fixture(t);
  const branch = "release=stable";
  git(f.root, "branch", "-m", branch);
  git(f.root, "config", `branch.${branch}.mergeOptions`, "-s ours");
  const pr = value<"pr_create">(
    await f.execute("pr_create", {
      title: "Release",
      targetBranch: `refs/heads/${branch}`,
      headCommit: f.head,
    }),
  );
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  const merged = value<"pr_merge">(await f.execute("pr_merge", approved));
  assert.equal(merged.state, "merged");
  assert.equal(
    git(f.root, "show", "-s", "--format=%P", "HEAD"),
    `${f.base} ${f.head}`,
  );
  assert.equal(
    await readFile(path.join(f.root, "l.txt"), "utf8"),
    "other file\n",
  );
  assert.equal(
    git(f.root, "config", `branch.${branch}.mergeOptions`),
    "-s ours",
  );
});

/** PR をマージ済みにせず、Git の競合をユーザーが解消できるよう残す。 */
test("Local PR does not treat a Git merge conflict as a merged PR", async (t) => {
  const f = await fixture(t, { conflict: true });
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  rejected(await f.execute("pr_merge", approved), "MERGE_CONFLICT", "unknown");
  assert.equal(git(f.root, "rev-parse", "HEAD"), approved.targetCommit);
  assert.equal(git(f.root, "rev-parse", "MERGE_HEAD"), f.head);
  assert.match(git(f.root, "status", "--porcelain"), /UU base\.txt/u);
  assert.match(
    await readFile(path.join(f.root, "base.txt"), "utf8"),
    /<<<<<<< HEAD\ntarget\n=======\nsource\n>>>>>>>/u,
  );
  rejected(await f.execute("pr_merge", approved), "WORKTREE_BUSY");
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state,
    "open",
  );
});

/** ネイティブ Git が何もしなかった場合は、必要なマージコミットを作成したことにならない。 */
test("Local PR reports that an already-included submission did not produce a merge commit", async (t) => {
  const f = await fixture(t);
  git(f.root, "merge", "--no-ff", "--no-edit", f.head);
  const target = git(f.root, "rev-parse", "HEAD");
  assert.notEqual(target, f.head);
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  rejected(
    await f.execute("pr_merge", approved),
    "ALREADY_UP_TO_DATE",
    "unknown",
  );
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state,
    "open",
  );
});

/** チェックアウト後に実際の Git エラーで ref の確定が中断した場合は、成功を報告せず、無条件のロールバックも行わない。 */
test("Local PR preserves the observed worktree and reports unknown when Git cannot commit the ref", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  const reflog = path.join(f.root, ".git", "logs", "refs", "heads", "main");
  await rename(reflog, reflog + ".saved");
  await mkdir(reflog);
  await writeFile(path.join(reflog, "blocker"), "occupied\n");
  rejected(
    await f.execute("pr_merge", approved),
    "MERGE_EFFECT_UNKNOWN",
    "unknown",
  );
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.equal(git(f.root, "rev-parse", "MERGE_HEAD"), f.head);
  assert.match(git(f.root, "diff", "--cached", "--name-only"), /^l\.txt$/mu);
  assert.equal(
    await readFile(path.join(f.root, "l.txt"), "utf8"),
    "other file\n",
  );
  assert.equal(
    await readFile(path.join(reflog, "blocker"), "utf8"),
    "occupied\n",
  );
  assert.equal(
    value<"pr_get">(await f.execute("pr_get", { prId: pr.id })).state,
    "open",
  );
});

/** ref の確定後に保存が切断された場合、結果を確かめずに再試行したり、副作用のない拒否として報告したりしない。 */
test("Local PR reports an uncertain overall effect when Git succeeds but review persistence does not", async (t) => {
  const f = await fixture(t);
  const pr = await f.create();
  const approved = tuple(pr.id, pr.versions[0]);
  value(await f.execute("approve", approved, "gui"));
  f.override((store) => ({
    listLocalPrs: store.listLocalPrs,
    readLocalPr: store.readLocalPr,
    createLocalPr: store.createLocalPr,
    /** Git の ref が更新された後で、レビュー結果の保存だけを失敗させる。 */
    saveLocalPr: async () => {
      throw new Error("test store disconnect");
    },
  }));
  rejected(
    await f.execute("pr_merge", approved),
    "MERGE_EFFECT_UNKNOWN",
    "unknown",
  );
  const branch = git(f.root, "rev-parse", "HEAD");
  assert.notEqual(branch, f.base);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  f.override(undefined);
  const observed = value<"pr_get">(await f.execute("pr_get", { prId: pr.id }));
  assert.equal(observed.state, "open");
  assert.equal(observed.currentTargetCommit, branch);
  rejected(await f.execute("pr_merge", approved), "TARGET_CHANGED");
});
