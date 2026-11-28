import {
  createProviderAgentRuntimeBindingRedactor,
  type ProviderAgentRuntimeBindingRedactor,
} from "../provider-agent-runtime-binding.js";
import {
  APP_LOG_MAX_SERIALIZED_DATA_LENGTH,
  APP_LOG_MAX_STRING_LENGTH,
} from "../../app/app-log-limits.js";
import {
  PROVIDER_TEXT_PREVIEW_LIMIT,
  boundProviderRawItem,
  stringifyBoundedProviderRawItems,
} from "../../session/provider-payload-limits.js";
import {
  buildCodexStableRawItems,
  buildCodexProviderMetadata,
} from "./codex-event-projection.js";
import {
  applyCodexTurnEvent,
  collectCodexAssistantResponseFromItems,
  collectCodexQuestionRanges,
  createCodexTurnStreamState,
  getLiveCodexAssistantPreview,
  getLiveCodexReasoningPreview,
  type CodexNativeNotification,
} from "./codex-turn-events.js";
import type {
  CodexProjectionStart,
  CodexProjectionProgress,
  CodexProjectionFinal,
  CodexProjectionEvent,
} from "./codex-projection-protocol.js";
import type { BoundedProviderRawItem } from "../../session/provider-payload-limits.js";

/** 共有の投影 Worker 内で、ネイティブ項目と秘匿化済みの投影データを管理する。 */
export class CodexProjectionOwner {
  private readonly state;
  private readonly redactor: ProviderAgentRuntimeBindingRedactor;
  private liveRevision = -1;
  private assistantSource = "";
  private assistantText = "";
  private reasoningSource = "";
  private reasoningText = "";

  /** ネイティブのスレッドと Turn を固定し、その実行の認証情報を含めて秘匿化できるようにする。 */
  constructor(private readonly input: CodexProjectionStart) {
    this.state = createCodexTurnStreamState(input.threadId);
    this.state.turnId = input.turnId;
    this.redactor = createProviderAgentRuntimeBindingRedactor(input.binding, [
      input.apiKey,
    ]);
  }

  /** 現在の本文プレビューを取得し、元の本文が変わった場合だけ秘匿化をやり直す。 */
  private assistantPreview(): string {
    const assistant = getLiveCodexAssistantPreview(this.state);
    if (assistant !== this.assistantSource) {
      this.assistantSource = assistant;
      this.assistantText = this.redactor.sanitizeText(assistant);
    }
    return this.assistantText;
  }

  /** 現在の応答・推論・質問範囲と、呼び出し元から渡されたステップの表示情報をまとめる。 */
  private frame(
    steps: CodexProjectionProgress["state"]["steps"],
  ): CodexProjectionProgress["state"] {
    const assistantText = this.assistantPreview();
    const reasoning = getLiveCodexReasoningPreview(this.state);
    if (reasoning !== this.reasoningSource) {
      this.reasoningSource = reasoning;
      this.reasoningText = this.redactor.sanitizeText(reasoning);
    }
    return {
      sessionId: this.input.sessionId,
      threadId: this.input.threadId,
      turnId: this.input.turnId,
      assistantText,
      reasoningText: this.reasoningText,
      steps,
      assistantQuestionRanges: collectCodexQuestionRanges(
        this.state.items.values(),
        this.assistantSource,
        this.redactor.sanitizeText,
        PROVIDER_TEXT_PREVIEW_LIMIT,
      ),
      backgroundTasks: [],
      usage: this.state.usage,
      errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
      approvalRequest: null,
      elicitationRequest: null,
    };
  }

  /** ネイティブ通知を反映し、必要に応じて変更・新しいエラー・未対応通知を上限付きの診断として伝える。 */
  apply(event: CodexNativeNotification): CodexProjectionEvent {
    const revision = this.state.revision;
    const errorMessage = this.state.streamErrorMessage;
    if (event.params && typeof event.params === "object") {
      const params = event.params as Record<string, unknown>;
      if (
        event.method === "item/started" ||
        event.method === "item/completed"
      ) {
        event = {
          ...event,
          params: { ...params, item: this.sanitizeMcpResult(params.item) },
        };
      } else if (
        event.method === "turn/completed" &&
        params.turn &&
        typeof params.turn === "object"
      ) {
        const turn = params.turn as Record<string, unknown>;
        if (Array.isArray(turn.items)) {
          event = {
            ...event,
            params: {
              ...params,
              turn: {
                ...turn,
                items: turn.items.map((item) => this.sanitizeMcpResult(item)),
              },
            },
          };
        }
      }
    }
    const disposition = applyCodexTurnEvent(this.state, event);
    return {
      changed: this.input.progress && revision !== this.state.revision,
      ...(disposition === "unhandled"
        ? {
            unhandledNotification: this.unhandledNotification(event),
          }
        : {}),
      ...(this.input.progress && errorMessage !== this.state.streamErrorMessage
        ? {
            errorMessage: this.redactor.sanitizeText(
              this.state.streamErrorMessage,
            ),
          }
        : {}),
    };
  }

  /** 未対応通知を Session・スレッド・Turn に関連付け、識別子とパラメーターを含む表示用データを上限内に収める。 */
  private unhandledNotification(
    event: CodexNativeNotification,
  ): NonNullable<CodexProjectionEvent["unhandledNotification"]> {
    const { sanitizeText } = this.redactor;
    // 識別子の長さは params とは別に制限する。通知に長い ID や JSON のエスケープシーケンスが
    // 含まれていても、params 用の容量を確保する。
    /** 識別子を秘匿化し、長い場合は 256 文字までの先頭と省略を示す印に置き換える。 */
    const identifier = (value: string) => {
      const redacted = sanitizeText(value, 256);
      return value.length > 256 || redacted.length > 256
        ? `${redacted.slice(0, 256)}...`
        : redacted;
    };
    const context = {
      sessionId: identifier(this.input.sessionId),
      threadId: identifier(this.input.threadId),
      turnId: identifier(this.input.turnId),
      method: identifier(event.method),
    };
    if (event.params === undefined) return context;

    const budget =
      APP_LOG_MAX_SERIALIZED_DATA_LENGTH - JSON.stringify(context).length;
    const bounded = boundProviderRawItem(
      {
        type: "withmate.codex.unhandled_notification",
        data: { params: event.params },
      },
      budget,
      sanitizeText,
      APP_LOG_MAX_STRING_LENGTH - 100,
    ).data!;
    const data = { ...context, ...bounded };
    if (JSON.stringify(data).length <= APP_LOG_MAX_SERIALIZED_DATA_LENGTH)
      return data;
    // 生の項目に割り当てる上限は、入れ子や省略マーカーを含む概算。
    // 対応付けに必要なフィールドと、秘匿化済みの params の先頭部分を残す。
    // UTF-16 の 1 コードユニットは JSON で最大 6 文字に展開される。
    return {
      ...context,
      params: {
        truncated: true,
        preview: JSON.stringify(bounded.params).slice(
          0,
          Math.floor((budget - 80) / 6),
        ),
      },
    };
  }

  /** MCP ツールの応答とエラーだけを秘匿化したコピーへ置き換え、他のネイティブ項目はそのまま返す。 */
  private sanitizeMcpResult(value: unknown): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      (value as Record<string, unknown>).type !== "mcpToolCall"
    )
      return value;
    const item = value as Record<string, unknown>;
    return {
      ...item,
      result: this.redactor.sanitize(item.result),
      error: this.redactor.sanitize(item.error),
    };
  }

  /** 進捗が有効な実行について、変更時または強制取得時に表示状態とステップ差分を返す。 */
  live(inputAvailable: boolean, force = false): CodexProjectionProgress | null {
    if (
      !this.input.progress ||
      (!force && this.liveRevision === this.state.revision)
    )
      return null;
    this.liveRevision = this.state.revision;
    const steps = this.state.liveSteps.takeProgress(this.redactor, false);
    return {
      state: { ...this.frame(steps.snapshot), inputAvailable },
      changes: {
        snapshot: false,
        steps: steps.changes,
        backgroundTasks: { upserts: [], removes: [] },
      },
    };
  }

  /** 現在の秘匿化済み応答の末尾を、質問を表示するための文字位置として返す。 */
  questionPosition(): number {
    const { assistantText } = collectCodexAssistantResponseFromItems(
      this.state.items.values(),
    );
    return this.redactor.sanitizeText(assistantText).length;
  }

  /** 秘匿化済み項目から最終の回答・使用量・終了状態を組み立て、診断が指定されていれば上限付きで添える。 */
  finish(diagnostics: BoundedProviderRawItem[]): CodexProjectionFinal {
    const items = this.redactor.sanitize([...this.state.items.values()]);
    const response = collectCodexAssistantResponseFromItems(
      items,
      this.state.completedItemIds,
    );
    return {
      items,
      ...response,
      ...(this.input.diagnosticTrace
        ? {
            rawItemsJson: stringifyBoundedProviderRawItems([
              ...this.redactor.sanitize(diagnostics),
              ...buildCodexStableRawItems(items),
            ]),
          }
        : {}),
      providerMetadata: buildCodexProviderMetadata(items),
      usage: this.state.usage,
      terminalStatus: this.state.terminalStatus,
      errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
    };
  }

  /** エラーを表示用文字列へ変換し、実行の認証情報を含む機密値を取り除く。 */
  sanitizeError(error: unknown): string {
    return this.redactor.sanitizeText(
      error instanceof Error ? error.message : String(error),
    );
  }
}
