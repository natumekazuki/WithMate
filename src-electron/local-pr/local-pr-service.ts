import { randomUUID } from "node:crypto";
import {
  localPrGuiInput, type LocalPrComment, type LocalPrData, type LocalPrDetail, type LocalPrInput, type LocalPrOperation,
  type LocalPrResult, type LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { sessionTargetSchema, type SessionTarget } from "../../src-shared/session/session-target.js";
import { assertRuntimeTurnAdmission, runWithoutRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../platform/agent-runtime/runtime-turn-admission.js";
import { StorageWorkerGenerationError, StorageWorkerRemoteError } from "../storage/storage-worker-client.js";
import { localPrVersion, readLocalPrDiff, validateLocalPrAnchor } from "./local-pr-diff.js";
import {
  gitLine, gitObjectId, gitUtf8, LocalPrError, localPrGit, readLocalPrBranch, resolveLocalPrRepository, runLocalPrGit,
  validateLocalPrBranch, verifyLocalPrCommit, type LocalPrRepository,
} from "./local-pr-git.js";
import { mergeLocalPr } from "./local-pr-merge.js";
import type { LocalPrChange, LocalPrRecord, LocalPrStore, LocalPrSummary } from "./local-pr-store.js";

export { resolveLocalPrRepository, type LocalPrRepository } from "./local-pr-git.js";
export type { LocalPrStore } from "./local-pr-store.js";

/** Operations owned by the PR core, excluding CI and Session routing. */
export type LocalPrCoreOperation = Exclude<LocalPrOperation, `pr_ci_${string}` | "session_choices" | "discuss">;
type CoreRequest = { [K in LocalPrCoreOperation]: { operation: K; input: LocalPrInput<K> } }[LocalPrCoreOperation];
type Origin = "agent" | "gui";
type ApprovalTuple = LocalPrInput<"approve">;
type CommentInput = LocalPrInput<"pr_comment">;
type Execution = {
  store: LocalPrStore;
  repository: LocalPrRepository;
  actor: SessionTarget;
  origin: Origin;
  assertOwner(): void;
  guard(): void;
};

/** Supplies the currently active SQLite Worker and a repository-scoped UI invalidation. */
export type LocalPrServiceDeps = {
  getStore(): LocalPrStore | null;
  getActiveOwner(): object | null;
  onChanged(repositoryId: string): void;
};

const operations = new Set<LocalPrCoreOperation>([
  "pr_list", "pr_branches", "pr_get", "pr_create", "pr_submit", "pr_close", "pr_diff", "pr_comment", "pr_merge",
  "approve", "revoke", "save_draft", "discard_draft", "publish_drafts",
]);
const guiOnly = new Set<LocalPrCoreOperation>(["approve", "revoke", "save_draft", "discard_draft", "publish_drafts"]);
const readOnly = new Set<LocalPrCoreOperation>(["pr_list", "pr_branches", "pr_get", "pr_diff"]);

/** Returns public detail from committed SQLite state plus the explicitly live target tip. */
function detail(record: LocalPrRecord, currentTargetCommit: string | null): LocalPrDetail {
  return { ...record.summary, approval: record.approval, versions: record.versions, comments: record.comments, currentTargetCommit };
}

/** Only the exact most recent open version may affect workflow state. */
function requireOpenVersion(record: LocalPrRecord, requested: number): LocalPrVersion {
  if (record.summary.state !== "open") throw new LocalPrError("PR_NOT_OPEN", "The PR is no longer open.");
  if (record.summary.latestVersion !== requested) {
    throw new LocalPrError("VERSION_CHANGED", "A newer version exists. Review the latest submission.");
  }
  return localPrVersion(record.versions, requested);
}

/** Approval and merge must reference both fixed tips, not just a PR number. */
function requireTuple(record: LocalPrRecord, input: ApprovalTuple): LocalPrVersion {
  const version = requireOpenVersion(record, input.version);
  if (version.headCommit !== input.headCommit || version.targetCommit !== input.targetCommit) {
    throw new LocalPrError("VERSION_CHANGED", "The requested commits do not match this version.");
  }
  return version;
}

/** Exact anchor equality is required when editing a draft or supplying a reply anchor. */
function sameAnchor(left: LocalPrComment["anchor"], right: LocalPrComment["anchor"]): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.path === right.path && left.side === right.side
    && left.startLine === right.startLine && left.endLine === right.endLine;
}

/** Keeps write failures honest when a worker reply was lost, as distinct from a rejected command. */
function storeWriteError(error: unknown): LocalPrError {
  if (error instanceof RuntimeTurnInactiveError ||
      (error instanceof StorageWorkerRemoteError && error.code === "RUNTIME_TURN_INACTIVE")) {
    return new LocalPrError("RUNTIME_TURN_INACTIVE", "The initiating turn is no longer active.");
  }
  if (error instanceof StorageWorkerGenerationError || (error instanceof StorageWorkerRemoteError && error.outcome !== "unknown")) {
    return new LocalPrError("STORAGE_FAILED", "The review change was rejected by the storage worker.");
  }
  return new LocalPrError("STORAGE_EFFECT_UNKNOWN", "The review store did not confirm the write. Refresh the PR before retrying.", "unknown");
}

/** Main-owned repository review and GUI approval gate shared by all callers. */
export class LocalPrService {
  private readonly queues = new Map<string, Promise<void>>();

  /** Store ownership is captured for each request and cannot silently change while queued. */
  constructor(private readonly deps: LocalPrServiceDeps) {}

  /** Validates untrusted input, then uses only the repository and actor resolved by the trusted caller. */
  async execute<T extends LocalPrCoreOperation>(
    repository: LocalPrRepository, actor: SessionTarget, origin: Origin, operation: T, input: unknown,
  ): Promise<LocalPrResult<T>> {
    try {
      if (!operations.has(operation)) throw new LocalPrError("INVALID_OPERATION", "Unknown Local PR core operation.");
      if (origin !== "gui" && (origin !== "agent" || guiOnly.has(operation))) {
        throw new LocalPrError("GUI_REQUIRED", "This operation is available only in the Local PR window.");
      }
      const parsed = localPrGuiInput[operation].safeParse(input);
      const identity = sessionTargetSchema.safeParse(actor);
      if (!parsed.success || !identity.success) throw new LocalPrError("INVALID_REQUEST", "The Local PR request is invalid.");
      const store = this.deps.getStore();
      const owner = this.deps.getActiveOwner();
      if (!store || !owner) throw new LocalPrError("STORAGE_UNAVAILABLE", "The Local PR store is unavailable.");
      const assertOwner = () => {
        if (this.deps.getActiveOwner() !== owner) throw new LocalPrError("STALE_STORAGE", "The Local PR store was replaced.");
      };
      const guard = () => {
        assertOwner();
        if (origin === "agent") assertRuntimeTurnAdmission();
      };
      const data = await this.serial(repository.repositoryId, async () => {
        guard();
        const live = await resolveLocalPrRepository(repository.workspacePath);
        if (live.repositoryId !== repository.repositoryId || live.root !== repository.root) {
          throw new LocalPrError("REPOSITORY_CHANGED", "The workspace no longer belongs to this Local PR repository.");
        }
        guard();
        const result = await this.perform({ store, repository: live, actor: identity.data, origin, assertOwner, guard }, { operation, input: parsed.data } as CoreRequest);
        // A completed mutation has an effect, but an obsolete read must not reach the caller.
        if (readOnly.has(operation)) guard();
        return result;
      });
      // The dispatch union is paired with its operation by the shared input schema above.
      return { ok: true, data: data as LocalPrData<T> };
    } catch (error) {
      // Public results distinguish a predictable rejection from an uncertain write.
      if (error instanceof LocalPrError) return { ok: false, code: error.code, message: error.message, effect: error.effect };
      if (error instanceof RuntimeTurnInactiveError) return { ok: false, code: "RUNTIME_TURN_INACTIVE", message: error.message, effect: "none" };
      console.warn("Local PR operation failed", operation, error);
      return { ok: false, code: "LOCAL_PR_FAILED", message: "The Local PR operation could not be completed.", effect: "none" };
    }
  }

  /** Serializes GUI approval, repo mutation, and merge within the single application owner. */
  private async serial<T>(repositoryId: string, run: () => Promise<T>): Promise<T> {
    const step = (this.queues.get(repositoryId) ?? Promise.resolve()).then(run);
    const tail = step.then(() => undefined, () => undefined);
    this.queues.set(repositoryId, tail);
    try {
      return await step;
    } finally {
      // A later queued operation has taken ownership of the map entry.
      if (this.queues.get(repositoryId) === tail) this.queues.delete(repositoryId);
    }
  }

  /** Dispatches reads and mutations against one repository-specific storage capture. */
  private async perform(ctx: Execution, request: CoreRequest): Promise<LocalPrData<LocalPrCoreOperation>> {
    const { root, repositoryId } = ctx.repository;
    const { operation, input } = request;
    if (operation === "pr_list") {
      const limit = input.limit ?? 50;
      const entries = await ctx.store.listLocalPrs(repositoryId, input.offset ?? 0, limit + 1);
      return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
    }
    if (operation === "pr_branches") return this.branches(root);
    if (operation === "pr_create") return this.create(ctx, input);

    // Agent operations never receive drafts, even indirectly through a public reply.
    const record = await ctx.store.readLocalPr(repositoryId, input.prId, ctx.origin === "gui");
    ctx.guard();
    if (!record) throw new LocalPrError("PR_NOT_FOUND", "The Local PR does not exist in this repository.");
    switch (operation) {
      case "pr_get":
        return detail(record, await readLocalPrBranch(root, record.summary.targetBranch));
      case "pr_diff":
        return readLocalPrDiff(root, record.versions, input);
      case "pr_submit":
        return this.submit(ctx, record, input);
      case "pr_close": {
        requireOpenVersion(record, input.version);
        const current = await readLocalPrBranch(root, record.summary.targetBranch);
        const summary = { ...record.summary, state: "closed", updatedAt: new Date().toISOString() } as const;
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
        return this.comment(ctx, record, input, operation === "save_draft", "commentId" in input ? input.commentId : undefined);
      case "discard_draft":
        this.requireDraft(record, input.commentId);
        await this.save(ctx, record, { summary: record.summary, approval: record.approval, deleteDraft: input.commentId });
        return { commentId: input.commentId };
      case "publish_drafts": {
        if (new Set(input.commentIds).size !== input.commentIds.length) {
          throw new LocalPrError("INVALID_REQUEST", "Select each draft only once.");
        }
        const summary = this.touched(record);
        const comments = input.commentIds.map((id) => ({ ...this.requireDraft(record, id), draft: false, updatedAt: summary.updatedAt }));
        await this.save(ctx, record, { summary, approval: record.approval, comments });
        return { comments };
      }
    }
  }

  /** Lists only local commits and identifies the owning workspace's HEAD, including an unborn branch. */
  private async branches(root: string): Promise<LocalPrData<"pr_branches">> {
    const [refs, head, headBranch] = await Promise.all([
      localPrGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)", "refs/heads"]),
      runLocalPrGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
      runLocalPrGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    ]);
    if (head.code > 1 || headBranch.code > 1) throw new LocalPrError("GIT_FAILED", head.stderr || headBranch.stderr || "Git could not read HEAD.");
    const branches = gitUtf8(refs).split(/\r?\n/u).map((line) => line.split("\0"))
      .filter(([ref, , type, symref]) => ref.startsWith("refs/heads/") && type === "commit" && !symref)
      .map(([ref, oid]) => ({ ref, commit: gitObjectId(oid) }));
    const symbolic = headBranch.code === 0 ? gitLine(headBranch.stdout) : null;
    return { branches, head: head.code === 0 ? gitObjectId(gitLine(head.stdout)) : null, headBranch: symbolic?.startsWith("refs/heads/") ? symbolic : null };
  }

  /** Creates the first immutable version without committing or stashing local edits. */
  private async create(ctx: Execution, input: LocalPrInput<"pr_create">): Promise<LocalPrDetail> {
    const { root, repositoryId } = ctx.repository;
    await validateLocalPrBranch(root, input.targetBranch);
    if (input.sourceBranch) {
      // The source branch is provenance; only the submitted commit determines the reviewed contents.
      await validateLocalPrBranch(root, input.sourceBranch);
      if (!await readLocalPrBranch(root, input.sourceBranch)) throw new LocalPrError("BRANCH_NOT_FOUND", "The selected source branch no longer exists.");
    }
    const version = await this.capture(ctx, input.targetBranch, 1, input);
    const summary: LocalPrSummary = {
      id: randomUUID(), sourceBranch: input.sourceBranch ?? null, targetBranch: input.targetBranch,
      title: input.title, description: input.description ?? "", createdBy: ctx.actor,
      createdAt: version.submittedAt, updatedAt: version.submittedAt, state: "open", latestVersion: 1, mergedCommit: null,
    };
    await this.pin(ctx, summary.id, version);
    ctx.guard();
    try {
      await ctx.store.createLocalPr(repositoryId, summary, version);
    } catch (error) {
      // Pinning happens before save so an ambiguous write cannot orphan its commit objects.
      const failure = storeWriteError(error);
      if (failure.effect === "unknown") this.changed(ctx);
      throw failure;
    }
    this.changed(ctx);
    return detail({ revision: 1, summary, approval: null, versions: [version], comments: [] }, version.targetCommit);
  }

  /** Re-captures both tips; a target-only move still creates a new, unapproved version. */
  private async submit(ctx: Execution, record: LocalPrRecord, input: LocalPrInput<"pr_submit">): Promise<LocalPrDetail> {
    const latest = requireOpenVersion(record, input.expectedVersion);
    const version = await this.capture(ctx, record.summary.targetBranch, latest.version + 1, input);
    if (version.headCommit === latest.headCommit && version.targetCommit === latest.targetCommit) {
      throw new LocalPrError("VERSION_UNCHANGED", "The submitted and target commits have not changed.");
    }
    await this.pin(ctx, record.summary.id, version);
    const summary = { ...record.summary, latestVersion: version.version, updatedAt: version.submittedAt };
    await this.save(ctx, record, { summary, approval: null, version });
    return detail({ ...record, summary, approval: null, versions: [...record.versions, version] }, version.targetCommit);
  }

  /** Reads the current target and merge base without substituting branch tips for the selected head. */
  private async capture(
    ctx: Execution, branch: string, version: number, input: { headCommit: string; expectedTargetCommit?: string },
  ): Promise<LocalPrVersion> {
    const { root } = ctx.repository;
    const targetCommit = await readLocalPrBranch(root, branch);
    if (!targetCommit) throw new LocalPrError("BRANCH_NOT_FOUND", "The target branch no longer exists.");
    if (input.expectedTargetCommit && input.expectedTargetCommit !== targetCommit) {
      throw new LocalPrError("TARGET_CHANGED", "The target branch moved. Refresh the target and resubmit.");
    }
    await verifyLocalPrCommit(root, input.headCommit);
    const base = await runLocalPrGit(root, ["merge-base", targetCommit, input.headCommit]);
    if (base.code === 1) throw new LocalPrError("NO_MERGE_BASE", "The submitted and target commits have no common Git ancestor.");
    if (base.code !== 0) throw new LocalPrError("GIT_FAILED", base.stderr || "Git could not determine the merge base.");
    return { version, targetCommit, headCommit: input.headCommit, mergeBaseCommit: gitObjectId(gitLine(base.stdout)), submittedAt: new Date().toISOString(), submittedBy: ctx.actor };
  }

  /** Uses ordinary Git refs so past submissions survive branch deletion and object pruning. */
  private async pin(ctx: Execution, prId: string, version: LocalPrVersion): Promise<void> {
    const commits = new Set([version.headCommit, version.targetCommit, version.mergeBaseCommit].map(gitObjectId));
    const refUpdates = [...commits].map((commit) => `update refs/withmate/local-pr/${prId}/${commit} ${commit}`);
    ctx.guard();
    await localPrGit(ctx.repository.root, ["update-ref", "--stdin"], refUpdates.join("\n") + "\n");
  }

  /** A stale GUI tuple can be revoked, but cannot be used to approve a changed target. */
  private async approval(ctx: Execution, record: LocalPrRecord, input: ApprovalTuple, operation: "approve" | "revoke"): Promise<LocalPrDetail> {
    const version = requireTuple(record, input);
    const current = await readLocalPrBranch(ctx.repository.root, record.summary.targetBranch);
    if (operation === "approve" && current !== version.targetCommit) {
      throw new LocalPrError("TARGET_CHANGED", "The target branch moved. Submit a new version to review its latest state.");
    }
    const summary = this.touched(record);
    const approval = operation === "approve" ? { ...input, approvedAt: summary.updatedAt } : null;
    await this.save(ctx, record, { summary, approval });
    return detail({ ...record, summary, approval }, current);
  }

  /** Enforces the GUI approval tuple and Git target under the same application serialization. */
  private async merge(ctx: Execution, record: LocalPrRecord, input: LocalPrInput<"pr_merge">): Promise<LocalPrDetail> {
    const version = requireTuple(record, input);
    const branch = record.summary.targetBranch;
    const approval = record.approval;
    if (!approval || approval.version !== version.version || approval.headCommit !== version.headCommit || approval.targetCommit !== version.targetCommit) {
      throw new LocalPrError("APPROVAL_REQUIRED", "The current version needs approval from the Local PR window.");
    }
    if (await readLocalPrBranch(ctx.repository.root, branch) !== version.targetCommit) {
      throw new LocalPrError("TARGET_CHANGED", "The approved target moved. Submit and approve a new version.");
    }
    let mergedCommit: string;
    try {
      mergedCommit = await mergeLocalPr(ctx.repository, branch, version, ctx.guard);
    } catch (error) {
      // An indeterminate Git result may affect the worktree or target tip visible in other windows.
      if (error instanceof LocalPrError && error.effect === "unknown") this.changed(ctx);
      throw error;
    }
    const summary = { ...this.touched(record), state: "merged", mergedCommit } as const;
    try {
      // Git is already committed. Record that result even if the initiating Agent turn ends now.
      await runWithoutRuntimeTurnAdmission(() => this.save(ctx, record, { summary, approval }, true));
    } catch {
      // SQLite and Git cannot share a transaction; never claim a clean refusal after a confirmed ref update.
      this.changed(ctx);
      throw new LocalPrError("MERGE_EFFECT_UNKNOWN",
        `Git updated ${branch} to ${mergedCommit}, but the PR store did not confirm the merge. Refresh and inspect the branch before retrying.`, "unknown");
    }
    return detail({ ...record, summary }, mergedCommit);
  }

  /** Resolves public replies and immutable draft locations before persisting any comment. */
  private async comment(
    ctx: Execution, record: LocalPrRecord, input: CommentInput, draft: boolean, commentId?: string,
  ): Promise<LocalPrComment> {
    const prior = commentId ? this.requireDraft(record, commentId) : null;
    localPrVersion(record.versions, input.version);
    if (prior && (prior.version !== input.version || (input.anchor && !sameAnchor(prior.anchor, input.anchor))
      || (input.replyTo && input.replyTo !== prior.replyTo))) {
      throw new LocalPrError("INVALID_ANCHOR", "An existing draft keeps its original version and location.");
    }
    const replyTo = prior?.replyTo ?? input.replyTo ?? null;
    let anchor = prior?.anchor ?? input.anchor ?? null;
    if (replyTo) {
      const parent = record.comments.find((comment) => comment.id === replyTo && !comment.draft);
      if (!parent || parent.version !== input.version) {
        throw new LocalPrError("REPLY_NOT_FOUND", "Reply to a published comment in the selected version.");
      }
      if (anchor && !sameAnchor(parent.anchor, anchor)) {
        throw new LocalPrError("INVALID_ANCHOR", "A reply has the same location as its parent comment.");
      }
      anchor = parent.anchor;
    } else if (anchor && !prior) {
      // Reply and edit locations were already validated when their original comment was made.
      await validateLocalPrAnchor(ctx.repository.root, record.versions, record.summary.id, input.version, anchor);
    }
    // Private draft edits must not change the public summary's last activity timestamp.
    const stamp = new Date().toISOString();
    const summary = draft ? record.summary : { ...record.summary, updatedAt: stamp };
    const comment: LocalPrComment = {
      id: prior?.id ?? randomUUID(), version: input.version, anchor, replyTo, body: input.body,
      author: ctx.origin === "gui" ? { kind: "user" } : ctx.actor, draft,
      createdAt: prior?.createdAt ?? stamp, updatedAt: stamp,
    };
    await this.save(ctx, record, { summary, approval: record.approval, comments: [comment] });
    return comment;
  }

  /** Confirms that only a GUI draft belonging to this PR may be edited, published or discarded. */
  private requireDraft(record: LocalPrRecord, id: string): LocalPrComment {
    const comment = record.comments.find((item) => item.draft && item.id === id);
    if (!comment) throw new LocalPrError("DRAFT_NOT_FOUND", "The selected Local PR draft does not exist.");
    return comment;
  }

  /** Updates the chronological review index without altering the stored PR identity. */
  private touched(record: LocalPrRecord): LocalPrSummary {
    return { ...record.summary, updatedAt: new Date().toISOString() };
  }

  /** Persists a SQLite CAS and notifies repository listeners only after change or uncertain delivery. */
  private async save(ctx: Execution, record: LocalPrRecord, change: LocalPrChange, finishingMerge = false): Promise<void> {
    if (finishingMerge) ctx.assertOwner();
    else ctx.guard();
    let saved: boolean;
    try {
      saved = await ctx.store.saveLocalPr(ctx.repository.repositoryId, record.revision, change);
    } catch (error) {
      // An interrupted connection is not evidence that the transaction was rolled back.
      const failure = storeWriteError(error);
      if (failure.effect === "unknown" && !finishingMerge) this.changed(ctx);
      throw failure;
    }
    if (!saved) throw new LocalPrError("PR_CHANGED", "The PR changed while this operation was running. Refresh it and try again.");
    this.changed(ctx);
  }

  /** A window notification failure must not turn a committed write into a rejected operation. */
  private changed(ctx: Execution): void {
    try {
      this.deps.onChanged(ctx.repository.repositoryId);
    } catch (error) {
      // Reopening or refreshing still reads the authoritative Git and SQLite state.
      console.warn("Local PR change notification failed", error);
    }
  }
}
