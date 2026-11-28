/** ストレージ Worker の一つの稼働世代を表す識別子。 */
export type StorageWorkerGeneration = {
  id: string;
};

/** 要求と応答の対応付け、および別世代からの処理を識別するための ID の組。 */
export type StorageWorkerRequestContext = {
  requestId: string;
  generationId: string;
};

/** コマンドの実行要求。変更を伴うかどうかは応答を失った際の結果判定に使う。 */
export type StorageWorkerCallRequest = {
  type: "call";
  context: StorageWorkerRequestContext;
  command: string;
  payload: unknown;
  mutation: boolean;
};

/** 新規要求の受付を止め、既存処理を終えて Worker を閉じる要求。 */
export type StorageWorkerShutdownRequest = {
  type: "shutdown";
  requestId: string;
};

/** ストレージ Worker が親から受け取るコマンド実行要求と終了要求。 */
export type StorageWorkerRequest =
  StorageWorkerCallRequest | StorageWorkerShutdownRequest;

/** コマンド実行要求の外枠を検証する。コマンド固有の引数はここでは判定しない。 */
export function isStorageWorkerCallRequest(
  value: unknown,
): value is StorageWorkerCallRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<StorageWorkerCallRequest>;
  const context = request.context;
  return (
    request.type === "call" &&
    typeof request.command === "string" &&
    typeof request.mutation === "boolean" &&
    Boolean(
      context &&
      typeof context === "object" &&
      typeof context.requestId === "string" &&
      typeof context.generationId === "string",
    )
  );
}

/** メッセージの種別と要求 ID を検査し、終了要求か判定する。 */
export function isStorageWorkerShutdownRequest(
  value: unknown,
): value is StorageWorkerShutdownRequest {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<StorageWorkerShutdownRequest>).type === "shutdown" &&
    typeof (value as Partial<StorageWorkerShutdownRequest>).requestId ===
      "string",
  );
}

/** コマンドの受付準備を終えた Worker から、その世代を親に知らせる通知。 */
export type StorageWorkerReadyMessage = {
  type: "ready";
  generationId: string;
};

/** コマンドの成功結果と、取得できた Worker 内の計測値を返す応答。 */
export type StorageWorkerResultMessage = {
  type: "result";
  requestId: string;
  generationId: string;
  value: unknown;
  timing?: StorageWorkerTiming;
};

/** コマンドの失敗応答。失敗の分類により未実行・拒否確定・結果不明を区別できる。 */
export type StorageWorkerErrorMessage = {
  type: "error";
  requestId: string;
  generationId: string;
  name: string;
  message: string;
  code?: string;
  outcome?: "not-executed" | "rejected" | "unknown";
  stack?: string;
  details?: Record<string, string | number>;
  timing?: StorageWorkerTiming;
};

/** Worker が受信してから実行を始めるまでと、実行開始から応答までの時間（ミリ秒）。 */
export type StorageWorkerTiming = {
  queueWaitMs: number;
  executionMs: number;
};

/** 要求の実行開始と、Worker 内で実行を待った時間（ミリ秒）を知らせる通知。 */
export type StorageWorkerStartedMessage = {
  type: "started";
  requestId: string;
  generationId: string;
  queueWaitMs: number;
};

/** 完了応答の前に、コマンド固有の途中経過を該当要求に届ける通知。 */
export type StorageWorkerProgressMessage = {
  type: "progress";
  requestId: string;
  generationId: string;
  progress: unknown;
};

/** 終了処理を終え、Worker が親とのポートを閉じる直前の通知。 */
export type StorageWorkerShutdownMessage = {
  type: "shutdown-complete";
  requestId: string;
  generationId: string;
};

/** Worker が親へ送る準備・処理状態・最終結果・終了の通知の総称。 */
export type StorageWorkerMessage =
  | StorageWorkerReadyMessage
  | StorageWorkerResultMessage
  | StorageWorkerStartedMessage
  | StorageWorkerErrorMessage
  | StorageWorkerProgressMessage
  | StorageWorkerShutdownMessage;

/** Worker が起動時に受け取る世代・ハンドラーの読み込み先・保存先情報。 */
export type StorageWorkerEntryData = {
  generationId: string;
  handlerModule: string;
  handlerExport?: string;
  dbPath?: string;
  userDataPath?: string;
};

/** Worker の通知種別と対応付けに必要な項目を検査する。結果や進捗の内容までは検証しない。 */
export function isStorageWorkerMessage(
  value: unknown,
): value is StorageWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (
    typeof type !== "string" ||
    typeof message.generationId !== "string" ||
    message.generationId.length === 0
  ) {
    return false;
  }
  if (type === "ready") return true;
  if (type === "result")
    return (
      typeof message.requestId === "string" && message.requestId.length > 0
    );
  if (type === "error") {
    return (
      typeof message.requestId === "string" &&
      message.requestId.length > 0 &&
      typeof message.name === "string" &&
      typeof message.message === "string" &&
      (message.outcome === undefined ||
        message.outcome === "not-executed" ||
        message.outcome === "rejected" ||
        message.outcome === "unknown")
    );
  }
  if (type === "progress")
    return (
      typeof message.requestId === "string" && message.requestId.length > 0
    );
  if (type === "started") {
    return (
      typeof message.requestId === "string" &&
      message.requestId.length > 0 &&
      typeof message.queueWaitMs === "number" &&
      Number.isFinite(message.queueWaitMs)
    );
  }
  if (type === "shutdown-complete")
    return (
      typeof message.requestId === "string" && message.requestId.length > 0
    );
  return false;
}
