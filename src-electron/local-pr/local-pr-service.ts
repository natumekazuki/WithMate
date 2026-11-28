import { randomUUID } from "node:crypto";
import {
  localPrGuiInput,
  type LocalPrComment,
  type LocalPrData,
  type LocalPrDetail,
  type LocalPrInput,
  type LocalPrOperation,
  type LocalPrResult,
  type LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import {
  sessionTargetSchema,
  type SessionTarget,
} from "../../src-shared/session/session-target.js";
import {
  assertRuntimeTurnAdmission,
  runWithoutRuntimeTurnAdmission,
  RuntimeTurnInactiveError,
} from "../platform/agent-runtime/runtime-turn-admission.js";
import {
  StorageWorkerGenerationError,
  StorageWorkerRemoteError,
} from "../storage/storage-worker-client.js";
import {
  localPrVersion,
  readLocalPrDiff,
  validateLocalPrAnchor,
} from "./local-pr-diff.js";
import {
  gitLine,
  gitObjectId,
  gitUtf8,
  LocalPrError,
  localPrGit,
  readLocalPrBranch,
  resolveLocalPrRepository,
  runLocalPrGit,
  validateLocalPrBranch,
  verifyLocalPrCommit,
  type LocalPrRepository,
} from "./local-pr-git.js";
import { mergeLocalPr } from "./local-pr-merge.js";
import type {
  LocalPrChange,
  LocalPrRecord,
  LocalPrStore,
  LocalPrSummary,
} from "./local-pr-store.js";

export {
  resolveLocalPrRepository,
  type LocalPrRepository,
} from "./local-pr-git.js";
export type { LocalPrStore } from "./local-pr-store.js";

/** PR の中核が担う操作。CI と Session への振り分けは含まない。 */
export type LocalPrCoreOperation = Exclude<
  LocalPrOperation,
  `pr_ci_${string}` | "session_choices" | "discuss"
>;
/** 共通入力スキーマで検証した操作名と、その操作固有の入力の組。 */
type CoreRequest = {
  [K in LocalPrCoreOperation]: { operation: K; input: LocalPrInput<K> };
}[LocalPrCoreOperation];
/** 下書きや承認などの GUI 限定操作を区別するための要求元。 */
type Origin = "agent" | "gui";
/** 開いている PR の版・元コミット・先コミットをまとめて確認する承認入力。 */
type ApprovalTuple = LocalPrInput<"approve">;
/** 保存するコメントまたは返信の本文と、対象位置を指定する入力。 */
type CommentInput = LocalPrInput<"pr_comment">;
/** リポジトリ単位で直列化された要求に使う、捕捉済みの保存先・主体と再検証の手続き。 */
type Execution = {
  store: LocalPrStore;
  repository: LocalPrRepository;
  actor: SessionTarget;
  origin: Origin;
  /** 保存効果を記録する Worker の世代が、操作開始時から変わっていないか確認する。 */
  assertOwner(): void;
  /** ストア世代に加え、Agent の操作なら開始した Turn が現在も有効か確認する。 */
  guard(): void;
};

/** 現在有効な SQLite Worker と、リポジトリ単位の UI 更新通知を提供する。 */
export type LocalPrServiceDeps = {
  /** 現在のストレージ Worker の Local PR 操作を取得する。利用できなければ null。 */
  getStore(): LocalPrStore | null;
  /** 遅延処理中に Worker が置き換わったか照合するため、現在の所有者を取得する。 */
  getActiveOwner(): object | null;
  /** 指定のリポジトリに関する PR の変更を、ウィンドウが再取得できるよう知らせる。 */
  onChanged(repositoryId: string): void;
};

const operations = new Set<LocalPrCoreOperation>([
  "pr_list",
  "pr_branches",
  "pr_get",
  "pr_create",
  "pr_submit",
  "pr_close",
  "pr_diff",
  "pr_comment",
  "pr_merge",
  "approve",
  "revoke",
  "save_draft",
  "discard_draft",
  "publish_drafts",
]);
const guiOnly = new Set<LocalPrCoreOperation>([
  "approve",
  "revoke",
  "save_draft",
  "discard_draft",
  "publish_drafts",
]);
const readOnly = new Set<LocalPrCoreOperation>([
  "pr_list",
  "pr_branches",
  "pr_get",
  "pr_diff",
]);

/** 確定済みの SQLite の状態に、現時点のマージ先の先端コミットを明示的に加えて公開用の詳細を返す。 */
function detail(
  record: LocalPrRecord,
  currentTargetCommit: string | null,
): LocalPrDetail {
  return {
    ...record.summary,
    approval: record.approval,
    versions: record.versions,
    comments: record.comments,
    currentTargetCommit,
  };
}

/** ワークフローの状態を変更できるのは、PR が開いていて版がその最新版と完全に一致する場合だけ。 */
function requireOpenVersion(
  record: LocalPrRecord,
  requested: number,
): LocalPrVersion {
  if (record.summary.state !== "open")
    throw new LocalPrError("PR_NOT_OPEN", "The PR is no longer open.");
  if (record.summary.latestVersion !== requested) {
    throw new LocalPrError(
      "VERSION_CHANGED",
      "A newer version exists. Review the latest submission.",
    );
  }
  return localPrVersion(record.versions, requested);
}

/** 承認とマージは PR 番号だけでなく、固定した両方の先端コミットを指定する必要がある。 */
function requireTuple(
  record: LocalPrRecord,
  input: ApprovalTuple,
): LocalPrVersion {
  const version = requireOpenVersion(record, input.version);
  if (
    version.headCommit !== input.headCommit ||
    version.targetCommit !== input.targetCommit
  ) {
    throw new LocalPrError(
      "VERSION_CHANGED",
      "The requested commits do not match this version.",
    );
  }
  return version;
}

/** 下書きの編集や返信アンカーの指定には、アンカーの完全一致が必要。 */
function sameAnchor(
  left: LocalPrComment["anchor"],
  right: LocalPrComment["anchor"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.mode === right.mode &&
    left.path === right.path &&
    left.side === right.side &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine
  );
}

/** Worker の応答を受信できなかった書き込みは、コマンド自体が拒否された場合と区別する。 */
function storeWriteError(error: unknown): LocalPrError {
  if (
    error instanceof RuntimeTurnInactiveError ||
    (error instanceof StorageWorkerRemoteError &&
      error.code === "RUNTIME_TURN_INACTIVE")
  ) {
    return new LocalPrError(
      "RUNTIME_TURN_INACTIVE",
      "The initiating turn is no longer active.",
    );
  }
  if (
    error instanceof StorageWorkerGenerationError ||
    (error instanceof StorageWorkerRemoteError && error.outcome !== "unknown")
  ) {
    return new LocalPrError(
      "STORAGE_FAILED",
      "The review change was rejected by the storage worker.",
    );
  }
  return new LocalPrError(
    "STORAGE_EFFECT_UNKNOWN",
    "The review store did not confirm the write. Refresh the PR before retrying.",
    "unknown",
  );
}

/** Main が管理するリポジトリレビューと、全呼び出し元で共通の GUI 承認条件。 */
export class LocalPrService {
  private readonly queues = new Map<string, Promise<void>>();

  /** 要求ごとにストアの所有者を捕捉し、キューでの待機中に暗黙に切り替えない。 */
  constructor(private readonly deps: LocalPrServiceDeps) {}

  /** 信頼できない入力を検証し、信頼された呼び出し元が解決したリポジトリと実行主体だけを使う。 */
  async execute<T extends LocalPrCoreOperation>(
    repository: LocalPrRepository,
    actor: SessionTarget,
    origin: Origin,
    operation: T,
    input: unknown,
  ): Promise<LocalPrResult<T>> {
    try {
      if (!operations.has(operation))
        throw new LocalPrError(
          "INVALID_OPERATION",
          "Unknown Local PR core operation.",
        );
      if (origin !== "gui" && (origin !== "agent" || guiOnly.has(operation))) {
        throw new LocalPrError(
          "GUI_REQUIRED",
          "This operation is available only in the Local PR window.",
        );
      }
      const parsed = localPrGuiInput[operation].safeParse(input);
      const identity = sessionTargetSchema.safeParse(actor);
      if (!parsed.success || !identity.success)
        throw new LocalPrError(
          "INVALID_REQUEST",
          "The Local PR request is invalid.",
        );
      const store = this.deps.getStore();
      const owner = this.deps.getActiveOwner();
      if (!store || !owner)
        throw new LocalPrError(
          "STORAGE_UNAVAILABLE",
          "The Local PR store is unavailable.",
        );
      /** 操作の受付時に捕捉した所有者と、現在のストレージ所有者を比較する。 */
      const assertOwner = () => {
        if (this.deps.getActiveOwner() !== owner)
          throw new LocalPrError(
            "STALE_STORAGE",
            "The Local PR store was replaced.",
          );
      };
      /** 保存先の置き換えを拒否し、Agent の要求では Turn の権限も再確認する。 */
      const guard = () => {
        assertOwner();
        if (origin === "agent") assertRuntimeTurnAdmission();
      };
      const data = await this.serial(repository.repositoryId, async () => {
        guard();
        const live = await resolveLocalPrRepository(repository.workspacePath);
        if (
          live.repositoryId !== repository.repositoryId ||
          live.root !== repository.root
        ) {
          throw new LocalPrError(
            "REPOSITORY_CHANGED",
            "The workspace no longer belongs to this Local PR repository.",
          );
        }
        guard();
        const result = await this.perform(
          {
            store,
            repository: live,
            actor: identity.data,
            origin,
            assertOwner,
            guard,
          },
          { operation, input: parsed.data } as CoreRequest,
        );
        // 完了した変更には副作用があるが、失効した読み取り結果を呼び出し元に返してはならない。
        if (readOnly.has(operation)) guard();
        return result;
      });
      // 上で共通入力スキーマを適用し、振り分ける共用体の各要素を対応する操作に結び付けている。
      return { ok: true, data: data as LocalPrData<T> };
    } catch (error) {
      // 公開結果では、想定内の拒否と、書き込み結果が不明な場合を区別する。
      if (error instanceof LocalPrError)
        return {
          ok: false,
          code: error.code,
          message: error.message,
          effect: error.effect,
        };
      if (error instanceof RuntimeTurnInactiveError)
        return {
          ok: false,
          code: "RUNTIME_TURN_INACTIVE",
          message: error.message,
          effect: "none",
        };
      console.warn("Local PR operation failed", operation, error);
      return {
        ok: false,
        code: "LOCAL_PR_FAILED",
        message: "The Local PR operation could not be completed.",
        effect: "none",
      };
    }
  }

  /** 単一のアプリケーション所有者の中で、GUI 承認、リポジトリの変更、マージを直列化する。 */
  private async serial<T>(
    repositoryId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const step = (this.queues.get(repositoryId) ?? Promise.resolve()).then(run);
    const tail = step.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(repositoryId, tail);
    try {
      return await step;
    } finally {
      // 後からキューに入った操作がマップのエントリを引き継いでいる。
      if (this.queues.get(repositoryId) === tail)
        this.queues.delete(repositoryId);
    }
  }

  /** 対象リポジトリについて捕捉した一つのストレージに、読み取りと変更を振り分ける。 */
  private async perform(
    ctx: Execution,
    request: CoreRequest,
  ): Promise<LocalPrData<LocalPrCoreOperation>> {
    const { root, repositoryId } = ctx.repository;
    const { operation, input } = request;
    if (operation === "pr_list") {
      const limit = input.limit ?? 50;
      const entries = await ctx.store.listLocalPrs(
        repositoryId,
        input.offset ?? 0,
        limit + 1,
      );
      return {
        entries: entries.slice(0, limit),
        hasMore: entries.length > limit,
      };
    }
    if (operation === "pr_branches") return this.branches(root);
    if (operation === "pr_create") return this.create(ctx, input);

    // Agent の操作には、公開された返信を介しても下書きを返さない。
    const record = await ctx.store.readLocalPr(
      repositoryId,
      input.prId,
      ctx.origin === "gui",
    );
    ctx.guard();
    if (!record)
      throw new LocalPrError(
        "PR_NOT_FOUND",
        "The Local PR does not exist in this repository.",
      );
    switch (operation) {
      case "pr_get":
        return detail(
          record,
          await readLocalPrBranch(root, record.summary.targetBranch),
        );
      case "pr_diff":
        return readLocalPrDiff(root, record.versions, input);
      case "pr_submit":
        return this.submit(ctx, record, input);
      case "pr_close": {
        requireOpenVersion(record, input.version);
        const current = await readLocalPrBranch(
          root,
          record.summary.targetBranch,
        );
        const summary = {
          ...record.summary,
          state: "closed",
          updatedAt: new Date().toISOString(),
        } as const;
        await this.save(ctx, record, { summary, approval: null });
        return detail({ ...record, summary, approval: null }, current);
      }
      case "approve":
      case "revoke":
        return this.approval(ctx, record, input, operation);
      case "pr_merge":
        return this.merge(ctx, record, input);
      case "pr_comment":
      case "save_draft":
        return this.comment(
          ctx,
          record,
          input,
          operation === "save_draft",
          "commentId" in input ? input.commentId : undefined,
        );
      case "discard_draft":
        this.requireDraft(record, input.commentId);
        await this.save(ctx, record, {
          summary: record.summary,
          approval: record.approval,
          deleteDraft: input.commentId,
        });
        return { commentId: input.commentId };
      case "publish_drafts": {
        if (new Set(input.commentIds).size !== input.commentIds.length) {
          throw new LocalPrError(
            "INVALID_REQUEST",
            "Select each draft only once.",
          );
        }
        const summary = this.touched(record);
        const comments = input.commentIds.map((id) => ({
          ...this.requireDraft(record, id),
          draft: false,
          updatedAt: summary.updatedAt,
        }));
        await this.save(ctx, record, {
          summary,
          approval: record.approval,
          comments,
        });
        return { comments };
      }
    }
  }

  /** ローカルコミットだけを列挙し、まだコミットがないブランチも含めて、所有ワークスペースの HEAD を特定する。 */
  private async branches(root: string): Promise<LocalPrData<"pr_branches">> {
    const [refs, head, headBranch] = await Promise.all([
      localPrGit(root, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
        "refs/heads",
      ]),
      runLocalPrGit(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
      ]),
      runLocalPrGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    ]);
    if (head.code > 1 || headBranch.code > 1)
      throw new LocalPrError(
        "GIT_FAILED",
        head.stderr || headBranch.stderr || "Git could not read HEAD.",
      );
    const branches = gitUtf8(refs)
      .split(/\r?\n/u)
      .map((line) => line.split("\0"))
      .filter(
        ([ref, , type, symref]) =>
          ref.startsWith("refs/heads/") && type === "commit" && !symref,
      )
      .map(([ref, oid]) => ({ ref, commit: gitObjectId(oid) }));
    const symbolic = headBranch.code === 0 ? gitLine(headBranch.stdout) : null;
    return {
      branches,
      head: head.code === 0 ? gitObjectId(gitLine(head.stdout)) : null,
      headBranch: symbolic?.startsWith("refs/heads/") ? symbolic : null,
    };
  }

  /** ローカルの編集をコミットも stash もせず、不変の初版を作る。 */
  private async create(
    ctx: Execution,
    input: LocalPrInput<"pr_create">,
  ): Promise<LocalPrDetail> {
    const { root, repositoryId } = ctx.repository;
    await validateLocalPrBranch(root, input.targetBranch);
    if (input.sourceBranch) {
      // 元ブランチは出所の記録であり、レビュー対象の内容は提出されたコミットだけで決まる。
      await validateLocalPrBranch(root, input.sourceBranch);
      if (!(await readLocalPrBranch(root, input.sourceBranch)))
        throw new LocalPrError(
          "BRANCH_NOT_FOUND",
          "The selected source branch no longer exists.",
        );
    }
    const version = await this.capture(ctx, input.targetBranch, 1, input);
    const summary: LocalPrSummary = {
      id: randomUUID(),
      sourceBranch: input.sourceBranch ?? null,
      targetBranch: input.targetBranch,
      title: input.title,
      description: input.description ?? "",
      createdBy: ctx.actor,
      createdAt: version.submittedAt,
      updatedAt: version.submittedAt,
      state: "open",
      latestVersion: 1,
      mergedCommit: null,
    };
    await this.pin(ctx, summary.id, version);
    ctx.guard();
    try {
      await ctx.store.createLocalPr(repositoryId, summary, version);
    } catch (error) {
      // 保存前にコミットを固定し、書き込み結果が不明でもそのコミットオブジェクトが孤立しないようにする。
      const failure = storeWriteError(error);
      if (failure.effect === "unknown") this.changed(ctx);
      throw failure;
    }
    this.changed(ctx);
    return detail(
      {
        revision: 1,
        summary,
        approval: null,
        versions: [version],
        comments: [],
      },
      version.targetCommit,
    );
  }

  /** 両方の先端コミットを取得し直す。マージ先だけが変わった場合も、未承認の新版を作る。 */
  private async submit(
    ctx: Execution,
    record: LocalPrRecord,
    input: LocalPrInput<"pr_submit">,
  ): Promise<LocalPrDetail> {
    const latest = requireOpenVersion(record, input.expectedVersion);
    const version = await this.capture(
      ctx,
      record.summary.targetBranch,
      latest.version + 1,
      input,
    );
    if (
      version.headCommit === latest.headCommit &&
      version.targetCommit === latest.targetCommit
    ) {
      throw new LocalPrError(
        "VERSION_UNCHANGED",
        "The submitted and target commits have not changed.",
      );
    }
    await this.pin(ctx, record.summary.id, version);
    const summary = {
      ...record.summary,
      latestVersion: version.version,
      updatedAt: version.submittedAt,
    };
    await this.save(ctx, record, { summary, approval: null, version });
    return detail(
      {
        ...record,
        summary,
        approval: null,
        versions: [...record.versions, version],
      },
      version.targetCommit,
    );
  }

  /** 選択された head をブランチの先端で置き換えずに、現在のマージ先とマージベースを読む。 */
  private async capture(
    ctx: Execution,
    branch: string,
    version: number,
    input: { headCommit: string; expectedTargetCommit?: string },
  ): Promise<LocalPrVersion> {
    const { root } = ctx.repository;
    const targetCommit = await readLocalPrBranch(root, branch);
    if (!targetCommit)
      throw new LocalPrError(
        "BRANCH_NOT_FOUND",
        "The target branch no longer exists.",
      );
    if (
      input.expectedTargetCommit &&
      input.expectedTargetCommit !== targetCommit
    ) {
      throw new LocalPrError(
        "TARGET_CHANGED",
        "The target branch moved. Refresh the target and resubmit.",
      );
    }
    await verifyLocalPrCommit(root, input.headCommit);
    const base = await runLocalPrGit(root, [
      "merge-base",
      targetCommit,
      input.headCommit,
    ]);
    if (base.code === 1)
      throw new LocalPrError(
        "NO_MERGE_BASE",
        "The submitted and target commits have no common Git ancestor.",
      );
    if (base.code !== 0)
      throw new LocalPrError(
        "GIT_FAILED",
        base.stderr || "Git could not determine the merge base.",
      );
    return {
      version,
      targetCommit,
      headCommit: input.headCommit,
      mergeBaseCommit: gitObjectId(gitLine(base.stdout)),
      submittedAt: new Date().toISOString(),
      submittedBy: ctx.actor,
    };
  }

  /** 通常の Git ref を使い、ブランチ削除やオブジェクトの刈り込み後も過去の提出版を保持する。 */
  private async pin(
    ctx: Execution,
    prId: string,
    version: LocalPrVersion,
  ): Promise<void> {
    const commits = new Set(
      [version.headCommit, version.targetCommit, version.mergeBaseCommit].map(
        gitObjectId,
      ),
    );
    const refUpdates = [...commits].map(
      (commit) => `update refs/withmate/local-pr/${prId}/${commit} ${commit}`,
    );
    ctx.guard();
    await localPrGit(
      ctx.repository.root,
      ["update-ref", "--stdin"],
      refUpdates.join("\n") + "\n",
    );
  }

  /** 古くなった GUI 承認の組は取り消せるが、変更されたマージ先の承認には使えない。 */
  private async approval(
    ctx: Execution,
    record: LocalPrRecord,
    input: ApprovalTuple,
    operation: "approve" | "revoke",
  ): Promise<LocalPrDetail> {
    const version = requireTuple(record, input);
    const current = await readLocalPrBranch(
      ctx.repository.root,
      record.summary.targetBranch,
    );
    if (operation === "approve" && current !== version.targetCommit) {
      throw new LocalPrError(
        "TARGET_CHANGED",
        "The target branch moved. Submit a new version to review its latest state.",
      );
    }
    const summary = this.touched(record);
    const approval =
      operation === "approve"
        ? { ...input, approvedAt: summary.updatedAt }
        : null;
    await this.save(ctx, record, { summary, approval });
    return detail({ ...record, summary, approval }, current);
  }

  /** GUI 承認の組と Git のマージ先を、アプリケーションの同じ直列化の範囲内で検証する。 */
  private async merge(
    ctx: Execution,
    record: LocalPrRecord,
    input: LocalPrInput<"pr_merge">,
  ): Promise<LocalPrDetail> {
    const version = requireTuple(record, input);
    const branch = record.summary.targetBranch;
    const approval = record.approval;
    if (
      !approval ||
      approval.version !== version.version ||
      approval.headCommit !== version.headCommit ||
      approval.targetCommit !== version.targetCommit
    ) {
      throw new LocalPrError(
        "APPROVAL_REQUIRED",
        "The current version needs approval from the Local PR window.",
      );
    }
    if (
      (await readLocalPrBranch(ctx.repository.root, branch)) !==
      version.targetCommit
    ) {
      throw new LocalPrError(
        "TARGET_CHANGED",
        "The approved target moved. Submit and approve a new version.",
      );
    }
    let mergedCommit: string;
    try {
      mergedCommit = await mergeLocalPr(
        ctx.repository,
        branch,
        version,
        ctx.guard,
      );
    } catch (error) {
      // Git の実行結果が不明でも、他のウィンドウから見える worktree やマージ先の先端が変わっている可能性がある。
      if (error instanceof LocalPrError && error.effect === "unknown")
        this.changed(ctx);
      throw error;
    }
    const summary = {
      ...this.touched(record),
      state: "merged",
      mergedCommit,
    } as const;
    try {
      // Git の変更は確定済み。開始した Agent の Turn がここで終わっても結果を記録する。
      await runWithoutRuntimeTurnAdmission(() =>
        this.save(ctx, record, { summary, approval }, true),
      );
    } catch {
      // SQLite と Git はトランザクションを共有できない。ref の更新が確認できた後は、副作用のない拒否として扱わない。
      this.changed(ctx);
      throw new LocalPrError(
        "MERGE_EFFECT_UNKNOWN",
        `Git updated ${branch} to ${mergedCommit}, but the PR store did not confirm the merge. Refresh and inspect the branch before retrying.`,
        "unknown",
      );
    }
    return detail({ ...record, summary }, mergedCommit);
  }

  /** コメントを保存する前に、公開された返信先と、後から変わらない下書きの位置を解決する。 */
  private async comment(
    ctx: Execution,
    record: LocalPrRecord,
    input: CommentInput,
    draft: boolean,
    commentId?: string,
  ): Promise<LocalPrComment> {
    const prior = commentId ? this.requireDraft(record, commentId) : null;
    localPrVersion(record.versions, input.version);
    if (
      prior &&
      (prior.version !== input.version ||
        (input.anchor && !sameAnchor(prior.anchor, input.anchor)) ||
        (input.replyTo && input.replyTo !== prior.replyTo))
    ) {
      throw new LocalPrError(
        "INVALID_ANCHOR",
        "An existing draft keeps its original version and location.",
      );
    }
    const replyTo = prior?.replyTo ?? input.replyTo ?? null;
    let anchor = prior?.anchor ?? input.anchor ?? null;
    if (replyTo) {
      const parent = record.comments.find(
        (comment) => comment.id === replyTo && !comment.draft,
      );
      if (!parent || parent.version !== input.version) {
        throw new LocalPrError(
          "REPLY_NOT_FOUND",
          "Reply to a published comment in the selected version.",
        );
      }
      if (anchor && !sameAnchor(parent.anchor, anchor)) {
        throw new LocalPrError(
          "INVALID_ANCHOR",
          "A reply has the same location as its parent comment.",
        );
      }
      anchor = parent.anchor;
    } else if (anchor && !prior) {
      // 返信や編集の位置は、元のコメントを作成したときに検証済み。
      await validateLocalPrAnchor(
        ctx.repository.root,
        record.versions,
        record.summary.id,
        input.version,
        anchor,
      );
    }
    // 非公開の下書きを編集しても、公開概要の最終活動日時は変更しない。
    const stamp = new Date().toISOString();
    const summary = draft
      ? record.summary
      : { ...record.summary, updatedAt: stamp };
    const comment: LocalPrComment = {
      id: prior?.id ?? randomUUID(),
      version: input.version,
      anchor,
      replyTo,
      body: input.body,
      author: ctx.origin === "gui" ? { kind: "user" } : ctx.actor,
      draft,
      createdAt: prior?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    await this.save(ctx, record, {
      summary,
      approval: record.approval,
      comments: [comment],
    });
    return comment;
  }

  /** この PR に属する GUI の下書きだけが、編集・公開・破棄の対象になることを確認する。 */
  private requireDraft(record: LocalPrRecord, id: string): LocalPrComment {
    const comment = record.comments.find(
      (item) => item.draft && item.id === id,
    );
    if (!comment)
      throw new LocalPrError(
        "DRAFT_NOT_FOUND",
        "The selected Local PR draft does not exist.",
      );
    return comment;
  }

  /** 保存された PR の識別情報は変えず、時系列のレビュー索引を更新する。 */
  private touched(record: LocalPrRecord): LocalPrSummary {
    return { ...record.summary, updatedAt: new Date().toISOString() };
  }

  /** SQLite の比較・交換で保存し、変更があった場合か、結果の受信が不確かな場合だけリポジトリのリスナーに通知する。 */
  private async save(
    ctx: Execution,
    record: LocalPrRecord,
    change: LocalPrChange,
    finishingMerge = false,
  ): Promise<void> {
    if (finishingMerge) ctx.assertOwner();
    else ctx.guard();
    let saved: boolean;
    try {
      saved = await ctx.store.saveLocalPr(
        ctx.repository.repositoryId,
        record.revision,
        change,
      );
    } catch (error) {
      // 接続が中断されても、トランザクションがロールバックされたとは限らない。
      const failure = storeWriteError(error);
      if (failure.effect === "unknown" && !finishingMerge) this.changed(ctx);
      throw failure;
    }
    if (!saved)
      throw new LocalPrError(
        "PR_CHANGED",
        "The PR changed while this operation was running. Refresh it and try again.",
      );
    this.changed(ctx);
  }

  /** ウィンドウ通知の失敗を理由に、確定済みの書き込みを拒否として扱わない。 */
  private changed(ctx: Execution): void {
    try {
      this.deps.onChanged(ctx.repository.repositoryId);
    } catch (error) {
      // 開き直すか再読み込みすれば、Git と SQLite の正本の状態を取得できる。
      console.warn("Local PR change notification failed", error);
    }
  }
}
