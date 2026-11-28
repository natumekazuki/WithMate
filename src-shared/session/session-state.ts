import {
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
  type ApprovalMode,
} from "../settings/approval-mode.js";
import { sessionReplySchema, type SessionReply } from "./session-reply.js";
import { getDefaultApprovalModeForProvider } from "../settings/provider-runtime-options.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  normalizeCodexSandboxMode,
  type CodexSandboxMode,
} from "../settings/codex-sandbox-mode.js";
import {
  DEFAULT_CODEX_SPEED,
  normalizeCodexSpeed,
  type CodexSpeed,
} from "../settings/codex-speed.js";
import {
  DEFAULT_CODEX_REVIEWER,
  normalizeCodexReviewer,
  type CodexReviewer,
} from "../settings/codex-reviewer.js";
import {
  normalizeCharacterThemeColors,
  type CharacterThemeColors,
} from "../character/character-state.js";
import type { CharacterRuntimeSnapshot } from "../character/character-catalog.js";
import {
  isUnknownCharacterOwnerId,
  recoverStoredCharacterOwnerId,
  requireCharacterOwnerId,
} from "../character/character-owner.js";
import { normalizeCharacterRuntimeSnapshot } from "../character/character-runtime-snapshot.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  isModelReasoningEffort,
  normalizeProviderId,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "../settings/model-catalog.js";
import {
  type MessageOperation,
  type ChangedFile,
  type DiffRow,
  type RunCheck,
  type ElicitationRecord,
  type ComposerAttachment,
} from "./runtime-state.js";
import { currentTimestampLabel } from "../time-state.js";
import {
  normalizeProviderOutput,
  type ProviderOutput,
} from "./provider-output.js";
import {
  normalizeSessionRelationship,
  type SessionRelationship,
  type SessionRole,
} from "./session-role.js";

/** メッセージに添付する実行結果。活動の概要、操作の時系列、変更ファイル、確認結果をまとめる。 */
export type MessageArtifact = {
  title: string;
  activitySummary: string[];
  operationTimeline?: MessageOperation[];
  changedFiles: ChangedFile[];
  runChecks: RunCheck[];
  detailAvailable?: boolean;
};

/** 既存ターンへの追加入力の配送状態。結果未確定、送達確認済み、確認不能、未送信を区別する。 */
export type TurnInputDeliveryState =
  "pending" | "confirmed" | "unknown" | "not-sent";
/** 保存したユーザー入力の配送記録。WithMate と Provider のターン識別子を区別し、添付や配送来歴を保持する。 */
export type TurnInputMetadata = {
  turnId: string;
  nativeTurnId: string;
  state: TurnInputDeliveryState;
  queueId?: string;
  questionRequestId?: string;
  origin?: import("./session-turn-queue.js").SessionSteerOrigin;
  attachments: ComposerAttachment[];
};

/** 会話履歴の発言。本文のほか、返信先、実行結果、質問と回答の記録など、発言に付随する情報を持てる。 */
export type Message = {
  replyTo?: SessionReply;
  output?: ProviderOutput;
  turnInput?: TurnInputMetadata;
  runFailure?: string;
  historyIndex?: number;
  role: "user" | "assistant";
  text: string;
  accent?: boolean;
  isBookmarked?: boolean;
  artifact?: MessageArtifact;
  elicitationRecords?: ElicitationRecord[];
};

/** Session の活動表示に使う短いテキストと、表示時刻・トーン。 */
export type StreamEntry = {
  mood: "spark" | "calm" | "warm";
  time: string;
  text: string;
};

/** 新規 Session に付与し、旧形式を読み取り専用として扱う判定に使う論理スキーマ版。 */
export const CURRENT_SESSION_SCHEMA_VERSION = 5;

/** 通常の作業と Character 作成を目的とする Session を区別する。 */
export type SessionKind = "default" | "character-authoring";
/** 保存値と入力の正規化で認める、通常利用と旧形式の読み取り専用モード。 */
export const SESSION_ACCESS_MODE_VALUES = [
  "active",
  "legacy_readonly",
] as const;
/** Session に記録する明示的な利用モード。スキーマ版による読み取り専用判定は別途行う。 */
export type SessionAccessMode = (typeof SESSION_ACCESS_MODE_VALUES)[number];

/** Session の設定と詳細。Crew 内の関係、実行環境、Character のスナップショット、会話と活動履歴を保持する。 */
export type Session = Partial<SessionRelationship> & {
  id: string;
  incarnationId?: string;
  taskTitle: string;
  description?: string;
  status: "running" | "idle" | "saved";
  updatedAt: string;
  isPinned: boolean;
  provider: string;
  catalogRevision: number;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  sessionKind: SessionKind;
  accessMode: SessionAccessMode;
  sourceSchemaVersion: number;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  runState: string;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  withMateReviewerExplicit?: true;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  messages: Message[];
  messageCount?: number;
  latestUserMessage?: Message | null;
  stream: StreamEntry[];
};

/** Session 一覧や詳細の再取得判定に使う概要。会話・活動履歴・Character の実行時スナップショットは含めない。 */
export type SessionSummary = Omit<
  Session,
  "messages" | "stream" | "characterRuntimeSnapshot" | "isPinned"
> & {
  characterDescription?: string;
  isPinned: boolean;
};
/** 概要と区別して取得する Session の詳細。会話と活動履歴を含む。 */
export type SessionDetail = Session;

/** Home の一覧に必要な表示用の概要。承認待ちや取り消し処理中、未読結果などの表示状態を持てる。 */
export type HomeSessionSummary = {
  id: string;
  taskTitle: string;
  status: Session["status"];
  updatedAt: string;
  isPinned: boolean;
  workspaceLabel: string;
  workspacePath: string;
  sessionKind: SessionKind;
  accessMode: SessionAccessMode;
  sourceSchemaVersion: number;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  runState: string;
  cancellationState?: "requested" | "terminating";
  approvalPending?: boolean;
  hasUnreadResult?: boolean;
};

/** Home の一覧取得で選べる範囲。最近の Session、ピン留め済み、開いている Session を区別する。 */
export const SESSION_SUMMARY_PAGE_SCOPES = [
  "recent",
  "pinned",
  "open",
] as const;
/** Home の概要ページを取得するときに選択する一覧の範囲。 */
export type SessionSummaryPageScope =
  (typeof SESSION_SUMMARY_PAGE_SCOPES)[number];

/** Home の概要一覧を絞り込む要求。開いている Session は ID で指定し、ほかの一覧ではカーソルや検索語を使う。 */
export type SessionSummaryPageRequest = {
  scope?: SessionSummaryPageScope;
  cursor?: string | null;
  limit?: number | null;
  searchText?: string | null;
  sessionIds?: readonly string[] | null;
};

/** Home の概要一覧の1ページ。項目とともに、続きの有無と次回取得用のカーソルを返す。 */
export type HomeSessionSummaryPageResult = {
  entries: HomeSessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};
/** Session 一覧 API が返すページ。各項目は詳細ではなく Home 用の概要。 */
export type SessionSummaryPageResult = HomeSessionSummaryPageResult;

/** 通常の Session で使用されている Character を集計・表示するための識別情報。 */
export type SessionCharacterUsage = {
  characterId: string;
  sessionKind: "default";
};

/** 概要一覧の再取得が必要な範囲を通知する。個別 ID または全件を指定し、詳細が変わっていないことも示せる。 */
export type SessionSummaryInvalidation = (
  { scope: "ids"; sessionIds: string[] } | { scope: "all" }
) & { detailChanged?: false };

/** ファイル差分のプレビューを開くために渡す、対象ファイル、画面の見出し、テーマ色。 */
export type DiffPreviewPayload = {
  title: string;
  file: ChangedFile;
  themeColors: CharacterThemeColors;
};

/** Session の初期状態を組み立てるための入力。解決済みの作業先、Character、実行設定と必要な関係情報を渡す。 */
export type CreateSessionInput = {
  id?: string;
  sessionRole?: SessionRole;
  rootSessionId?: string;
  parentSessionId?: string | null;
  createdBySessionId?: string | null;
  description?: string;
  provider?: string;
  catalogRevision?: number;
  taskTitle: string;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  sessionKind?: SessionKind;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
  approvalMode: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  codexReviewer?: CodexReviewer;
  withMateReviewerExplicit?: true;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  customAgentName?: string;
  allowedAdditionalDirectories?: string[];
};

/** 新規 Session の作業先。既存ディレクトリとその情報を指定するか、Session 用フォルダーを使う。 */
export type CreateSessionWorkspaceRequest =
  | {
      kind: "directory";
      label: string;
      path: string;
      branch: string;
    }
  | {
      kind: "session-folder";
    };

/** 作業先の解決や実行設定の決定を作成側に任せる Session 作成要求。クライアント要求 ID を付けられる。 */
export type CreateSessionRequest = Omit<
  CreateSessionInput,
  | "id"
  | "workspaceLabel"
  | "workspacePath"
  | "branch"
  | "approvalMode"
  | "codexSandboxMode"
  | "codexSpeed"
  | "codexReviewer"
  | "withMateReviewerExplicit"
  | "model"
  | "reasoningEffort"
  | "customAgentName"
> & {
  workspace: CreateSessionWorkspaceRequest;
  clientRequestId?: string;
};

/** 指定した Session のピン留め状態を、トグルではなく真偽値で設定する要求。 */
export type SetSessionPinnedRequest = {
  sessionId: string;
  isPinned: boolean;
};

/** ピン留め要求の Session ID をトリムし、空の ID や真偽値でないピン指定を例外で拒否する。 */
export function parseSetSessionPinnedRequest(
  value: unknown,
): SetSessionPinnedRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid session pin request.");
  }
  const candidate = value as Partial<SetSessionPinnedRequest>;
  const sessionId =
    typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
  if (!sessionId || typeof candidate.isPinned !== "boolean") {
    throw new Error("Invalid session pin request.");
  }
  return { sessionId, isPinned: candidate.isPinned };
}

/** 既知のアクセスモードを採用し、未知または未指定の場合は指定の既定値へ戻す。 */
export function normalizeSessionAccessMode(
  value: unknown,
  fallback: SessionAccessMode = "active",
): SessionAccessMode {
  return SESSION_ACCESS_MODE_VALUES.includes(value as SessionAccessMode)
    ? (value as SessionAccessMode)
    : fallback;
}

/** 旧形式の読み取り専用モードが明示されているかを判定する。スキーマ版は調べない。 */
export function isLegacyReadOnlySession(
  session: Pick<Session, "accessMode"> | Pick<SessionSummary, "accessMode">,
): boolean {
  return session.accessMode === "legacy_readonly";
}

/** 明示的な読み取り専用モードに加え、現行より古いスキーマ版の Session も読み取り専用と判定する。 */
export function isReadOnlySession(
  session:
    | Pick<Session, "accessMode" | "sourceSchemaVersion">
    | Pick<SessionSummary, "accessMode" | "sourceSchemaVersion">,
): boolean {
  return (
    isLegacyReadOnlySession(session) ||
    session.sourceSchemaVersion < CURRENT_SESSION_SCHEMA_VERSION
  );
}

/** 既知の行種別を持つ差分だけを復元し、数値でない行番号や文字列でない本文を落とす。 */
function normalizeDiffRow(value: unknown): DiffRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<DiffRow>;
  if (
    candidate.kind !== "context" &&
    candidate.kind !== "add" &&
    candidate.kind !== "delete" &&
    candidate.kind !== "modify"
  ) {
    return null;
  }

  return {
    kind: candidate.kind,
    leftNumber:
      typeof candidate.leftNumber === "number"
        ? candidate.leftNumber
        : undefined,
    rightNumber:
      typeof candidate.rightNumber === "number"
        ? candidate.rightNumber
        : undefined,
    leftText:
      typeof candidate.leftText === "string" ? candidate.leftText : undefined,
    rightText:
      typeof candidate.rightText === "string" ? candidate.rightText : undefined,
  };
}

/** 既知の変更種別のファイルだけを復元し、その差分行に不正な項目があれば除く。 */
function normalizeChangedFile(value: unknown): ChangedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ChangedFile>;
  if (
    candidate.kind !== "add" &&
    candidate.kind !== "edit" &&
    candidate.kind !== "delete"
  ) {
    return null;
  }

  return {
    kind: candidate.kind,
    path: typeof candidate.path === "string" ? candidate.path : "",
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    diffRows: Array.isArray(candidate.diffRows)
      ? candidate.diffRows
          .map((row) => normalizeDiffRow(row))
          .filter((row): row is DiffRow => row !== null)
      : [],
  };
}

/** 種別がある操作だけを復元する。有限の終了コードや本文を持つエラーなど、妥当な補足情報だけを残す。 */
function normalizeMessageOperation(value: unknown): MessageOperation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<MessageOperation>;
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return null;
  }

  return {
    type: candidate.type,
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    details:
      typeof candidate.details === "string" ? candidate.details : undefined,
    id: typeof candidate.id === "string" ? candidate.id : undefined,
    status: typeof candidate.status === "string" ? candidate.status : undefined,
    exitCode:
      typeof candidate.exitCode === "number" &&
      Number.isFinite(candidate.exitCode)
        ? candidate.exitCode
        : undefined,
    error:
      candidate.error && typeof candidate.error.message === "string"
        ? {
            message: candidate.error.message,
            ...(typeof candidate.error.code === "string"
              ? { code: candidate.error.code }
              : {}),
          }
        : undefined,
    truncated:
      typeof candidate.truncated === "boolean"
        ? candidate.truncated
        : undefined,
    detailAvailable:
      typeof candidate.detailAvailable === "boolean"
        ? candidate.detailAvailable
        : undefined,
  };
}

/** 承認欄の値だけを承認モードとして正規化し、その他の確認欄は文字列のまま扱う。 */
function normalizeRunCheckValue(label: string, value: unknown): string {
  const normalizedValue = typeof value === "string" ? value : "";
  return label.trim().toLowerCase() === "approval"
    ? normalizeApprovalMode(normalizedValue, DEFAULT_APPROVAL_MODE)
    : normalizedValue;
}

/** 空でないラベルを持つ確認項目を復元し、ラベルに応じて表示値を整える。 */
function normalizeRunCheck(value: unknown): RunCheck | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<RunCheck>;
  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    return null;
  }

  return {
    label: candidate.label,
    value: normalizeRunCheckValue(candidate.label, candidate.value),
  };
}

/** 実行結果の記録から表示できる活動、差分、確認項目を復元する。記録の形でなければ省略する。 */
function normalizeMessageArtifact(value: unknown): MessageArtifact | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<MessageArtifact>;
  const operationTimeline = Array.isArray(candidate.operationTimeline)
    ? candidate.operationTimeline
        .map((operation) => normalizeMessageOperation(operation))
        .filter(
          (operation): operation is MessageOperation => operation !== null,
        )
    : undefined;

  return {
    title: typeof candidate.title === "string" ? candidate.title : "",
    activitySummary: Array.isArray(candidate.activitySummary)
      ? candidate.activitySummary.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    operationTimeline,
    changedFiles: Array.isArray(candidate.changedFiles)
      ? candidate.changedFiles
          .map((file) => normalizeChangedFile(file))
          .filter((file): file is ChangedFile => file !== null)
      : [],
    runChecks: Array.isArray(candidate.runChecks)
      ? candidate.runChecks
          .map((check) => normalizeRunCheck(check))
          .filter((check): check is RunCheck => check !== null)
      : [],
    detailAvailable:
      typeof candidate.detailAvailable === "boolean"
        ? candidate.detailAvailable
        : undefined,
  };
}

/** 保存した質問履歴を読み出す。待機中だった質問は期限切れにし、選択位置が選択肢と整合しない回答は除く。 */
function normalizeElicitationRecords(
  value: unknown,
): ElicitationRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: ElicitationRecord[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Partial<ElicitationRecord>;
    if (
      typeof record.requestId !== "string" ||
      typeof record.message !== "string" ||
      !Array.isArray(record.fields) ||
      !["pending", "answered", "declined", "canceled", "expired"].includes(
        record.status ?? "",
      )
    )
      continue;
    records.push({
      requestId: record.requestId,
      message: record.message,
      ...(record.kind === "question" ? { kind: record.kind } : {}),
      ...(record.textRange &&
      Number.isSafeInteger(record.textRange.start) &&
      Number.isSafeInteger(record.textRange.end) &&
      record.textRange.start >= 0 &&
      record.textRange.end >= record.textRange.start
        ? {
            textRange: {
              start: record.textRange.start,
              end: record.textRange.end,
            },
          }
        : {}),
      status: record.status === "pending" ? "expired" : record.status!,
      fields: record.fields
        .filter((field) => field && typeof field.title === "string")
        .map((field) => ({
          title: field.title,
          ...(typeof field.description === "string"
            ? { description: field.description }
            : {}),
          ...(Array.isArray(field.options)
            ? {
                options: field.options.filter(
                  (option): option is string => typeof option === "string",
                ),
              }
            : {}),
          ...(field.answer &&
          Array.isArray(field.answer.selected) &&
          Array.isArray(field.answer.text) &&
          (field.options === undefined ||
            (Array.isArray(field.options) &&
              field.options.every((option) => typeof option === "string"))) &&
          field.answer.selected.every(
            (index) =>
              Number.isSafeInteger(index) &&
              index >= 0 &&
              index < (Array.isArray(field.options) ? field.options.length : 0),
          ) &&
          field.answer.text.every((text) => typeof text === "string")
            ? {
                answer: {
                  selected: [...field.answer.selected],
                  text: [...field.answer.text],
                },
              }
            : {}),
        })),
    });
  }
  return records.length ? records : undefined;
}

/** 保存値からユーザーまたはアシスタントの発言を復元する。不正な返信先や追加入力の配送情報は例外で拒否する。 */
export function normalizeMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Message>;
  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return null;
  }
  if (
    candidate.turnInput !== undefined &&
    (candidate.role !== "user" ||
      !candidate.turnInput ||
      typeof candidate.turnInput.turnId !== "string" ||
      !candidate.turnInput.turnId.trim() ||
      typeof candidate.turnInput.nativeTurnId !== "string" ||
      !candidate.turnInput.nativeTurnId.trim() ||
      !["pending", "confirmed", "unknown", "not-sent"].includes(
        candidate.turnInput.state,
      ) ||
      !Array.isArray(candidate.turnInput.attachments))
  )
    throw new Error("The saved Turn input metadata is invalid.");
  const inputOrigin = candidate.turnInput?.origin;
  if (
    inputOrigin !== undefined &&
    (!inputOrigin ||
      inputOrigin.kind !== "session" ||
      inputOrigin.actorKind !== "main" ||
      inputOrigin.operation !== "steer" ||
      [
        inputOrigin.actorSessionId,
        inputOrigin.actorIncarnationId,
        inputOrigin.actorTurnId,
        inputOrigin.targetSessionId,
        inputOrigin.targetIncarnationId,
      ].some((value) => typeof value !== "string" || !value.trim()))
  )
    throw new Error("The saved Steer origin is invalid.");

  return {
    role: candidate.role,
    text: typeof candidate.text === "string" ? candidate.text : "",
    ...(candidate.replyTo === undefined
      ? {}
      : { replyTo: sessionReplySchema.parse(candidate.replyTo) }),
    ...(candidate.output
      ? {
          output: normalizeProviderOutput(
            candidate.output,
            typeof candidate.text === "string" ? candidate.text : "",
          ),
        }
      : {}),
    ...(candidate.turnInput
      ? { turnInput: structuredClone(candidate.turnInput) }
      : {}),
    ...(candidate.role === "assistant" &&
    typeof candidate.runFailure === "string"
      ? { runFailure: candidate.runFailure }
      : {}),
    accent:
      typeof candidate.accent === "boolean" ? candidate.accent : undefined,
    artifact: normalizeMessageArtifact(candidate.artifact),
    ...(candidate.elicitationRecords
      ? {
          elicitationRecords: normalizeElicitationRecords(
            candidate.elicitationRecords,
          ),
        }
      : {}),
    ...(candidate.isBookmarked === true ? { isBookmarked: true } : {}),
  };
}

/** true の保存値だけをブックマーク済みとして扱う。 */
export function isMessageBookmarked(
  message: Pick<Message, "isBookmarked">,
): boolean {
  return message.isBookmarked === true;
}

/** 元の発言を変更せず、ブックマークを設定したコピーを返す。解除時は保存用のキー自体を取り除く。 */
export function setMessageBookmarked(
  message: Message,
  isBookmarked: boolean,
): Message {
  if (isBookmarked) {
    return { ...message, isBookmarked: true };
  }

  const nextMessage = { ...message };
  delete nextMessage.isBookmarked;
  return nextMessage;
}

/** 保存値から一覧用の共通情報を復元し、不足する項目を既定値で補う。Character の所有者が不明なら Provider スレッドを引き継がない。 */
function normalizeSessionSummaryShape(value: unknown): SessionSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<
    Session & { characterDescription: string }
  >;
  const characterName =
    typeof candidate.character === "string" && candidate.character.trim()
      ? candidate.character
      : "Character";
  const characterId = recoverStoredCharacterOwnerId(candidate.characterId);
  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id
      : `legacy-${Date.now()}`;

  return {
    id,
    ...normalizeSessionRelationship({ ...candidate, id }),
    description:
      typeof candidate.description === "string" ? candidate.description : "",
    incarnationId:
      typeof candidate.incarnationId === "string" &&
      candidate.incarnationId.trim()
        ? candidate.incarnationId.trim()
        : undefined,
    taskTitle:
      typeof candidate.taskTitle === "string" && candidate.taskTitle.trim()
        ? candidate.taskTitle
        : "Untitled session",
    status:
      candidate.status === "running" ||
      candidate.status === "idle" ||
      candidate.status === "saved"
        ? candidate.status
        : "idle",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt === "just now"
          ? currentTimestampLabel()
          : candidate.updatedAt
        : currentTimestampLabel(),
    isPinned: candidate.isPinned === true,
    provider: normalizeProviderId(candidate.provider),
    catalogRevision:
      typeof candidate.catalogRevision === "number" &&
      Number.isInteger(candidate.catalogRevision) &&
      candidate.catalogRevision > 0
        ? candidate.catalogRevision
        : 1,
    workspaceLabel:
      typeof candidate.workspaceLabel === "string" &&
      candidate.workspaceLabel.trim()
        ? candidate.workspaceLabel
        : "workspace",
    workspacePath:
      typeof candidate.workspacePath === "string"
        ? candidate.workspacePath
        : "",
    branch:
      typeof candidate.branch === "string" && candidate.branch.trim()
        ? candidate.branch
        : "main",
    sessionKind:
      candidate.sessionKind === "character-authoring"
        ? candidate.sessionKind
        : "default",
    accessMode: normalizeSessionAccessMode(
      (candidate as { accessMode?: unknown }).accessMode,
    ),
    sourceSchemaVersion:
      typeof candidate.sourceSchemaVersion === "number" &&
      Number.isInteger(candidate.sourceSchemaVersion) &&
      candidate.sourceSchemaVersion > 0
        ? candidate.sourceSchemaVersion
        : CURRENT_SESSION_SCHEMA_VERSION - 1,
    characterId,
    character: characterName,
    ...(typeof candidate.characterRuntimeSnapshot?.description === "string" &&
    candidate.characterRuntimeSnapshot.description
      ? { characterDescription: candidate.characterRuntimeSnapshot.description }
      : typeof candidate.characterDescription === "string" &&
          candidate.characterDescription
        ? { characterDescription: candidate.characterDescription }
        : {}),
    characterIconPath:
      typeof candidate.characterIconPath === "string" &&
      candidate.characterIconPath.trim()
        ? candidate.characterIconPath
        : "",
    characterThemeColors: normalizeCharacterThemeColors(
      candidate.characterThemeColors,
    ),
    runState:
      typeof candidate.runState === "string" && candidate.runState.trim()
        ? candidate.runState
        : "idle",
    approvalMode: normalizeApprovalMode(
      candidate.approvalMode,
      DEFAULT_APPROVAL_MODE,
    ),
    codexSandboxMode: normalizeCodexSandboxMode(
      (candidate as { codexSandboxMode?: unknown }).codexSandboxMode,
      DEFAULT_CODEX_SANDBOX_MODE,
    ),
    codexSpeed: normalizeCodexSpeed(
      (candidate as { codexSpeed?: unknown }).codexSpeed,
    ),
    codexReviewer: normalizeCodexReviewer(
      (candidate as { codexReviewer?: unknown }).codexReviewer,
    ),
    ...(candidate.withMateReviewerExplicit === true
      ? { withMateReviewerExplicit: true }
      : {}),
    model:
      typeof candidate.model === "string" && candidate.model.trim()
        ? candidate.model.trim()
        : DEFAULT_MODEL_ID,
    reasoningEffort: isModelReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : DEFAULT_REASONING_EFFORT,
    customAgentName:
      typeof candidate.customAgentName === "string"
        ? candidate.customAgentName.trim()
        : "",
    allowedAdditionalDirectories: Array.isArray(
      (candidate as { allowedAdditionalDirectories?: unknown[] })
        .allowedAdditionalDirectories,
    )
      ? ((
          candidate as { allowedAdditionalDirectories?: unknown[] }
        ).allowedAdditionalDirectories
          ?.filter(
            (directory): directory is string => typeof directory === "string",
          )
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0) ?? [])
      : [],
    threadId: isUnknownCharacterOwnerId(characterId)
      ? ""
      : typeof candidate.threadId === "string"
        ? candidate.threadId
        : typeof (candidate as { threadLabel?: string }).threadLabel ===
            "string"
          ? ((candidate as { threadLabel?: string }).threadLabel ?? "")
          : "",
  };
}

/** 前後の空白を除いた世代 ID を返す。未記録の旧形式では Session ID から代替値を作る。 */
export function getSessionIncarnationId(
  session: Pick<Session, "id" | "incarnationId">,
): string {
  return session.incarnationId?.trim() || `legacy:${session.id}`;
}

/** 未検証の値から Session の概要を読み出す。オブジェクトとして読み取れなければ null を返す。 */
export function normalizeSessionSummary(value: unknown): SessionSummary | null {
  return normalizeSessionSummaryShape(value);
}

/** ID を持つ値から Home の一覧で使う項目だけを整える。空の ID は補完せず null とする。 */
function normalizeHomeSessionSummaryShape(
  value: unknown,
): HomeSessionSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<HomeSessionSummary>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return null;
  }

  const characterName =
    typeof candidate.character === "string" && candidate.character.trim()
      ? candidate.character
      : "Character";
  return {
    id,
    taskTitle:
      typeof candidate.taskTitle === "string" && candidate.taskTitle.trim()
        ? candidate.taskTitle
        : "Untitled session",
    status:
      candidate.status === "running" ||
      candidate.status === "idle" ||
      candidate.status === "saved"
        ? candidate.status
        : "idle",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt === "just now"
          ? currentTimestampLabel()
          : candidate.updatedAt
        : currentTimestampLabel(),
    isPinned: candidate.isPinned === true,
    workspaceLabel:
      typeof candidate.workspaceLabel === "string" &&
      candidate.workspaceLabel.trim()
        ? candidate.workspaceLabel
        : "workspace",
    workspacePath:
      typeof candidate.workspacePath === "string"
        ? candidate.workspacePath
        : "",
    sessionKind:
      candidate.sessionKind === "character-authoring"
        ? candidate.sessionKind
        : "default",
    accessMode: normalizeSessionAccessMode(candidate.accessMode),
    sourceSchemaVersion:
      typeof candidate.sourceSchemaVersion === "number" &&
      Number.isInteger(candidate.sourceSchemaVersion) &&
      candidate.sourceSchemaVersion > 0
        ? candidate.sourceSchemaVersion
        : CURRENT_SESSION_SCHEMA_VERSION - 1,
    characterId: recoverStoredCharacterOwnerId(candidate.characterId),
    character: characterName,
    characterIconPath:
      typeof candidate.characterIconPath === "string" &&
      candidate.characterIconPath.trim()
        ? candidate.characterIconPath
        : "",
    characterThemeColors: normalizeCharacterThemeColors(
      candidate.characterThemeColors,
    ),
    runState:
      typeof candidate.runState === "string" && candidate.runState.trim()
        ? candidate.runState
        : "idle",
    ...(candidate.cancellationState === "requested" ||
    candidate.cancellationState === "terminating"
      ? { cancellationState: candidate.cancellationState }
      : {}),
    ...(candidate.approvalPending === true ? { approvalPending: true } : {}),
  };
}

/** 未検証の値を Home 用の概要として読み出し、有効な Session ID がなければ null を返す。 */
export function normalizeHomeSessionSummary(
  value: unknown,
): HomeSessionSummary | null {
  return normalizeHomeSessionSummaryShape(value);
}

/** Session の詳細・概要から Home の表示項目を切り出す。Home 項目に変換できなければ例外を送出する。 */
export function projectHomeSessionSummary(
  session: Session | SessionSummary | HomeSessionSummary,
): HomeSessionSummary {
  const summary = normalizeHomeSessionSummaryShape(session);
  if (!summary) {
    throw new Error("Could not convert the session to a Home summary.");
  }

  return summary;
}

/** Session から会話や活動履歴を含まない概要を作り、概要化できなければ例外を送出する。 */
export function projectSessionSummary(
  session: Session | SessionSummary,
): SessionSummary {
  const summary = normalizeSessionSummaryShape(session);
  if (!summary) {
    throw new Error("Could not convert the session to a summary.");
  }

  return summary;
}

/** 保存値から Session の詳細を復元する。Character スナップショットが不正または所有者不一致なら、スナップショットと Provider スレッドの参照を外す。 */
export function normalizeSession(value: unknown): Session | null {
  const summary = normalizeSessionSummaryShape(value);
  if (!summary || !value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Session>;
  const storedSnapshot = (candidate as { characterRuntimeSnapshot?: unknown })
    .characterRuntimeSnapshot;
  const normalizedSnapshot = normalizeCharacterRuntimeSnapshot(storedSnapshot);
  const rejectedStoredSnapshot =
    storedSnapshot !== undefined &&
    storedSnapshot !== null &&
    (!normalizedSnapshot ||
      normalizedSnapshot.characterId !== summary.characterId);
  const characterRuntimeSnapshot = rejectedStoredSnapshot
    ? null
    : normalizedSnapshot;

  return {
    ...summary,
    threadId: rejectedStoredSnapshot ? "" : summary.threadId,
    characterRuntimeSnapshot,
    messages: Array.isArray(candidate.messages)
      ? candidate.messages
          .map((message) => normalizeMessage(message))
          .filter((message): message is Message => message !== null)
      : [],
    stream: Array.isArray(candidate.stream) ? candidate.stream : [],
  };
}

/** JSON で往復できる Session 詳細を複製し、会話や設定のオブジェクトを共有しない配列を返す。 */
export function cloneSessions(sessions: Session[]): Session[] {
  return JSON.parse(JSON.stringify(sessions)) as Session[];
}

/** Session 概要を JSON で複製し、呼び出し元の一覧と参照を共有しない値を返す。 */
export function cloneSessionSummaries(
  sessions: SessionSummary[],
): SessionSummary[] {
  return JSON.parse(JSON.stringify(sessions)) as SessionSummary[];
}

/** Home に渡す概要へ投影し直した上で、JSON で複製する。 */
export function cloneHomeSessionSummaries(
  sessions: HomeSessionSummary[],
): HomeSessionSummary[] {
  return JSON.parse(
    JSON.stringify(
      sessions.map((session) => projectHomeSessionSummary(session)),
    ),
  ) as HomeSessionSummary[];
}

/** 実行結果の概要に載せるテキストを、先頭の最大500 UTF-16 コード単位に制限する。 */
function artifactSummaryText(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value;
}

/** 操作の詳細と差分行を省いた実行結果の概要を作り、別途詳細を取得できることを示す。 */
export function summarizeMessageArtifact(
  artifact: MessageArtifact,
): MessageArtifact {
  return {
    title: artifactSummaryText(artifact.title),
    activitySummary: artifact.activitySummary.map(artifactSummaryText),
    operationTimeline: artifact.operationTimeline?.map((operation) => ({
      type: operation.type,
      summary: artifactSummaryText(operation.summary),
    })),
    changedFiles: artifact.changedFiles.map((file) => ({
      kind: file.kind,
      path: artifactSummaryText(file.path),
      summary: artifactSummaryText(file.summary),
      diffRows: [],
    })),
    runChecks: artifact.runChecks.map((check) => ({ ...check })),
    detailAvailable: true,
  };
}

/** 新規 Session の初期状態を組み立てる。Character のスナップショットを渡す場合は、選択した所有者と一致するものに限る。 */
export function buildNewSession(input: CreateSessionInput): Session {
  const normalizedTaskTitle =
    input.taskTitle.trim() || `Start new work in ${input.workspaceLabel}`;
  const characterId = requireCharacterOwnerId(input.characterId);
  const characterRuntimeSnapshot =
    input.characterRuntimeSnapshot == null
      ? null
      : normalizeCharacterRuntimeSnapshot(input.characterRuntimeSnapshot);
  if (input.characterRuntimeSnapshot != null && !characterRuntimeSnapshot) {
    throw new Error("Invalid Character runtime snapshot.");
  }
  if (
    characterRuntimeSnapshot &&
    characterRuntimeSnapshot.characterId !== characterId
  ) {
    throw new Error(
      "The Character runtime snapshot does not match the selected Character.",
    );
  }
  const id = input.id?.trim() || `launch-${Date.now()}`;
  return {
    id,
    ...normalizeSessionRelationship({ ...input, id }),
    description: input.description ?? "",
    taskTitle: normalizedTaskTitle,
    status: "idle",
    updatedAt: currentTimestampLabel(),
    isPinned: false,
    provider: normalizeProviderId(input.provider ?? DEFAULT_PROVIDER_ID),
    catalogRevision:
      typeof input.catalogRevision === "number" &&
      Number.isInteger(input.catalogRevision) &&
      input.catalogRevision > 0
        ? input.catalogRevision
        : 1,
    workspaceLabel: input.workspaceLabel,
    workspacePath: input.workspacePath,
    branch: input.branch,
    sessionKind: input.sessionKind ?? "default",
    accessMode: "active",
    sourceSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    characterId,
    character: input.character,
    characterIconPath: input.characterIconPath,
    characterThemeColors: normalizeCharacterThemeColors(
      input.characterThemeColors,
    ),
    characterRuntimeSnapshot,
    runState: "idle",
    approvalMode: normalizeApprovalMode(
      input.approvalMode,
      getDefaultApprovalModeForProvider(input.provider),
    ),
    codexSandboxMode: normalizeCodexSandboxMode(
      input.codexSandboxMode,
      DEFAULT_CODEX_SANDBOX_MODE,
    ),
    codexSpeed: normalizeCodexSpeed(input.codexSpeed ?? DEFAULT_CODEX_SPEED),
    codexReviewer: normalizeCodexReviewer(
      input.codexReviewer ?? DEFAULT_CODEX_REVIEWER,
    ),
    ...(input.withMateReviewerExplicit
      ? { withMateReviewerExplicit: true }
      : {}),
    model: input.model?.trim() || DEFAULT_MODEL_ID,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    customAgentName: input.customAgentName?.trim() || "",
    allowedAdditionalDirectories: Array.isArray(
      input.allowedAdditionalDirectories,
    )
      ? input.allowedAdditionalDirectories
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0)
      : [],
    threadId: "",
    messages: [],
    stream: [],
  };
}

/** 解決済みモデル、推論レベル、カタログ版と更新時刻だけを反映し、既存の Provider スレッドを保持する。 */
export function applySessionModelMetadataUpdate(
  session: Session,
  selection: ResolvedModelSelection,
  catalogRevision: number,
  updatedAt: string,
): Session {
  return {
    ...session,
    catalogRevision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    threadId: session.threadId,
    updatedAt,
  };
}

/** モデル選択の結果を Session に適用する。ここでは Provider スレッドを切り替えない。 */
export function applySessionModelSelection(
  session: Session,
  selection: ResolvedModelSelection,
  catalogRevision: number,
  updatedAt: string,
): Session {
  return applySessionModelMetadataUpdate(
    session,
    selection,
    catalogRevision,
    updatedAt,
  );
}

/** Copilot のカスタムエージェント名をトリムして更新する。既存の Provider スレッドはそのまま保持する。 */
export function applyCopilotCustomAgentSelection(
  session: Session,
  customAgentName: string,
  updatedAt: string,
): Session {
  return {
    ...session,
    customAgentName: customAgentName.trim(),
    threadId: session.threadId,
    updatedAt,
  };
}

/**
 * Summary フィールドすべてを連結した文字列を返す。
 * 同一 session でも何らかのフィールドが変われば異なる値になる。
 * `Session` の detail フィールド（messages / stream）は含まない。
 */
export function buildSessionSummarySignature(summary: SessionSummary): string {
  return [
    summary.id,
    getSessionIncarnationId(summary),
    summary.updatedAt,
    String(summary.isPinned),
    summary.status,
    summary.runState,
    summary.taskTitle,
    summary.description ?? "",
    summary.sessionRole ?? "standalone",
    summary.rootSessionId ?? summary.id,
    summary.parentSessionId ?? "",
    summary.createdBySessionId ?? "",
    summary.threadId,
    summary.provider,
    String(summary.catalogRevision),
    summary.model,
    summary.reasoningEffort,
    summary.approvalMode,
    summary.codexSandboxMode,
    summary.codexSpeed,
    summary.codexReviewer,
    summary.withMateReviewerExplicit,
    summary.workspacePath,
    summary.branch,
    summary.sessionKind,
    summary.accessMode,
    String(summary.sourceSchemaVersion),
    summary.characterId,
    summary.character,
    summary.characterIconPath,
    summary.characterThemeColors.main,
    summary.characterThemeColors.sub,
    summary.workspaceLabel,
    summary.customAgentName,
    summary.allowedAdditionalDirectories.join("\u001f"),
  ].join("\u001e");
}

/** 詳細を取得する対象の Session ID と、次回の比較に使う概要の署名。 */
export type HydrationTarget = {
  sessionId: string;
  summarySignature: string;
};

/**
 * 選択中の Session が一覧に存在し、初回または概要の署名が変わったときだけ、詳細取得の対象を返す。
 * 対象が未選択・一覧にない・前回と同じ署名の場合は null とする。
 */
export function selectHydrationTarget(
  nextSummaries: SessionSummary[],
  targetSessionId: string | null,
  lastSummarySignature: string | null,
): HydrationTarget | null {
  if (!targetSessionId) {
    return null;
  }

  const matchedSummary = nextSummaries.find((s) => s.id === targetSessionId);
  if (!matchedSummary) {
    return null;
  }

  const nextSignature = buildSessionSummarySignature(matchedSummary);
  if (lastSummarySignature !== null && nextSignature === lastSummarySignature) {
    return null;
  }

  return { sessionId: targetSessionId, summarySignature: nextSignature };
}
