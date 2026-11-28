import { z } from "zod";
import type {
  SessionFileChunkResult,
  SessionFileDescriptor,
  SessionImageChunkRequest,
} from "../file-explorer/file-explorer-contract.js";
import { sessionTargetSchema } from "../session/session-target.js";

const id = z.uuid();
/** PRの名前や本文に許容長を設定し、空白だけの入力を拒否する。 */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !!value.trim());
const stamp = z.string();
const version = z.number().int().positive();
const path = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes("\0"));
const branch = z
  .string()
  .regex(/^refs\/heads\/.+$/u)
  .max(1024);
/** 省略形やブランチ名を受け付けず、完全なGitコミットIDだけを検証する。 */
export const localPrCommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const prId = { prId: id };
const prVersion = { ...prId, version };

/** 版には、レビュー対象の差分に使った両側の先端コミットとマージベースを固定する。 */
export const localPrVersionSchema = z.strictObject({
  version,
  headCommit: localPrCommitSchema,
  targetCommit: localPrCommitSchema,
  mergeBaseCommit: localPrCommitSchema,
  submittedAt: stamp,
  submittedBy: sessionTargetSchema,
});

/** アンカーは、固定された比較の片側にあるファイル、またはその行範囲を指す。 */
export const localPrAnchorSchema = z
  .strictObject({
    mode: z.enum(["full", "previous"]),
    path,
    side: z.enum(["before", "after"]),
    startLine: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    endLine: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .refine(
    (input) =>
      input.startLine === null
        ? input.endLine === null
        : input.endLine !== null && input.startLine <= input.endLine,
    "Use two null line values for a file comment or an ordered pair of line numbers.",
  );

/** 公開コメントと GUI 専用の下書きは、元の版とアンカーを保持する。 */
export const localPrCommentSchema = z.strictObject({
  id,
  version,
  anchor: localPrAnchorSchema.nullable(),
  replyTo: id.nullable(),
  body: z.string(),
  author: z.union([
    z.strictObject({ kind: z.literal("user") }),
    sessionTargetSchema,
  ]),
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

/** 承認の組には、GUI でレビューした正確な先端コミットを含める。 */
export const localPrApprovalTargetSchema = z.strictObject({
  ...prVersion,
  headCommit: localPrCommitSchema,
  targetCommit: localPrCommitSchema,
});

/** PRの概要に、提出版・コメント・記録された承認と現在のマージ先を加える。 */
export const localPrDetailSchema = prSummary.extend({
  versions: z.array(localPrVersionSchema),
  comments: z.array(localPrCommentSchema),
  approval: localPrApprovalTargetSchema
    .extend({ approvedAt: stamp })
    .nullable(),
  currentTargetCommit: localPrCommitSchema.nullable(),
});

const changedFile = z.strictObject({
  path,
  previousPath: path.nullable(),
  kind: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
  ]),
});

/** 記録済みの比較両端と、変更一覧または単一ファイルのパッチ。 */
export const localPrDiffSchema = z.strictObject({
  beforeCommit: localPrCommitSchema,
  afterCommit: localPrCommitSchema,
  files: z.array(changedFile),
  patch: z.string().nullable(),
});

/** 提出した先端のCI設定を調べ、未設定、有効、不正とその内容を区別する。 */
export const localPrCiDefinitionSchema = z.strictObject({
  headCommit: localPrCommitSchema,
  path: z.literal(".withmate/ci.yml"),
  state: z.enum(["not_configured", "invalid", "valid"]),
  source: z.string().nullable(),
  error: z.string().nullable(),
});

/** CIを実行した提出版と両端のコミット、進行状態、時刻および終了結果。 */
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
const submitInput = {
  headCommit: localPrCommitSchema,
  expectedTargetCommit: localPrCommitSchema.optional(),
};

/** Agent 向けの全操作。GUI 専用の操作には、意図的にここで公開スキーマを定義しない。 */
export const localPrAgentInput = {
  pr_list: z.strictObject({
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  pr_branches: z.strictObject({}),
  pr_get: z.strictObject(prId),
  pr_create: z.strictObject({
    ...submitInput,
    targetBranch: branch,
    sourceBranch: branch.optional(),
    title: text(200),
    description: z.string().max(20000).optional(),
  }),
  pr_submit: z.strictObject({
    ...prId,
    ...submitInput,
    expectedVersion: version,
  }),
  pr_close: z.strictObject({ ...prVersion }),
  pr_diff: z.strictObject({
    ...prVersion,
    mode: z.enum(["full", "previous"]),
    path: path.optional(),
  }),
  pr_comment: commentInput,
  pr_merge: localPrApprovalTargetSchema,
  pr_ci_validate: z.strictObject(prVersion),
  pr_ci_list: z.strictObject(prVersion),
  pr_ci_start: z.strictObject(prVersion),
  pr_ci_cancel: z.strictObject({ ...prVersion, runId: id }),
  pr_ci_rerun: z.strictObject({ ...prVersion, runId: id }),
  pr_ci_log: z.strictObject({
    ...prVersion,
    runId: id,
    offset: z.number().int().nonnegative().optional(),
  }),
} as const;

/** Agentに公開した各PR操作の成功時に渡すデータを検証する。 */
export const localPrAgentData = {
  pr_list: z.strictObject({
    entries: z.array(prSummary),
    hasMore: z.boolean(),
  }),
  pr_branches: z.strictObject({
    branches: z.array(
      z.strictObject({ ref: branch, commit: localPrCommitSchema }),
    ),
    head: localPrCommitSchema.nullable(),
    headBranch: branch.nullable(),
  }),
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
  pr_ci_log: z.strictObject({
    log: z.string(),
    nextOffset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
} as const satisfies Record<keyof typeof localPrAgentInput, z.ZodType>;

/** 信頼済みのメインフレーム IPC 専用。これらの操作を Agent ツールに展開しない。 */
export const localPrGuiInput = {
  ...localPrAgentInput,
  approve: localPrApprovalTargetSchema,
  revoke: localPrApprovalTargetSchema,
  save_draft: commentInput.extend({ commentId: id.optional() }),
  discard_draft: z.strictObject({ ...prId, commentId: id }),
  publish_drafts: z.strictObject({
    ...prId,
    commentIds: z.array(id).min(1).max(50),
  }),
  session_choices: z.strictObject({
    query: z.string().max(300).optional(),
    offset: z.number().int().nonnegative().optional(),
    preferred: sessionTargetSchema.optional(),
  }),
  discuss: z.strictObject({
    ...prVersion,
    target: sessionTargetSchema,
    commentIds: z.array(id).max(50),
    message: text(20000),
    requestId: id,
  }),
} as const;

/** Agentと共通の結果に、承認・下書き・相談などウィンドウ専用操作の結果を加える。 */
export const localPrGuiData = {
  ...localPrAgentData,
  approve: localPrDetailSchema,
  revoke: localPrDetailSchema,
  save_draft: localPrCommentSchema,
  discard_draft: z.strictObject({ commentId: id }),
  publish_drafts: z.strictObject({ comments: z.array(localPrCommentSchema) }),
  session_choices: z.strictObject({
    sessions: z.array(
      z.strictObject({
        target: sessionTargetSchema,
        title: z.string(),
        character: z.string().optional(),
        iconPath: z.string().optional(),
      }),
    ),
    hasMore: z.boolean(),
  }),
  discuss: z.strictObject({ receiptId: z.string() }),
} as const satisfies Record<keyof typeof localPrGuiInput, z.ZodType>;

/** 失敗の診断に加え、操作の作用がなかったか結果不明かを区別する。 */
export const localPrFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  effect: z.enum(["none", "unknown"]),
});

/** AgentのMCP・CLIに公開するPR操作名。 */
export type LocalPrAgentOperation = keyof typeof localPrAgentInput;
/** 承認や下書きを含め、ウィンドウから呼び出せる操作名。 */
export type LocalPrOperation = keyof typeof localPrGuiInput;
/** ウィンドウ操作ごとの入力型。対象や提出版が必要かは操作によって異なる。 */
export type LocalPrInput<T extends LocalPrOperation> = z.infer<
  (typeof localPrGuiInput)[T]
>;
/** ウィンドウ操作が成功した場合に返す、操作固有のデータ。 */
export type LocalPrData<T extends LocalPrOperation> = z.infer<
  (typeof localPrGuiData)[T]
>;
/** 操作内容に関係なく返せるエラーとその作用の確実性。 */
export type LocalPrFailure = z.infer<typeof localPrFailureSchema>;
/** 操作固有の成功データと、共通形式の失敗のいずれかを返す。 */
export type LocalPrResult<T extends LocalPrOperation> =
  { ok: true; data: LocalPrData<T> } | LocalPrFailure;
/** 元とマージ先のコミットを固定したPRの提出版。 */
export type LocalPrVersion = z.infer<typeof localPrVersionSchema>;
/** 提出版と対象を持つコメント。返信先と下書きかどうかも区別する。 */
export type LocalPrComment = z.infer<typeof localPrCommentSchema>;
/** 版の履歴、レビューコメント、承認と現在のマージ先を含むPR詳細。 */
export type LocalPrDetail = z.infer<typeof localPrDetailSchema>;
/** 特定の提出に対するCI実行の進行状況または終了結果。 */
export type LocalPrCiRun = z.infer<typeof localPrCiRunSchema>;

/** renderer からの呼び出しでは、Main が所有する Window に紐付いたリポジトリと送信元 Session が固定される。 */
export type LocalPrWindowApi = {
  /** ウィンドウの所有リポジトリで、操作名に対応する入力を処理する。 */
  execute<T extends LocalPrOperation>(
    operation: T,
    input: LocalPrInput<T>,
  ): Promise<LocalPrResult<T>>;
  /** ファイル選択画面で選ばれた添付候補のパスを受け取る。 */
  pickAttachment(): Promise<string[]>;
  /** クリップボードのFileから、既存の実ファイルパスを取り出す。 */
  clipboardFilePath(file: File): string;
  /** パスを持たないクリップボード画像を保存し、添付に使うパスを返す。 */
  saveClipboardImage(request: {
    mimeType: string;
    data: ArrayBuffer;
  }): Promise<string>;
  /** ウィンドウの所有元から添付の対象を解決して開き、開いた結果を返す。 */
  openAttachment(
    target: string,
  ): Promise<import("../window/withmate-window-types.js").OpenPathResult>;
  /** 添付画像を分割取得する前に、サイズや版などの情報を調べる。 */
  inspectImage(target: string): Promise<SessionFileDescriptor>;
  /** 添付画像の必要な部分だけを、事前に調べた版に対して取得する。 */
  readImageChunk(
    request: Omit<SessionImageChunkRequest, "sessionId" | "baseResource">,
  ): Promise<SessionFileChunkResult>;
  /** 同じウィンドウで表示するPRの変更を購読し、解除関数を返す。 */
  subscribeChanged(listener: () => void): () => void;
};
