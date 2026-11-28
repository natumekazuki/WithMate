import { type SessionExecutionOptions } from "./session-execution-options.js";

/** 左右を並べる差分表示の1行。片側に行がなければ、その側の行番号と本文は省略できる。 */
export type DiffRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
};

/** 実行によるファイルの追加・編集・削除と、その概要および行単位の差分。 */
export type ChangedFile = {
  kind: "add" | "edit" | "delete";
  path: string;
  summary: string;
  diffRows: DiffRow[];
};

/** 実行結果の詳細欄に表示する確認項目のラベルと値。 */
export type RunCheck = {
  label: string;
  value: string;
};

/** メッセージに添える操作履歴の項目。概要に加えて、判明している終了コードやエラー、詳細の有無を伝える。 */
export type MessageOperation = {
  id?: string;
  status?: LiveRunStepStatus;
  exitCode?: number;
  error?: { message: string; code?: string };
  truncated?: boolean;
  type: string;
  summary: string;
  details?: string;
  detailAvailable?: boolean;
};

/** Provider が報告するトークン使用量。キャッシュ入力を区別し、報告された場合は推論出力や総数も保持する。 */
export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

/** Provider 固有の応答やイベントを共通表示に変換できなかった場合などに、調査用の種別や元データを残す。 */
export type ProviderDiagnosticMetadata = {
  provider: string;
  kind: "unsupported_response" | "unsupported_event" | (string & {});
  summary: string;
  source?: string;
  responseType?: string;
  eventType?: string;
  payload?: unknown;
};

/** Provider 向けに組み立てたプロンプトを、システム指示、入力、結合後の本文に分けて保持する。 */
export type ProviderLogicalPrompt = {
  systemText: string;
  inputText: string;
  composedText: string;
};

/** 実行中の操作の進行状態。共通状態に加え、Provider が返す追加の状態も表現できる。 */
export type LiveRunStepStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "canceled"
  | "pending"
  | (string & {});

/** 実行中に同じ操作の表示を更新できるよう、識別子と進行状態を必ず持つ操作履歴。 */
export type LiveRunStep = MessageOperation & {
  id: string;
  status: LiveRunStepStatus;
};

/** バックグラウンド作業が子エージェントの処理か、シェルでの実行かを区別する。 */
export type LiveBackgroundTaskKind = "agent" | "shell";

/** バックグラウンド作業の実行中・正常終了・失敗を表す状態。 */
export type LiveBackgroundTaskStatus = "running" | "completed" | "failed";

/** 実行中の表示で追跡するバックグラウンド作業。識別子ごとに種別・状態と最終更新時刻を保持する。 */
export type LiveBackgroundTask = {
  id: string;
  kind: LiveBackgroundTaskKind;
  status: LiveBackgroundTaskStatus;
  title: string;
  details?: string;
  updatedAt: string;
};

/** 実行前の承認確認に対する許可・拒否の選択。 */
export type LiveApprovalDecision = "approve" | "deny";

/** 承認への回答を直接返す方式と、実行ポリシーを変更して再試行する方式の区別。 */
export type LiveApprovalDecisionMode =
  "direct-decision" | "retry-with-policy-change";

/** 実行中に提示する承認確認。回答先の要求 ID と、利用者が判断するための操作概要・警告・回答方式を持つ。 */
export type LiveApprovalRequest = {
  requestId: string;
  textPosition?: number;
  provider: string;
  kind: string;
  title: string;
  summary: string;
  details?: string;
  warning?: string;
  decisionMode: LiveApprovalDecisionMode;
};

/** 入力要求への回答送信・辞退・取り消しを区別する。 */
export type LiveElicitationAction = "accept" | "decline" | "cancel";

/** 入力フォームが送信できる単一値、または複数選択の文字列一覧。 */
export type LiveElicitationValue = string | number | boolean | string[];

/** 入力要求への結果。Provider に渡すフィールド別の値と、選択位置・回答文の表示用情報を分ける。 */
export type LiveElicitationResponse = {
  action: LiveElicitationAction;
  content?: Record<string, LiveElicitationValue>;
  answerPresentation?: Record<string, { selected: number[]; text: string[] }>;
};

/** 選択肢の送信値と、フォームに表示するラベルの組。 */
export type LiveElicitationChoiceOption = {
  value: string;
  label: string;
};

/** 入力フォームの各項目が共有する送信用の名前、表示文言、必須指定。 */
type LiveElicitationFieldBase = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
};

/** 単一選択の入力項目。自由入力を許す場合に使う文字数・形式の制約も指定できる。 */
export type LiveElicitationSelectField = LiveElicitationFieldBase &
  Pick<LiveElicitationTextField, "minLength" | "maxLength" | "format"> & {
    type: "select";
    options: LiveElicitationChoiceOption[];
    defaultValue?: string;
    allowFreeText?: boolean;
  };

/** 複数選択の入力項目。選択数の下限・上限、既定の選択、自由入力の可否を指定できる。 */
export type LiveElicitationMultiSelectField = LiveElicitationFieldBase & {
  type: "multi-select";
  options: LiveElicitationChoiceOption[];
  defaultValue?: string[];
  minItems?: number;
  maxItems?: number;
  allowFreeText?: boolean;
};

/** 真偽値を回答する入力項目。初期値は省略できる。 */
export type LiveElicitationBooleanField = LiveElicitationFieldBase & {
  type: "boolean";
  defaultValue?: boolean;
};

/** 文字列を回答する入力項目。秘匿表示、文字数制約、メールアドレスや日時などの形式を指定できる。 */
export type LiveElicitationTextField = LiveElicitationFieldBase & {
  type: "text";
  secret?: boolean;
  defaultValue?: string;
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
};

/** 数値を回答する入力項目。整数かどうかと、取り得る値の範囲を指定する。 */
export type LiveElicitationNumberField = LiveElicitationFieldBase & {
  type: "number";
  numberKind: "number" | "integer";
  defaultValue?: number;
  minimum?: number;
  maximum?: number;
};

/** 入力フォームの項目。種別ごとに許容する回答や制約が異なる。 */
export type LiveElicitationField =
  | LiveElicitationSelectField
  | LiveElicitationMultiSelectField
  | LiveElicitationBooleanField
  | LiveElicitationTextField
  | LiveElicitationNumberField;

/** 実行中に利用者へ回答を求める要求。アプリ内のフォームと外部 URL を区別し、元のターンや質問との対応も持てる。 */
export type LiveElicitationRequest = {
  requestId: string;
  sourceItemId?: string;
  textPosition?: number;
  provider: string;
  kind?: "question";
  /** 汎用フォームは、回答を保持せずに質問用の画面を使える。 */
  retainQuestionAnswer?: boolean;
  delivery?: "user-message";
  turnId?: string;
  mode: "form" | "url";
  message: string;
  source?: string;
  fields: LiveElicitationField[];
  blocking?: boolean;
  url?: string;
};

/** メッセージとともに残す質問の履歴。本文での位置、提示した選択肢、回答または終了状態を保持する。 */
export type ElicitationRecord = {
  requestId: string;
  kind?: "question";
  sourceItemId?: string;
  textRange?: { start: number; end: number };
  message: string;
  fields: Array<{
    title: string;
    description?: string;
    options?: string[];
    answer?: { selected: number[]; text: string[] };
  }>;
  status: "pending" | "answered" | "declined" | "canceled" | "expired";
};

/** Session の世代と、実行を特定するターンまたはキュー受付の ID を指定する取り消し要求。 */
export type CancelSessionRunRequest = {
  sessionId: string;
  incarnationId: string;
  execution: { kind: "turn" | "receipt"; id: string };
};

/** 実行中の Session から画面に配信する状態。生成途中の本文や操作履歴、承認・回答待ちをまとめる。 */
export type LiveSessionRunState = {
  sessionId: string;
  threadId: string;
  runState?: string;
  /** 保存済みの WithMate Session の Turn ID。Provider の Turn ID とは別。 */
  sessionTurnId?: string;
  /** 現在実行中の通常 Turn に対応するキューの受付情報と保存済み入力。 */
  queueReceipt?: { id: string; incarnationId: string; userMessageSeq: number };
  turnId?: string;
  inputAvailable?: boolean;
  cancellationState?: "requested" | "terminating";
  assistantText: string;
  assistantQuestionRanges?: AssistantQuestionRange[];
  reasoningText?: string;
  steps: LiveRunStep[];
  backgroundTasks: LiveBackgroundTask[];
  usage: ProviderUsage | null;
  errorMessage: string;
  approvalRequest: LiveApprovalRequest | null;
  elicitationRequest: LiveElicitationRequest | null;
  elicitationRequests?: LiveElicitationRequest[];
  elicitationRecords?: ElicitationRecord[];
};

/** アシスタント本文に含まれる質問の範囲と、対応する Provider 項目の ID。 */
export type AssistantQuestionRange = {
  itemId: string;
  start: number;
  end: number;
};

/** Provider の割当枠ごとに、付与されたリクエスト数、消費量、超過利用の扱いを伝える観測値。 */
export type ProviderQuotaSnapshot = {
  quotaKey: string;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

/** Provider の利用枠を表示するための観測結果。リクエスト数の割当枠と時間枠の使用率を区別する。 */
export type ProviderQuotaTelemetry = {
  provider: string;
  /** 最後に観測に成功した時刻。一度も成功していなければ null。 */
  updatedAt: string | null;
  snapshots: ProviderQuotaSnapshot[];
  rateLimits?: ProviderRateLimitWindow[];
  /** リクエスト数を使う Provider では、スナップショットの準備ができているときに省略される。 */
  status?: "loading" | "ready" | "error" | "unsupported";
};

/** 時間枠ベースの利用制限。使用率のほか、取得できれば枠の長さとリセット時刻も保持する。 */
export type ProviderRateLimitWindow = {
  quotaKey: string;
  label?: string;
  usedPercentage: number;
  windowDurationMinutes?: number;
  resetDate?: string;
};

/** Session のコンテキスト上限と観測時のトークン数。Provider が報告した場合は用途別の内訳も持つ。 */
export type SessionContextTelemetry = {
  provider: string;
  sessionId: string;
  updatedAt: string;
  tokenLimit: number;
  currentTokens: number;
  messagesLength: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
};

/** Skill をワークスペースの設定と Provider 側の定義のどちらから検出したかを示す。 */
export type DiscoveredSkillSource = "workspace" | "provider";

/** 選択・表示に使う検出済み Skill の識別情報と、定義を見つけた場所。 */
export type DiscoveredSkill = {
  id: string;
  name: string;
  description: string;
  source: DiscoveredSkillSource;
  sourcePath: string;
  sourceLabel: string;
};

/** カスタムエージェントの定義がワークスペース内か、全体設定にあるかを示す。 */
export type DiscoveredCustomAgentSource = "workspace" | "global";

/** 検出済みカスタムエージェントの選択に使う名前、表示文言、定義の場所。 */
export type DiscoveredCustomAgent = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: DiscoveredCustomAgentSource;
  sourcePath: string;
  sourceLabel: string;
};

/** 入力欄に添付できる通常ファイル、フォルダー、画像の区別。 */
export type ComposerAttachmentKind = "file" | "folder" | "image";

/** 添付への参照が入力欄のテキストか Markdown の画像記法かを区別する。 */
export type ComposerAttachmentSource = "text" | "markdown-image";

/** 入力欄から渡す未解決の添付参照。パスと参照元を持ち、種別は指定できない場合がある。 */
export type ComposerAttachmentInput = {
  path: string;
  source: ComposerAttachmentSource;
  kind?: ComposerAttachmentKind;
};

/** 解決済みの添付。処理用の絶対パスと表示用パスを分け、ワークスペース外かどうかも保持する。 */
export type ComposerAttachment = {
  id: string;
  kind: ComposerAttachmentKind;
  source: ComposerAttachmentSource;
  absolutePath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  isOutsideWorkspace: boolean;
};

/** 送信前のプレビューに使う、解決できた添付と解決時のエラー。 */
export type ComposerPreview = {
  attachments: ComposerAttachment[];
  errors: string[];
};

/** 新しいターンとして送る本文と実行設定。返信先や GUI での表示先、Auxiliary 下書きの世代情報を伴う場合がある。 */
export type RunSessionTurnRequest = {
  replyTo?: import("./session-reply.js").SessionReply;
  /** Main の GUI で表示する所属先だけを解決した値。null は初期フレーム。他の操作では省略される。 */
  mainConversationFrame?:
    import("./session-target.js").MainSessionTarget | null;
  userMessage: string;
  executionOptions: SessionExecutionOptions;
  clientRequestId?: string;
  submitSource?: "composer" | "retry";
  auxiliaryDraftIncarnation?: string;
  auxiliaryDraftDurableRevision?: number;
  displayAnchorParentMessageCount?: number;
};

/** ターンを新設せず、現在のターンへ入力を追加する要求。対象の取り違えを防ぐため、期待するターン ID を必須とする。 */
export type SteerSessionTurnRequest = {
  replyTo?: import("./session-reply.js").SessionReply;
  expectedTurnId: string;
  userMessage: string;
  clientRequestId?: string;
  auxiliaryDraftIncarnation?: string;
  auxiliaryDraftDurableRevision?: number;
};

/** 追加入力の受付結果として、入力が対象としたターンの ID を返す。 */
export type SteerSessionTurnResult = { turnId: string };

/** クライアントのターン要求 ID に認める UUID 形式。バージョンは限定しない。 */
export const SESSION_TURN_CLIENT_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 文字列の前後の空白を除き、UUID 形式の要求 ID だけを返す。形式外の値は null とする。 */
export function normalizeSessionTurnClientRequestId(
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return SESSION_TURN_CLIENT_REQUEST_ID_PATTERN.test(normalized)
    ? normalized
    : null;
}

/** 入力欄からの送信か再試行か、既知の送信元だけを採用する。未指定や未知の値は null とする。 */
export function normalizeSessionTurnSubmitSource(
  value: unknown,
): RunSessionTurnRequest["submitSource"] | null {
  return value === "composer" || value === "retry" ? value : null;
}

/** 要求の相関に使う ID と送信元を取り出す。ID が本文に含まれる場合は、大文字小文字を区別せず相関から除く。 */
export function normalizeSessionTurnCorrelation(
  request:
    | Partial<
        Pick<
          RunSessionTurnRequest,
          "userMessage" | "clientRequestId" | "submitSource"
        >
      >
    | null
    | undefined,
): {
  clientRequestId: string | null;
  submitSource: RunSessionTurnRequest["submitSource"] | null;
} {
  const normalizedClientRequestId = normalizeSessionTurnClientRequestId(
    request?.clientRequestId,
  );
  const userMessage =
    typeof request?.userMessage === "string"
      ? request.userMessage.trim().toLocaleLowerCase()
      : "";
  return {
    clientRequestId:
      normalizedClientRequestId &&
      !userMessage.includes(normalizedClientRequestId.toLocaleLowerCase())
        ? normalizedClientRequestId
        : null,
    submitSource: normalizeSessionTurnSubmitSource(request?.submitSource),
  };
}

/** 差分の行種別と左右の行番号・本文を並べたタプル列を、表示用の行オブジェクトへ変換する。 */
export function makeDiffRows(
  rows: Array<
    [
      DiffRow["kind"],
      number | undefined,
      string | undefined,
      number | undefined,
      string | undefined,
    ]
  >,
): DiffRow[] {
  return rows.map(([kind, leftNumber, leftText, rightNumber, rightText]) => ({
    kind,
    leftNumber,
    leftText,
    rightNumber,
    rightText,
  }));
}
