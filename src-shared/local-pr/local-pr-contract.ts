import { z } from "zod";
import { sessionTargetSchema } from "../session/session-target.js";

const id = z.uuid();
const text = (max: number) => z.string().min(1).max(max).refine((value) => !!value.trim());
const stamp = z.string();
const version = z.number().int().positive();
const path = z.string().min(1).max(32768).refine((value) => !value.includes("\0"));
const branch = z.string().regex(/^refs\/heads\/.+$/u).max(1024);
export const localPrCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const prId = { prId: id };
const prVersion = { ...prId, version };

/** A version pins both repository tips and the merge base used for the reviewed diff. */
export const localPrVersionSchema = z.strictObject({
  version,
  headCommit: localPrCommitSchema,
  targetCommit: localPrCommitSchema,
  mergeBaseCommit: localPrCommitSchema,
  submittedAt: stamp,
  submittedBy: sessionTargetSchema,
});

/** An anchor addresses a file or its line range on one side of an immutable comparison. */
export const localPrAnchorSchema = z.strictObject({
  mode: z.enum(["full", "previous"]),
  path,
  side: z.enum(["before", "after"]),
  startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  endLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).refine((input) => input.startLine === null ? input.endLine === null : input.endLine !== null && input.startLine <= input.endLine,
  "Use two null line values for a file comment or an ordered pair of line numbers.");

/** Public comments and GUI-only drafts retain their original version and anchor. */
export const localPrCommentSchema = z.strictObject({
  id,
  version,
  anchor: localPrAnchorSchema.nullable(),
  replyTo: id.nullable(),
  body: z.string(),
  author: z.union([z.strictObject({ kind: z.literal("user") }), sessionTargetSchema]),
  draft: z.boolean(),
  createdAt: stamp,
  updatedAt: stamp,
});

const prSummary = z.strictObject({
  id,
  targetBranch: branch,
  sourceBranch: branch.nullable(),
  title: z.string(),
  description: z.string(),
  createdBy: sessionTargetSchema,
  createdAt: stamp,
  updatedAt: stamp,
  state: z.enum(["open", "closed", "merged"]),
  latestVersion: version,
  mergedCommit: localPrCommitSchema.nullable(),
});

/** The approval tuple includes the exact tips the GUI reviewed. */
export const localPrApprovalTargetSchema = z.strictObject({
  ...prVersion,
  headCommit: localPrCommitSchema,
  targetCommit: localPrCommitSchema,
});

export const localPrDetailSchema = prSummary.extend({
  versions: z.array(localPrVersionSchema),
  comments: z.array(localPrCommentSchema),
  approval: localPrApprovalTargetSchema.extend({ approvedAt: stamp }).nullable(),
  currentTargetCommit: localPrCommitSchema.nullable(),
});

const changedFile = z.strictObject({
  path,
  previousPath: path.nullable(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
});

/** Captured comparison endpoints and either a change list or one file's patch. */
export const localPrDiffSchema = z.strictObject({
  beforeCommit: localPrCommitSchema,
  afterCommit: localPrCommitSchema,
  files: z.array(changedFile),
  patch: z.string().nullable(),
});

export const localPrCiDefinitionSchema = z.strictObject({
  headCommit: localPrCommitSchema,
  path: z.literal(".withmate/ci.yml"),
  state: z.enum(["not_configured", "invalid", "valid"]),
  source: z.string().nullable(),
  error: z.string().nullable(),
});

export const localPrCiRunSchema = z.strictObject({
  id,
  version,
  headCommit: localPrCommitSchema,
  targetCommit: localPrCommitSchema,
  state: z.enum(["running", "succeeded", "failed", "canceled", "interrupted"]),
  startedAt: stamp,
  finishedAt: stamp.nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
});

const commentInput = z.strictObject({
  ...prId,
  version,
  body: text(20000),
  anchor: localPrAnchorSchema.optional(),
  replyTo: id.optional(),
});
const submitInput = { headCommit: localPrCommitSchema, expectedTargetCommit: localPrCommitSchema.optional() };

/** The complete Agent surface; GUI-only actions deliberately have no public schema here. */
export const localPrAgentInput = {
  pr_list: z.strictObject({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }),
  pr_branches: z.strictObject({}),
  pr_get: z.strictObject(prId),
  pr_create: z.strictObject({ ...submitInput, targetBranch: branch, sourceBranch: branch.optional(), title: text(200), description: z.string().max(20000).optional() }),
  pr_submit: z.strictObject({ ...prId, ...submitInput, expectedVersion: version }),
  pr_close: z.strictObject({ ...prVersion }),
  pr_diff: z.strictObject({ ...prVersion, mode: z.enum(["full", "previous"]), path: path.optional() }),
  pr_comment: commentInput,
  pr_merge: localPrApprovalTargetSchema,
  pr_ci_validate: z.strictObject(prVersion),
  pr_ci_list: z.strictObject(prVersion),
  pr_ci_start: z.strictObject(prVersion),
  pr_ci_cancel: z.strictObject({ ...prVersion, runId: id }),
  pr_ci_rerun: z.strictObject({ ...prVersion, runId: id }),
  pr_ci_log: z.strictObject({ ...prVersion, runId: id, offset: z.number().int().nonnegative().optional() }),
} as const;

export const localPrAgentData = {
  pr_list: z.strictObject({ entries: z.array(prSummary), hasMore: z.boolean() }),
  pr_branches: z.strictObject({ branches: z.array(z.strictObject({ ref: branch, commit: localPrCommitSchema })), head: localPrCommitSchema.nullable(), headBranch: branch.nullable() }),
  pr_get: localPrDetailSchema,
  pr_create: localPrDetailSchema,
  pr_submit: localPrDetailSchema,
  pr_close: localPrDetailSchema,
  pr_diff: localPrDiffSchema,
  pr_comment: localPrCommentSchema,
  pr_merge: localPrDetailSchema,
  pr_ci_validate: localPrCiDefinitionSchema,
  pr_ci_list: z.strictObject({ runs: z.array(localPrCiRunSchema) }),
  pr_ci_start: localPrCiRunSchema,
  pr_ci_cancel: localPrCiRunSchema,
  pr_ci_rerun: localPrCiRunSchema,
  pr_ci_log: z.strictObject({ log: z.string(), nextOffset: z.number().int().nonnegative(), hasMore: z.boolean() }),
} as const satisfies Record<keyof typeof localPrAgentInput, z.ZodType>;

/** Trusted Main-frame IPC only; never spread these operations into the Agent tools. */
export const localPrGuiInput = {
  ...localPrAgentInput,
  approve: localPrApprovalTargetSchema,
  revoke: localPrApprovalTargetSchema,
  save_draft: commentInput.extend({ commentId: id.optional() }),
  discard_draft: z.strictObject({ ...prId, commentId: id }),
  publish_drafts: z.strictObject({ ...prId, commentIds: z.array(id).min(1).max(50) }),
  session_choices: z.strictObject({ query: z.string().max(300).optional(), offset: z.number().int().nonnegative().optional() }),
  discuss: z.strictObject({ ...prVersion, target: sessionTargetSchema, commentIds: z.array(id).max(50), message: text(20000), requestId: id }),
} as const;

export const localPrGuiData = {
  ...localPrAgentData,
  approve: localPrDetailSchema,
  revoke: localPrDetailSchema,
  save_draft: localPrCommentSchema,
  discard_draft: z.strictObject({ commentId: id }),
  publish_drafts: z.strictObject({ comments: z.array(localPrCommentSchema) }),
  session_choices: z.strictObject({ sessions: z.array(z.strictObject({ target: sessionTargetSchema, title: z.string() })), hasMore: z.boolean() }),
  discuss: z.strictObject({ receiptId: z.string() }),
} as const satisfies Record<keyof typeof localPrGuiInput, z.ZodType>;

export const localPrFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  effect: z.enum(["none", "unknown"]),
});

export type LocalPrAgentOperation = keyof typeof localPrAgentInput;
export type LocalPrOperation = keyof typeof localPrGuiInput;
export type LocalPrInput<T extends LocalPrOperation> = z.infer<(typeof localPrGuiInput)[T]>;
export type LocalPrData<T extends LocalPrOperation> = z.infer<(typeof localPrGuiData)[T]>;
export type LocalPrFailure = z.infer<typeof localPrFailureSchema>;
export type LocalPrResult<T extends LocalPrOperation> = { ok: true; data: LocalPrData<T> } | LocalPrFailure;
export type LocalPrVersion = z.infer<typeof localPrVersionSchema>;
export type LocalPrComment = z.infer<typeof localPrCommentSchema>;
export type LocalPrDetail = z.infer<typeof localPrDetailSchema>;
export type LocalPrCiRun = z.infer<typeof localPrCiRunSchema>;

/** Renderer calls have a fixed repository/source Session on the Main-owned Window. */
export type LocalPrWindowApi = {
  execute<T extends LocalPrOperation>(operation: T, input: LocalPrInput<T>): Promise<LocalPrResult<T>>;
  subscribeChanged(listener: () => void): () => void;
};
