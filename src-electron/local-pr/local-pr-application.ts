import {
  localPrAgentInput, localPrGuiInput,
  type LocalPrFailure, type LocalPrInput, type LocalPrOperation, type LocalPrResult, type LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { buildLocalPrDiscussionMessage } from "./local-pr-discussion.js";

type CiOperation = Extract<LocalPrOperation, `pr_ci_${string}`>;
type CoreOperation = Exclude<LocalPrOperation, CiOperation | "discuss" | "session_choices">;
export type LocalPrOrigin = "gui" | "agent";
type CheckCurrent = () => void | Promise<void>;

type CoreExecutor<Repository> = <T extends CoreOperation>(
  repository: Repository, actor: SessionTarget, origin: LocalPrOrigin, operation: T, input: LocalPrInput<T>,
) => Promise<LocalPrResult<T>>;

type ApplicationDependencies<Repository> = {
  core: CoreExecutor<Repository>;
  ci<T extends CiOperation>(repository: Repository, prId: string, version: LocalPrVersion, operation: T, input: LocalPrInput<T>): Promise<LocalPrResult<T>>;
  sessionChoices(repository: Repository, input: LocalPrInput<"session_choices">): Promise<LocalPrResult<"session_choices">>;
  assertDiscussionTarget(target: SessionTarget, repository: Repository): Promise<void>;
  sendDiscussion(input: LocalPrInput<"discuss">, message: string, assertCurrent: CheckCurrent): Promise<LocalPrResult<"discuss">>;
};

/** Keep transport admission, PR state, CI ownership and the existing Session queue separate. */
export class LocalPrApplication<Repository> {
  constructor(private readonly deps: ApplicationDependencies<Repository>) {}

  /** Dispatch only the operation set belonging to the validated caller. */
  async execute<T extends LocalPrOperation>(repository: Repository, actor: SessionTarget, origin: LocalPrOrigin,
    operation: T, input: unknown, assertCurrent: CheckCurrent): Promise<LocalPrResult<T>> {
    const operations = origin === "agent" ? localPrAgentInput : localPrGuiInput;
    if (!Object.hasOwn(operations, operation)) return failure("PR_FORBIDDEN", "This operation is not available to the caller.");
    const parsed = localPrGuiInput[operation].safeParse(input);
    if (!parsed.success) return failure("PR_INVALID_REQUEST", parsed.error.issues.map((issue) => issue.message).join(" "));
    await assertCurrent();

    // CI version identity comes only from the PR's saved submissions in the same repository.
    if (operation.startsWith("pr_ci_")) {
      const request = parsed.data as LocalPrInput<CiOperation>;
      const pr = await this.deps.core(repository, actor, origin, "pr_get", { prId: request.prId });
      if (!pr.ok) return pr;
      const submitted = pr.data.versions.find((item) => item.version === request.version);
      if (!submitted) return failure("PR_VERSION_NOT_FOUND", "The selected submission does not exist.");
      await assertCurrent();
      return this.deps.ci(repository, request.prId, submitted, operation as CiOperation, request) as Promise<LocalPrResult<T>>;
    }
    // Session selection and sending are user actions, separate from writing a PR comment.
    if (operation === "session_choices") {
      return this.deps.sessionChoices(repository, parsed.data as LocalPrInput<"session_choices">) as Promise<LocalPrResult<T>>;
    }
    if (operation === "discuss") {
      return this.discuss(repository, actor, parsed.data as LocalPrInput<"discuss">, assertCurrent) as Promise<LocalPrResult<T>>;
    }
    return this.deps.core(repository, actor, origin, operation as CoreOperation, parsed.data as LocalPrInput<CoreOperation>) as Promise<LocalPrResult<T>>;
  }

  /** Publish the selected drafts only upon an explicit user send; queue acceptance is a separate effect. */
  private async discuss(repository: Repository, actor: SessionTarget, input: LocalPrInput<"discuss">, assertCurrent: CheckCurrent): Promise<LocalPrResult<"discuss">> {
    const pr = await this.deps.core(repository, actor, "gui", "pr_get", { prId: input.prId });
    if (!pr.ok) return pr;
    try { await this.deps.assertDiscussionTarget(input.target, repository); }
    catch (error) { return failure("PR_DISCUSSION_TARGET", error instanceof Error ? error.message : String(error)); }

    const makeMessage = (detail: typeof pr.data) => buildLocalPrDiscussionMessage(detail, input, async (request) => {
      const diff = await this.deps.core(repository, actor, "gui", "pr_diff", request);
      if (!diff.ok) throw new Error(diff.message);
      return diff.data;
    });

    // Validate selected context before publishing. Rebuild from persisted comments if an edit raced publication.
    let message: string;
    try { message = await makeMessage(pr.data); }
    catch (error) { return failure("PR_DISCUSSION_CONTEXT", error instanceof Error ? error.message : String(error)); }
    const ids = new Set(input.commentIds);
    const draftIds = pr.data.comments.filter((comment) => ids.has(comment.id) && comment.draft).map((comment) => comment.id);
    let published = false;
    if (draftIds.length) {
      await assertCurrent();
      const saved = await this.deps.core(repository, actor, "gui", "publish_drafts", { prId: input.prId, commentIds: draftIds });
      if (!saved.ok) return saved;
      published = true;
      if (saved.data.comments.some((comment) => {
        const before = pr.data.comments.find((entry) => entry.id === comment.id);
        return !before || before.body !== comment.body || before.version !== comment.version
          || before.replyTo !== comment.replyTo || JSON.stringify(before.anchor) !== JSON.stringify(comment.anchor);
      })) {
        const latest = await this.deps.core(repository, actor, "gui", "pr_get", { prId: input.prId });
        if (!latest.ok) return { ...latest, message: `Drafts were published. ${latest.message}` };
        try { message = await makeMessage(latest.data); }
        catch (error) { return failure("PR_DISCUSSION_CONTEXT", `Drafts were published. ${error instanceof Error ? error.message : String(error)}`); }
      }
    }

    const receipt = await this.deps.sendDiscussion(input, message, async () => {
      await assertCurrent();
      await this.deps.assertDiscussionTarget(input.target, repository);
    });
    if (!receipt.ok && published) return { ...receipt, message: `Drafts were published. ${receipt.message}` };
    return receipt;
  }
}

/** Report a PR operation's actual failure without implying a write was rolled back. */
export function failure(code: string, message: string, effect: LocalPrFailure["effect"] = "none"): LocalPrFailure {
  return { ok: false, code, message, effect };
}
