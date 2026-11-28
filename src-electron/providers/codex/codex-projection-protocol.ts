import type {
  LiveSessionRunState,
  ProviderDiagnosticMetadata,
} from "../../../src-shared/session/runtime-state.js";
import type { ProviderAgentRuntimeBindingProjection } from "../agent-runtime-binding.js";
import type { RunSessionTurnProgressChanges } from "../provider-runtime.js";
import type { BoundedProviderRawItem } from "../../session/provider-payload-limits.js";
import type {
  CodexNativeNotification,
  CodexTurnItem,
} from "./codex-turn-events.js";

/** 連続するライブ進捗を配信する間隔の目安（ミリ秒）。 */
export const CODEX_LIVE_PROGRESS_INTERVAL_MS = 33;

/** Worker が一つの Turn の投影を開始する際に使う識別情報、秘匿化の入力、進捗と診断の設定。 */
export type CodexProjectionStart = {
  sessionId: string;
  threadId: string;
  turnId: string;
  binding?: ProviderAgentRuntimeBindingProjection | null;
  apiKey: string;
  progress: boolean;
  diagnosticTrace?: boolean;
};
/** 一回分のライブ進捗。現在状態とコレクションの差分を別々に配信する。 */
export type CodexProjectionProgress = {
  /** ライブ状態のスカラー項目を伝える。コレクションの内容は changes でのみ伝える。 */
  state: LiveSessionRunState;
  changes: RunSessionTurnProgressChanges;
};
/** 通知の反映結果。更新有無に加え、エラーまたは未対応通知を必要に応じて呼び出し元へ届ける。 */
export type CodexProjectionEvent = {
  changed: boolean;
  errorMessage?: string;
  unhandledNotification?: {
    sessionId: string;
    threadId: string;
    turnId: string;
    method: string;
    params?: unknown;
  };
};
/** 終了時の回答と識別根拠、使用量、項目、および要求された診断情報をまとめた結果。 */
export type CodexProjectionFinal = {
  output: import("../../../src-shared/session/provider-output.js").ProviderOutput;
  items: CodexTurnItem[];
  assistantText: string;
  assistantQuestionRanges?: LiveSessionRunState["assistantQuestionRanges"];
  lastNonEmptyAssistantMessageText: string;
  rawItemsJson?: string;
  providerMetadata: ProviderDiagnosticMetadata[];
  usage: LiveSessionRunState["usage"];
  terminalStatus: string | null;
  errorMessage: string;
};
/** 一つの投影に対する Worker 操作。開始、通知の反映、表示の取得、終了と解放を区別する。 */
export type CodexProjectionCommand =
  | { type: "start"; input: CodexProjectionStart }
  | { type: "event"; event: CodexNativeNotification }
  | { type: "events"; events: CodexNativeNotification[] }
  | { type: "live"; inputAvailable: boolean; force?: boolean }
  | { type: "question-position" }
  | { type: "finish"; diagnostics: BoundedProviderRawItem[] }
  | { type: "release" };
/** 共有 Worker の実行枠と、応答を照合するリクエスト番号を指定する。 */
export type CodexProjectionRequest = {
  id: number;
  runId: string;
  command: CodexProjectionCommand;
};
/** リクエスト番号に対応する成功値またはエラー。戻り値の形式はコマンドごとに異なる。 */
export type CodexProjectionResponse = {
  id: number;
  value?: unknown;
  error?: string;
};
