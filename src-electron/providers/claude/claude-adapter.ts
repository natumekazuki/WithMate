import {
  projectProviderOutput,
  type ProviderOutputTextUnit,
} from "../../../src-shared/session/provider-output.js";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import {
  query,
  resolveSettings,
  type ElicitationRequest,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageOperation,
  ProviderUsage,
  LiveBackgroundTask,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveRunStep,
} from "../../../src-shared/session/runtime-state.js";
import type { MessageArtifact } from "../../../src-shared/session/session-state.js";
import { resolveModelSelection } from "../../../src-shared/settings/model-catalog.js";
import { mapApprovalModeToClaudePermissionMode } from "../../../src-shared/settings/provider-runtime-options.js";
import type { OpenApprovalReviewer } from "../approval-reviewer.js";
import { createClaudeApprovalReviewer } from "./claude-approval-reviewer.js";
import {
  composeProviderPrompt,
  isCanceledProviderMessage,
} from "../provider-prompt.js";
import {
  ProviderTurnError,
  resolveRunWorkspacePath,
  type GetProviderQuotaTelemetryInput,
  type ProviderPromptComposition,
  type ProviderTurnAdapter,
  type RunSessionTurnInput,
  type RunSessionTurnProgressHandler,
  type RunSessionTurnResult,
} from "../provider-runtime.js";
import {
  resolveDevelopmentProviderBinaryPath,
  resolvePackagedProviderBinaryPath,
} from "../provider-binary-paths.js";
import {
  buildProviderAgentRuntimeBindingEnv,
  createProviderAgentRuntimeBindingRedactor,
  mergeDefinedProviderEnv,
  type ProviderAgentRuntimeBindingRedactor,
} from "../provider-agent-runtime-binding.js";
import { buildManagedHttpMcpServers } from "../managed-http-mcp.js";
import {
  PROVIDER_TEXT_PREVIEW_LIMIT,
  toProviderTextPreview,
} from "../../session/provider-payload-limits.js";
import { buildArtifactFromOperations } from "../provider-artifact.js";
import { captureWorkspaceSnapshot } from "../../platform/snapshot-ignore.js";
import {
  createDisabledWorkspaceSnapshotCapture,
  WORKSPACE_DIFF_CAPTURE_ENABLED,
} from "../../files/workspace-diff-policy.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";
import {
  ProviderProgressDelivery,
  ProviderProgressMap,
} from "../provider-progress.js";
import { projectClaudeQuotaTelemetry } from "./claude-quota-telemetry.js";
import type { ListProviderModelsInput } from "../provider-runtime.js";
import type { ModelCatalogProvider } from "../../../src-shared/settings/model-catalog.js";

const require = createRequire(import.meta.url);
const CANCEL_GRACE_MS = 2_000;

/** Claude SDK のクエリを開始し、メッセージと制御操作を受け取る関数の型。 */
type ClaudeQuery = typeof query;
/** アダプターからアプリへ送る診断の重要度・説明と補足データ。 */
type ClaudeAdapterLogInput = {
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

/** Claude SDK のクエリ・起動・設定確認の差し替え先と、任意の診断通知先。 */
export type ClaudeAdapterOptions = {
  query?: ClaudeQuery;
  spawnProcess?: typeof spawn;
  resolveSettings?: typeof resolveSettings;
  log?: (input: ClaudeAdapterLogInput) => void;
};

/** 一回の実行について、本文の配信単位、ツール・バックグラウンド進捗、最終結果とエラーをまとめる状態。 */
type ClaudeTrace = {
  threadId: string | null;
  messages: Array<{
    id: string;
    text: string;
    deliveries: Array<{
      uuid: string;
      blocks: { index?: number; text: string | null; type: string }[];
    }>;
  }>;
  streamingBlocks: Map<number, string>;
  pendingBlockIndexes: number[];
  streamingText: string;
  streamingId: string | null;
  steps: ProviderProgressMap<LiveRunStep>;
  backgroundTasks: ProviderProgressMap<LiveBackgroundTask>;
  backgroundTaskInfo: Map<string, Pick<LiveBackgroundTask, "kind" | "title">>;
  backgroundFailure: string;
  operations: MessageOperation[];
  redactor: ProviderAgentRuntimeBindingRedactor;
  usage: ProviderUsage | null;
  result: SDKResultMessage | null;
  resultOutputCurrent: boolean;
  errorMessage: string;
};

/** SDK の入力から実際に文字列である値だけを取り出し、他の型は表示に使わない。 */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** ツールやフォームの名前付き属性を扱うため、配列・null などは空のオブジェクトとして読む。 */
function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 中断を優先し、その他の SDK エラーは文言に基づいて認証・利用枠・接続・利用不能等に分類する。 */
function providerErrorReason(
  message: string,
  canceled: boolean,
):
  | "canceled"
  | "auth"
  | "usage_limit"
  | "network"
  | "provider_unavailable"
  | "unknown" {
  if (canceled) return "canceled";
  if (/auth|login|sign.?in|credential|unauthorized/i.test(message))
    return "auth";
  if (/usage limit|rate limit|out of usage|quota|billing limit/i.test(message))
    return "usage_limit";
  if (/network|ECONN|ETIMEDOUT|fetch failed/i.test(message)) return "network";
  if (/unavailable|overloaded|service down/i.test(message))
    return "provider_unavailable";
  return "unknown";
}

/** ツールの表示名にファイル・パス・コマンドの順で取得できる対象の短い表示を添える。 */
function summarizeTool(name: string, input: unknown): string {
  const argumentsValue = objectOf(input);
  const target =
    textOf(argumentsValue.file_path) ||
    textOf(argumentsValue.path) ||
    textOf(argumentsValue.command);
  return target ? `${name}: ${toProviderTextPreview(target, 300)}` : name;
}

/** Bash のコマンドだけを秘匿化済みの上限付き表示に変える。コマンドがなければ null。 */
function commandOf(
  name: string,
  input: unknown,
  redactor: ProviderAgentRuntimeBindingRedactor,
): string | null {
  if (name !== "Bash") return null;
  const command = textOf(objectOf(input).command);
  const sanitized = redactor
    .sanitizeText(command, PROVIDER_TEXT_PREVIEW_LIMIT)
    .slice(0, PROVIDER_TEXT_PREVIEW_LIMIT);
  const preview =
    (command.length > PROVIDER_TEXT_PREVIEW_LIMIT
      ? `${sanitized}\n...[truncated ${command.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${command.length}]`
      : sanitized) || null;
  // 長さを制限したプレビューが、元のコマンド文字列の内部表現を保持しないようにする。
  return command.length > PROVIDER_TEXT_PREVIEW_LIMIT
    ? (JSON.parse(JSON.stringify(preview)) as string)
    : preview;
}

/** 新規実行ではモデル別使用量を優先し、スレッド再開時には今回の結果の使用量だけを使う。 */
function usageFromResult(
  result: SDKResultMessage,
  resumed: boolean,
): ProviderUsage {
  // modelUsage はサブエージェントも含むが、再開後の集計には以前の Turn が含まれることがある。
  const models = resumed ? [] : Object.values(result.modelUsage ?? {});
  const inputTokens =
    models.length > 0
      ? models.reduce(
          (sum, usage) =>
            sum +
            usage.inputTokens +
            usage.cacheReadInputTokens +
            usage.cacheCreationInputTokens,
          0,
        )
      : result.usage.input_tokens +
        result.usage.cache_read_input_tokens +
        result.usage.cache_creation_input_tokens;
  const cachedInputTokens =
    models.length > 0
      ? models.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0)
      : result.usage.cache_read_input_tokens;
  const outputTokens =
    models.length > 0
      ? models.reduce((sum, usage) => sum + usage.outputTokens, 0)
      : result.usage.output_tokens;
  const reasoningOutputTokens = models.reduce(
    (sum, usage) => sum + (usage.thinkingTokens ?? 0),
    0,
  );
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** 確定済みアシスタントメッセージの本文を、到着順に区切り付きで結合する。 */
function assistantText(trace: ClaudeTrace): string {
  return trace.messages
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");
}

/** 確定済みと配信中の本文を結合する。どちらも空の場合だけ、その時点で有効な成功結果の本文を補う。 */
function liveText(trace: ClaudeTrace): string {
  return (
    [assistantText(trace), trace.streamingText].filter(Boolean).join("\n\n") ||
    (trace.resultOutputCurrent &&
    trace.result?.subtype === "success" &&
    !trace.result.is_error
      ? trace.result.result
      : "")
  );
}

/** SDK 処理の完了と中断のどちらか早い方を返し、元の処理の拒否も観測して監視を外す。 */
function signalRace<T>(
  promise: Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(new Error("Canceled"));
  }
  return new Promise<T>((resolve, reject) => {
    /** 中断を、待っている SDK 処理の失敗として呼び出し側へ通知する。 */
    const abort = () => reject(new Error("Canceled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** 強制時には直ちにクエリを閉じる。通常終了では猶予内のストリーム返却を試し、失敗時に強制する。 */
async function closeQuery(
  iterator: ReturnType<ClaudeQuery>,
  force: boolean,
): Promise<void> {
  if (force) {
    iterator.close?.();
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = Promise.resolve(iterator.return?.()).then(
      () => true,
      () => false,
    );
    const timed = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), CANCEL_GRACE_MS);
    });
    if (!(await Promise.race([graceful, timed]))) iterator.close?.();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** SDK の質問を必須回答欄に写す。候補がない質問はテキスト、候補があれば自由記述もできる選択欄にする。 */
function claudeQuestionRequest(
  requestId: string,
  input: Record<string, unknown>,
): LiveElicitationRequest {
  const questions = Array.isArray(input.questions)
    ? input.questions.map(objectOf)
    : [];
  const fields: LiveElicitationField[] =
    questions.flatMap<LiveElicitationField>((question, index) => {
      const options = Array.isArray(question.options)
        ? question.options.map(objectOf)
        : [];
      const title = textOf(question.question) || `Question ${index + 1}`;
      if (options.length === 0)
        return [{ type: "text", name: String(index), title, required: true }];
      const choices = options.map((option) => ({
        value: textOf(option.label),
        label: textOf(option.description)
          ? `${textOf(option.label)} — ${textOf(option.description)}`
          : textOf(option.label),
      }));
      const selection: LiveElicitationField =
        question.multiSelect === true
          ? {
              type: "multi-select",
              name: String(index),
              title,
              required: true,
              options: choices,
              allowFreeText: true,
            }
          : {
              type: "select",
              name: String(index),
              title,
              required: true,
              options: choices,
              allowFreeText: true,
            };
      return [selection];
    });
  return {
    requestId,
    provider: "claude",
    kind: "question",
    mode: "form",
    message: "Claude has a question",
    fields,
  };
}

/** MCP の URL 要求とフォームを区別し、フォームに表現できない項目があれば要求全体を拒否する。 */
function mcpElicitationRequest(
  requestId: string,
  request: ElicitationRequest,
): LiveElicitationRequest | null {
  if (request.mode === "url") {
    return {
      requestId,
      provider: "claude",
      mode: "url",
      message: request.message,
      source: request.serverName,
      fields: [],
      url: request.url,
    };
  }
  const schema = objectOf(request.requestedSchema);
  const properties = objectOf(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  const fields: LiveElicitationField[] = [];
  for (const [name, unknownSpec] of Object.entries(properties)) {
    const field = buildLiveElicitationFieldFromMcpSchema(
      name,
      unknownSpec,
      required.has(name),
    );
    if (!field) return null;
    fields.push(field);
  }
  return {
    requestId,
    provider: "claude",
    mode: "form",
    message: request.message,
    source: request.serverName,
    fields,
  };
}

/** 入力本文を UUID 付きの SDK ユーザーメッセージにし、対応する種類の画像を Base64 で添付する。 */
async function buildUserMessage(
  prompt: ProviderPromptComposition,
  uuid: ReturnType<typeof randomUUID>,
): Promise<SDKUserMessage> {
  const images = await Promise.all(
    prompt.imagePaths.map(async (imagePath) => {
      const suffix = extname(imagePath).toLowerCase();
      const mime: "image/png" | "image/webp" | "image/jpeg" | "image/gif" =
        suffix === ".png"
          ? "image/png"
          : suffix === ".webp"
            ? "image/webp"
            : suffix === ".gif"
              ? "image/gif"
              : suffix === ".jpg" || suffix === ".jpeg"
                ? "image/jpeg"
                : (() => {
                    throw new Error(`Unsupported Claude image type: ${suffix}`);
                  })();
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mime,
          data: (await readFile(imagePath)).toString("base64"),
        },
      };
    }),
  );
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: prompt.inputBodyText }, ...images],
    },
  };
}

/** 同梱の Claude CLI を優先し、開発依存からも解決できないプラットフォームでは失敗する。 */
export function resolveClaudeBinaryPath(): string {
  const packaged = resolvePackagedProviderBinaryPath("claude");
  if (packaged) return packaged;
  const development = resolveDevelopmentProviderBinaryPath(
    "claude",
    require.resolve,
  );
  if (development) return development;
  throw new Error("Claude native executable is unavailable for this platform");
}

/** Claude のメタデータ照会・Auto Review・Turn 実行を提供し、プロバイダー固有の通知を共通結果へ写す。 */
export class ClaudeAdapter implements ProviderTurnAdapter {
  private readonly runQuery: ClaudeQuery;
  private readonly spawnProcess: typeof spawn;
  private readonly inspectSettings: typeof resolveSettings;
  private readonly log?: ClaudeAdapterOptions["log"];

  /** 差し替えがなければ通常の Claude SDK と子プロセス起動・設定検査を使用する。 */
  constructor(options: ClaudeAdapterOptions = {}) {
    this.runQuery = options.query ?? query;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.inspectSettings = options.resolveSettings ?? resolveSettings;
    this.log = options.log;
  }

  /** Claude へ渡すシステム指示、入力と添付の構成を、SDK を起動せずに決める。 */
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition {
    return composeProviderPrompt(input);
  }

  /** 設定された Claude のネイティブ Auto Review を、実行とは別の会話として開く。 */
  openApprovalReviewer(input: Parameters<OpenApprovalReviewer>[0]) {
    return createClaudeApprovalReviewer({
      query: this.runQuery,
      spawn: this.spawnProcess,
      resolveBinary: resolveClaudeBinaryPath,
    })(input);
  }

  /** ツール・フック・プロンプトを使わず SDK のモデル情報を問い合わせる。管理ポリシーで分離できない場合は開始しない。 */
  async listModels(
    input: ListProviderModelsInput,
  ): Promise<ModelCatalogProvider> {
    const controller = new AbortController();
    /** 手動中断または照会期限の到達を、モデル探索用 SDK のシグナルへ伝える。 */
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, 30_000);
    let iterator: ReturnType<ClaudeQuery> | undefined;
    let childExited: Promise<void> | undefined;
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    /** モデル照会中は接続を維持しつつ、ユーザーメッセージは一切送らない。 */
    async function* emptyInput(): AsyncGenerator<SDKUserMessage> {
      await inputClosed;
    }
    try {
      controller.signal.throwIfAborted();
      const settings = await signalRace(
        this.inspectSettings({ cwd: input.workspacePath, settingSources: [] }),
        controller.signal,
      );
      if (settings.sources.some((source) => source.source === "managed"))
        throw new Error("Managed settings prevent metadata-only discovery");
      controller.signal.throwIfAborted();
      iterator = this.runQuery({
        prompt: emptyInput(),
        options: {
          cwd: input.workspacePath,
          pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
          env: mergeDefinedProviderEnv(process.env, {}),
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: { disableAllHooks: true },
          persistSession: false,
          abortController: controller,
          /** モデル探索の子プロセスを起動し、標準エラーを保存せず、終了を待てる状態にする。 */
          spawnClaudeCodeProcess: (options) => {
            const child = this.spawnProcess(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            child.stderr?.on("error", () => undefined);
            child.stderr?.resume();
            childExited = new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              child.once("error", () => {
                if (child.pid === undefined) resolve();
              });
            });
            return child;
          },
        },
      });
      const metadata = await signalRace(
        iterator.supportedModels(),
        controller.signal,
      );
      const models = metadata.map((model) => ({
        id: model.value,
        label: model.displayName,
        reasoningEfforts: model.supportsEffort
          ? (model.supportedEffortLevels ?? [])
          : [],
        defaultReasoningEffort: "",
      }));
      return {
        id: "claude",
        label: "Claude",
        models,
        defaultModelId: models[0]?.id ?? "",
        defaultReasoningEffort: "",
      };
    } catch {
      throw new Error(
        controller.signal.aborted
          ? "Claude model discovery canceled"
          : "Claude models could not be retrieved",
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      closeInput();
      try {
        iterator?.close();
      } catch {
        throw new Error("Claude model discovery process cleanup failed");
      } finally {
        controller.abort();
        if (childExited) await childExited;
      }
    }
  }

  /** プロンプトを送らず Claude の利用枠を取得し、成功・中断・エラーのいずれでも起動した子の終了を確認する。 */
  async getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput) {
    const controller = new AbortController();
    /** 照会元の中断または期限の到達を、利用枠照会の SDK シグナルへ伝える。 */
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 30_000);
    let iterator: ReturnType<ClaudeQuery> | null = null;
    let childExited: Promise<void> | null = null;
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    /** 利用枠照会中は接続を開いたままにして、ユーザー入力は一切生成しない。 */
    async function* emptyInput(): AsyncGenerator<SDKUserMessage> {
      await inputClosed;
    }
    try {
      if (controller.signal.aborted) throw new Error("Canceled");
      // 管理ポリシーによって、プロンプトを渡す前でもフックや MCP が強制されることがある。
      const settings = await signalRace(
        this.inspectSettings({ cwd: process.cwd(), settingSources: [] }),
        controller.signal,
      );
      if (settings.sources.some((source) => source.source === "managed"))
        throw new Error(
          "Claude quota retrieval is unavailable with managed settings",
        );
      if (controller.signal.aborted) throw new Error("Canceled");
      iterator = this.runQuery({
        prompt: emptyInput(),
        options: {
          cwd: process.cwd(),
          pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
          env: mergeDefinedProviderEnv(process.env, {}),
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: { disableAllHooks: true },
          persistSession: false,
          abortController: controller,
          /** 利用枠照会の子プロセスを追跡し、開始前の失敗と実際の終了を後片付けで待てるようにする。 */
          spawnClaudeCodeProcess: (options) => {
            const child = this.spawnProcess(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            child.stderr?.on("error", () => undefined);
            child.stderr?.resume();
            childExited = new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              child.once("error", () => {
                if (child.pid === undefined) resolve();
              });
            });
            return child;
          },
        },
      });
      await signalRace(iterator.initializationResult(), controller.signal);
      return projectClaudeQuotaTelemetry(
        await signalRace(
          iterator.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }),
          controller.signal,
        ),
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      closeInput();
      try {
        iterator?.close();
      } finally {
        controller.abort();
        if (childExited) await childExited;
      }
    }
  }
  /** 再利用するプロセスを保持していないため、特定 Session の無効化では追加の停止処理を行わない。 */
  async invalidateSessionThread(): Promise<void> {
    /* Turn ごとにプロセスを起動し、スレッドはキャッシュしない。 */
  }
  /** 実行間でスレッドをキャッシュしないため、全 Session の無効化で破棄するキャッシュはない。 */
  async invalidateAllSessionThreads(): Promise<void> {
    /* Turn ごとにプロセスを起動し、スレッドはキャッシュしない。 */
  }

  /** 既存のスレッド ID があれば引き継ぎ、一回の Turn で受け取る本文・結果・進捗を空から追跡する。 */
  private makeTrace(
    threadId: string | null,
    redactor = createProviderAgentRuntimeBindingRedactor(null),
  ): ClaudeTrace {
    return {
      threadId,
      messages: [],
      streamingBlocks: new Map(),
      pendingBlockIndexes: [],
      streamingText: "",
      streamingId: null,
      steps: new ProviderProgressMap(),
      backgroundTasks: new ProviderProgressMap(),
      backgroundTaskInfo: new Map(),
      backgroundFailure: "",
      operations: [],
      redactor,
      usage: null,
      result: null,
      resultOutputCurrent: false,
      errorMessage: "",
    };
  }

  /** SDK 通知を項目 ID と配信 UUID で統合し、ルートの本文、ツールの完了、バックグラウンド報告を追跡する。 */
  private receive(
    message: SDKMessage,
    trace: ClaudeTrace,
    resumed = false,
  ): void {
    if (message.type === "system" && message.subtype === "task_started") {
      if (
        message.is_backgrounded &&
        !message.ambient &&
        !message.skip_transcript
      ) {
        trace.backgroundTaskInfo.set(message.task_id, {
          kind: message.task_type === "local_bash" ? "shell" : "agent",
          title: message.description,
        });
      }
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "background_tasks_changed"
    ) {
      const active = new Set<string>();
      for (const task of message.tasks) {
        if (task.ambient) {
          trace.backgroundTaskInfo.delete(task.task_id);
          trace.backgroundTasks.delete(task.task_id);
          continue;
        }
        active.add(task.task_id);
        const info = {
          kind:
            task.task_type === "local_bash"
              ? ("shell" as const)
              : ("agent" as const),
          title: task.description,
        };
        trace.backgroundTaskInfo.set(task.task_id, info);
        trace.backgroundTasks.set(task.task_id, {
          id: task.task_id,
          ...info,
          status: "running",
          updatedAt: new Date().toISOString(),
        });
      }
      for (const [id, task] of trace.backgroundTasks) {
        if (task.status === "running" && !active.has(id))
          trace.backgroundTasks.delete(id);
      }
      return;
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      const info = trace.backgroundTaskInfo.get(message.task_id);
      if (message.ambient || message.skip_transcript || !info) return;
      trace.backgroundTasks.set(message.task_id, {
        id: message.task_id,
        ...info,
        status: message.status === "completed" ? "completed" : "failed",
        details: toProviderTextPreview(
          trace.redactor.sanitizeText(message.summary),
        ),
        updatedAt: new Date().toISOString(),
      });
      if (message.status !== "completed") {
        trace.backgroundFailure ||= `Claude background task ${message.status}: ${message.summary}`;
        trace.errorMessage = trace.backgroundFailure;
      }
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      trace.threadId = message.session_id;
      return;
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === "message_start") {
        trace.streamingId = event.message.id;
        trace.streamingText = "";
        trace.streamingBlocks.clear();
        trace.pendingBlockIndexes = [];
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        if (event.delta.text) trace.resultOutputCurrent = false;
        trace.streamingBlocks.set(
          event.index,
          (trace.streamingBlocks.get(event.index) ?? "") + event.delta.text,
        );
        trace.streamingText = [...trace.streamingBlocks.values()].join("\n");
      }
      if (event.type === "content_block_start")
        trace.pendingBlockIndexes.push(event.index);
      if (event.type === "content_block_stop")
        trace.pendingBlockIndexes = trace.pendingBlockIndexes.filter(
          (index) => index !== event.index,
        );
      return;
    }
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const content = message.message.content;
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const messageId = message.message.id ?? message.uuid;
      let entry = trace.messages.find((entry) => entry.id === messageId);
      if (!entry) {
        entry = { id: messageId, text: "", deliveries: [] };
        trace.messages.push(entry);
      }
      const existing = entry.deliveries.findIndex(
        (delivery) => delivery.uuid === message.uuid,
      );
      const previous = entry.deliveries[existing];
      // SDK の各通知に含まれるのは完了したブロックであり、メッセージ全体のスナップショットではない。
      const indexes =
        trace.streamingId === messageId && !previous
          ? trace.pendingBlockIndexes.splice(0, content.length)
          : [];
      const delivery = {
        uuid: message.uuid,
        blocks: content.map((block, localIndex) => ({
          index: previous?.blocks[localIndex]?.index ?? indexes[localIndex],
          text: block.type === "text" ? block.text : null,
          type: block.type,
        })),
      };
      if (
        !previous ||
        previous.blocks.length !== delivery.blocks.length ||
        previous.blocks.some((block, index) => {
          const current = delivery.blocks[index];
          return (
            block.index !== current.index ||
            block.text !== current.text ||
            block.type !== current.type
          );
        })
      )
        trace.resultOutputCurrent = false;
      if (previous) entry.deliveries[existing] = delivery;
      else entry.deliveries.push(delivery);
      entry.text = entry.deliveries
        .flatMap((delivery) =>
          delivery.blocks.flatMap((block) =>
            block.text === null ? [] : [block.text],
          ),
        )
        .join("\n");
      if (text && !previous) {
        trace.operations.push({
          id: message.uuid,
          type: "agent_message",
          summary: toProviderTextPreview(text, 300) ?? "",
          details: toProviderTextPreview(text),
          truncated: text.length > PROVIDER_TEXT_PREVIEW_LIMIT,
        });
      }
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const command = commandOf(block.name, block.input, trace.redactor);
        const summary = command ?? summarizeTool(block.name, block.input);
        const step: LiveRunStep = {
          id: block.id,
          type: command === null ? "tool_call" : "command_execution",
          summary,
          status: "in_progress",
        };
        trace.steps.set(block.id, step);
        trace.operations.push(step);
      }
      if (trace.streamingId === messageId) {
        for (const block of delivery.blocks)
          if (block.index !== undefined)
            trace.streamingBlocks.delete(block.index);
        trace.streamingText = [...trace.streamingBlocks.values()].join("\n");
      }
      if (message.error) trace.errorMessage = message.error;
      return;
    }
    if (
      message.type === "user" &&
      !message.parent_tool_use_id &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const step = trace.steps.get(block.tool_use_id);
        const failed = block.is_error === true;
        if (step) {
          const rawOutput =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          const output =
            rawOutput === undefined
              ? undefined
              : trace.redactor.sanitizeText(rawOutput);
          const details = toProviderTextPreview(output);
          const completed: LiveRunStep = {
            ...step,
            status: failed ? "failed" : "completed",
            details,
            ...(output !== undefined
              ? { truncated: output.length > PROVIDER_TEXT_PREVIEW_LIMIT }
              : {}),
            ...(failed && details !== undefined
              ? { error: { message: details } }
              : {}),
          };
          trace.steps.set(step.id, completed);
          const index = trace.operations.findIndex(
            (operation) => operation.id === step.id,
          );
          if (index >= 0) trace.operations[index] = completed;
        }
      }
      return;
    }
    if (message.type === "result") {
      trace.result = message;
      trace.resultOutputCurrent = true;
      trace.threadId = message.session_id;
      trace.usage = usageFromResult(message, resumed);
      if (message.subtype !== "success")
        trace.errorMessage = message.errors.join("\n") || message.subtype;
      else if (message.is_error) trace.errorMessage = message.result;
    }
  }

  /** 要求した速度と SDK が報告した適用状態を区別し、レビュアー設定とともに成果物へ記録する。 */
  private addExecutionChecks(
    artifact: MessageArtifact | undefined,
    input: RunSessionTurnInput,
    trace: ClaudeTrace,
  ): void {
    if (!artifact) return;
    const state = trace.result?.fast_mode_state;
    const speed =
      input.executionOptions.codexSpeed === "standard"
        ? "Standard"
        : state === "on"
          ? "Fast"
          : state
            ? `Standard (Fast ${state})`
            : "Fast (Requested)";
    artifact.runChecks.push({ label: "speed", value: speed });
    artifact.runChecks.push({
      label: "reviewer",
      value: input.executionOptions.codexReviewer,
    });
  }

  /** 現在の本文とネイティブ結果の対応を確認して回答を確定し、秘匿化済みの部分出力も共通結果として返せる形にする。 */
  private result(
    input: RunSessionTurnInput,
    trace: ClaudeTrace,
  ): RunSessionTurnResult {
    const redactor = createProviderAgentRuntimeBindingRedactor(
      input.agentRuntimeBinding,
    );
    const text = liveText(trace);
    const nativeFinal =
      trace.result?.subtype === "success" &&
      !trace.result.is_error &&
      trace.resultOutputCurrent &&
      !trace.streamingText
        ? trace.result.result
        : null;
    const terminal = trace.messages.at(-1);
    const matched =
      nativeFinal &&
      terminal?.text === nativeFinal &&
      terminal.deliveries.at(-1)?.blocks.at(-1)?.type === "text"
        ? terminal
        : undefined;
    const units: ProviderOutputTextUnit[] = trace.messages.flatMap((message) =>
      message.deliveries.flatMap((delivery) =>
        delivery.blocks.flatMap((block, localIndex) =>
          block.text === null
            ? []
            : [
                {
                  id: `${message.id}:${delivery.uuid}:${localIndex}`,
                  messageId: message.id,
                  ...(block.index !== undefined
                    ? { blockIndex: block.index }
                    : {}),
                  text: block.text,
                  role: matched?.id === message.id ? "answer" : "unclassified",
                  phase: null,
                  completion: "complete",
                  final: matched?.id === message.id,
                  evidence:
                    matched?.id === message.id
                      ? "claude.result:matching-assistant-blocks"
                      : null,
                },
              ],
        ),
      ),
    );
    if (trace.streamingText)
      for (const [blockIndex, value] of trace.streamingBlocks)
        units.push({
          id: `${trace.streamingId ?? "stream"}:${blockIndex}`,
          messageId: trace.streamingId ?? undefined,
          blockIndex,
          text: value,
          role: "unclassified",
          phase: null,
          completion: "partial",
          final: false,
          evidence: null,
        });
    if (nativeFinal && !matched)
      units.push({
        id: `result:${trace.result!.uuid}`,
        text: nativeFinal,
        role: "answer",
        phase: null,
        completion: "complete",
        final: true,
        evidence: "claude.result:success-text",
      });
    const projected = projectProviderOutput(
      units,
      nativeFinal ? "identified" : units.length ? "unknown" : "none",
      redactor.sanitizeText,
      (previous, current) =>
        previous?.messageId && previous.messageId === current.messageId
          ? "\n"
          : "\n\n",
    );
    const operations = redactor.sanitize(trace.operations);
    const emptySnapshot = createDisabledWorkspaceSnapshotCapture();
    const artifact = buildArtifactFromOperations({
      session: input.session,
      executionOptions: input.executionOptions,
      operations,
      usage: trace.usage,
      threadId: trace.threadId,
      beforeSnapshot: emptySnapshot.snapshot,
      afterSnapshot: emptySnapshot.snapshot,
      beforeSnapshotStats: emptySnapshot.stats,
      afterSnapshotStats: emptySnapshot.stats,
      providerCatalog: input.providerCatalog,
      selection: resolveModelSelection(
        input.providerCatalog,
        input.executionOptions.model,
        input.executionOptions.reasoningEffort,
      ),
    });
    this.addExecutionChecks(artifact, input, trace);
    return {
      threadId: trace.threadId,
      ...projected,
      lastNonEmptyAssistantMessageText: redactor.sanitizeText(
        nativeFinal ||
          trace.streamingText ||
          trace.messages.at(-1)?.text ||
          text,
      ),
      artifact: redactor.sanitize(artifact),
      usage: trace.usage,
    };
  }

  /** Turn の入力 UUID に対応する結果を受け、成功時は SDK の idle まで待つ。実行中の失敗・中断には受信済みの部分結果を添える。 */
  async runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult> {
    const permissionMode = mapApprovalModeToClaudePermissionMode(
      input.executionOptions.approvalMode,
      input.executionOptions.codexReviewer,
    );
    const prompt = this.composePrompt(input);
    const redactor = createProviderAgentRuntimeBindingRedactor(
      input.agentRuntimeBinding,
    );
    const trace = this.makeTrace(input.session.threadId || null, redactor);
    const workspacePath = resolveRunWorkspacePath(input);
    const selection = resolveModelSelection(
      input.providerCatalog,
      input.executionOptions.model,
      input.executionOptions.reasoningEffort,
    );
    const controller = new AbortController();
    let childExited: Promise<void> | null = null;
    /** 呼び出し側の中断を、その Turn の SDK 用コントローラーへ中継する。 */
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let approvalRequest: {
      requestId: string;
      provider: string;
      kind: string;
      title: string;
      summary: string;
      decisionMode: "direct-decision";
    } | null = null;
    let elicitationRequest: LiveElicitationRequest | null = null;
    let interactionTail: Promise<void> = Promise.resolve();
    /** 質問・承認を一件ずつ処理する。待機者が中断しても、実際の処理が確定するまで次を開始しない。 */
    const enqueueInteraction = <T>(
      signal: AbortSignal,
      action: (signal: AbortSignal) => Promise<T> | T,
    ): Promise<T> => {
      const pending = interactionTail.then(() => {
        if (signal.aborted) throw new Error("Canceled");
        return action(signal);
      });
      // 実際のリクエストが完了するまで、サービス処理の唯一の待機枠を占有したままにする。
      interactionTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return signalRace(pending, signal);
    };
    let progressFailure: unknown;
    const progressDelivery = new ProviderProgressDelivery(
      onProgress,
      (error) => {
        progressFailure ??= error;
        controller.abort();
      },
    );
    /** 現在の本文、要求、進捗を秘匿化して送る。中断済みか配信先がなければ何もしない。 */
    const progress = (): Promise<void> => {
      if (controller.signal.aborted || !onProgress) return Promise.resolve();
      const steps = trace.steps.takeProgress(redactor);
      const backgroundTasks = trace.backgroundTasks.takeProgress(redactor);
      const state = {
        sessionId: input.session.id,
        threadId: trace.threadId ?? "",
        assistantText: redactor.sanitizeText(liveText(trace)),
        steps: steps.snapshot,
        backgroundTasks: backgroundTasks.snapshot,
        usage: trace.usage,
        errorMessage: redactor.sanitizeText(trace.errorMessage),
        approvalRequest: redactor.sanitize(approvalRequest),
        elicitationRequest: redactor.sanitize(elicitationRequest),
      };
      return progressDelivery.deliver(state, {
        steps: steps.changes,
        backgroundTasks: backgroundTasks.changes,
      });
    };
    const options: Options = {
      cwd: workspacePath,
      title: input.session.taskTitle || "WithMate session",
      pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
      env: mergeDefinedProviderEnv(process.env, {
        ...buildProviderAgentRuntimeBindingEnv(input.agentRuntimeBinding),
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: "1",
      }),
      model: selection.resolvedModel,
      ...(selection.resolvedReasoningEffort
        ? { effort: selection.resolvedReasoningEffort as Options["effort"] }
        : {}),
      permissionMode,
      allowDangerouslySkipPermissions:
        input.executionOptions.approvalMode === "never",
      settings: { fastMode: input.executionOptions.codexSpeed === "fast" },
      resume: input.session.threadId || undefined,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: prompt.systemBodyText,
        snapshot: false,
      },
      additionalDirectories: prompt.additionalDirectories,
      settingSources: ["user", "project", "local"],
      ...(input.agentRuntimeBinding?.managedMcp
        ? { mcpServers: buildManagedHttpMcpServers(input.agentRuntimeBinding) }
        : {}),
      includePartialMessages: true,
      abortController: controller,
      /** SDK の子プロセスを捕捉し、標準エラーを捨て、実際の終了と起動失敗を区別して待つ。 */
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = this.spawnProcess(
          spawnOptions.command,
          spawnOptions.args,
          {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        child.stderr?.on("error", () => undefined);
        child.stderr?.resume();
        childExited = new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => {
            // AbortError は exit より先に届くことがある。待機すべき子プロセスがないのは、起動に失敗した場合だけ。
            if (child.pid === undefined) resolve();
          });
        });
        return child;
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== "PreToolUse") return {};
                if (controller.signal.aborted)
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Canceled",
                    },
                  };
                if (
                  input.executionOptions.approvalMode === "safety-focused" &&
                  hookInput.tool_name !== "AskUserQuestion"
                )
                  return {};
                const readOnly = new Set([
                  "Read",
                  "Glob",
                  "Grep",
                  "WebSearch",
                  "WebFetch",
                ]);
                if (readOnly.has(hookInput.tool_name)) return {};
                if (permissionMode === "dontAsk") return {};
                if (
                  permissionMode !== "default" &&
                  hookInput.tool_name !== "AskUserQuestion"
                )
                  return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "ask",
                    permissionDecisionReason: "WithMate approval required",
                  },
                };
              },
            ],
          },
        ],
      },
      /** SDK の許可要求を現在の方針に従って処理し、質問と承認を順番に中継する。不完全な回答や中断時は許可しない。 */
      canUseTool: async (toolName, toolInput, context) => {
        if (controller.signal.aborted || context.signal.aborted)
          return { behavior: "deny", message: "Canceled" };
        if (permissionMode === "dontAsk")
          return {
            behavior: "deny",
            message: "Only preapproved tools are allowed",
          };
        const requestId =
          context.toolUseID || `${input.session.id}:${Date.now()}`;
        if (toolName === "AskUserQuestion") {
          if (!input.onElicitationRequest)
            return { behavior: "deny", message: "Question UI is unavailable" };
          try {
            const textPosition = redactor.sanitizeText(liveText(trace)).length;
            const answer = await enqueueInteraction(
              AbortSignal.any([controller.signal, context.signal]),
              async (signal) => {
                elicitationRequest = {
                  ...redactor.sanitize(
                    claudeQuestionRequest(requestId, toolInput),
                  ),
                  textPosition,
                };
                await progress();
                try {
                  return await input.onElicitationRequest!(
                    elicitationRequest,
                    signal,
                  );
                } finally {
                  elicitationRequest = null;
                  void progress().catch(() => undefined);
                }
              },
            );
            if (answer.action !== "accept")
              return { behavior: "deny", message: "Question declined" };
            const questions = Array.isArray(toolInput.questions)
              ? toolInput.questions.map(objectOf)
              : [];
            const entries = questions.map((question, index) => {
              const value = answer.content?.[String(index)];
              return [
                textOf(question.question),
                Array.isArray(value) ? value.join(", ") : value,
              ] as const;
            });
            if (
              entries.some(
                ([question, value]) =>
                  !question || typeof value !== "string" || !value.trim(),
              )
            ) {
              return {
                behavior: "deny",
                message: "Question answer is incomplete",
              };
            }
            const answers = Object.fromEntries(entries);
            input.onElicitationDelivered?.(requestId);
            return {
              behavior: "allow",
              updatedInput: { ...toolInput, answers },
            };
          } catch {
            return { behavior: "deny", message: "Canceled" };
          }
        }
        if (!input.onApprovalRequest) {
          return { behavior: "deny", message: "Tool approval is unavailable" };
        }
        try {
          const decision = await enqueueInteraction(
            AbortSignal.any([controller.signal, context.signal]),
            async (signal) => {
              approvalRequest = redactor.sanitize({
                requestId,
                provider: "claude",
                kind: toolName,
                title: `Allow ${toolName}?`,
                summary: summarizeTool(toolName, toolInput),
                decisionMode: "direct-decision",
              });
              void progress().catch(() => undefined);
              try {
                return await input.onApprovalRequest!(approvalRequest, signal);
              } finally {
                approvalRequest = null;
                void progress().catch(() => undefined);
              }
            },
          );
          return decision === "approve"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Denied by user" };
        } catch {
          return { behavior: "deny", message: "Canceled" };
        }
      },
      /** 設定されたフォームまたは URL の入力要求を中継し、回答・拒否・取消を SDK が受け取れる形式で返す。 */
      onElicitation: async (request, context) => {
        if (!input.onElicitationRequest || controller.signal.aborted)
          return { action: "decline" };
        const projected = redactor.sanitize(
          mcpElicitationRequest(context.requestId, request),
        );
        if (!projected) return { action: "decline" };
        projected.textPosition = redactor.sanitizeText(liveText(trace)).length;
        try {
          const answer = await enqueueInteraction(
            AbortSignal.any([controller.signal, context.signal]),
            async (signal) => {
              elicitationRequest = projected;
              await progress();
              try {
                return await input.onElicitationRequest!(projected, signal);
              } finally {
                elicitationRequest = null;
                void progress().catch(() => undefined);
              }
            },
          );
          return answer.action === "accept"
            ? projected.mode === "url"
              ? { action: "accept" }
              : { action: "accept", content: answer.content ?? {} }
            : { action: answer.action };
        } catch {
          return { action: "cancel" };
        }
      },
    };
    const snapshotRoots = [workspacePath, ...prompt.additionalDirectories];
    const before = WORKSPACE_DIFF_CAPTURE_ENABLED
      ? await captureWorkspaceSnapshot(snapshotRoots).catch(() =>
          createDisabledWorkspaceSnapshotCapture(),
        )
      : createDisabledWorkspaceSnapshotCapture();
    let iterator: ReturnType<ClaudeQuery> | null = null;
    const userMessageId = randomUUID();
    let releaseInput!: () => void;
    const inputReleased = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    let sessionState: "idle" | "running" | "requires_action" | undefined;
    let terminalReceived = false;
    try {
      const userMessage = await buildUserMessage(prompt, userMessageId);
      if (controller.signal.aborted) throw new Error("Canceled");
      /** 今回のユーザー入力を一回だけ送り、実行が終了するまでは入力ストリームを閉じない。 */
      async function* sdkInput(): AsyncGenerator<SDKUserMessage> {
        yield userMessage;
        // トランスクリプトのみの通知が、この送信の処理前に結果を通知することがある。
        // その結果で SDK の承認・フック用入力チャネルを閉じないようにする。
        await inputReleased;
      }
      iterator = this.runQuery({ prompt: sdkInput(), options });
      let burst = 0;
      while (true) {
        const next = await signalRace(iterator.next(), controller.signal);
        if (next.done) break;
        if (
          next.value.type === "system" &&
          next.value.subtype === "session_state_changed"
        ) {
          sessionState = next.value.state;
        }
        if (next.value.type === "result") {
          const terminal = next.value;
          const matchesInput =
            terminal.user_message_uuid === userMessageId ||
            terminal.user_message_uuids?.includes(userMessageId);
          const sessionFailure =
            !terminal.user_message_uuid &&
            !terminal.user_message_uuids?.length &&
            !terminal.origin &&
            (terminal.subtype !== "success" || terminal.is_error);
          const reportFailure =
            trace.result &&
            trace.backgroundTaskInfo.size > 0 &&
            !terminal.user_message_uuid &&
            !terminal.user_message_uuids?.length &&
            terminal.origin?.kind === "task-notification" &&
            !terminal.origin.subkind &&
            (terminal.subtype !== "success" || terminal.is_error);
          if (reportFailure)
            throw new Error(
              terminal.subtype === "success"
                ? terminal.result
                : terminal.errors.join("\n") || terminal.subtype,
            );
          if (!matchesInput && !sessionFailure) continue;
        }
        this.receive(next.value, trace, Boolean(input.session.threadId));
        if (next.value.type === "system" && next.value.subtype === "init") {
          if (
            next.value.permissionMode &&
            next.value.permissionMode !== permissionMode
          ) {
            throw new Error(
              `Claude did not apply the requested permission mode (${permissionMode}); active mode: ${next.value.permissionMode}.`,
            );
          }
          if (
            input.executionOptions.codexSpeed === "fast" &&
            next.value.fast_mode_state === "off" &&
            next.value.fast_mode_disabled_reason !== "pending"
          ) {
            throw new Error(
              `Claude Fast mode is unavailable (${next.value.fast_mode_disabled_reason ?? "disabled"}). Select Standard to continue.`,
            );
          }
        }
        await signalRace(progress(), controller.signal);
        // 入力の結果はバックグラウンド処理の報告より先に届くことがある。親 Turn の処理完了は、
        // タスクのスナップショットが空かどうかではなく、SDK の idle で確認する。
        if (
          trace.result &&
          (trace.result.subtype !== "success" ||
            trace.result.is_error ||
            sessionState === "idle")
        ) {
          terminalReceived = true;
          break;
        }
        if (++burst >= 32) {
          burst = 0;
          await signalRace(
            new Promise<void>((resolve) => setImmediate(resolve)),
            controller.signal,
          );
        }
      }
      if (progressFailure) throw progressFailure;
      if (controller.signal.aborted) throw new Error("Canceled");
      if (!trace.result) throw new Error("Claude stream ended before a result");
      if (trace.result.subtype !== "success" || trace.result.is_error)
        throw new Error(trace.errorMessage || "Claude turn failed");
      if (!terminalReceived)
        throw new Error("Claude stream ended before session idle");
      if (trace.backgroundFailure) throw new Error(trace.backgroundFailure);
      const result = this.result(input, trace);
      const after = WORKSPACE_DIFF_CAPTURE_ENABLED
        ? await captureWorkspaceSnapshot(snapshotRoots).catch(() =>
            createDisabledWorkspaceSnapshotCapture(),
          )
        : createDisabledWorkspaceSnapshotCapture();
      result.artifact = redactor.sanitize(
        buildArtifactFromOperations({
          session: input.session,
          executionOptions: input.executionOptions,
          operations: result.artifact?.operationTimeline ?? [],
          usage: result.usage,
          threadId: result.threadId,
          beforeSnapshot: before.snapshot,
          afterSnapshot: after.snapshot,
          beforeSnapshotStats: before.stats,
          afterSnapshotStats: after.stats,
          providerCatalog: input.providerCatalog,
          selection,
        }),
      );
      this.addExecutionChecks(result.artifact, input, trace);
      return result;
    } catch (error) {
      const failure = progressFailure ?? error;
      const message =
        failure instanceof Error ? failure.message : String(failure);
      const canceled =
        !progressFailure &&
        (controller.signal.aborted || isCanceledProviderMessage(message));
      trace.errorMessage = message;
      throw new ProviderTurnError(
        redactor.sanitizeText(message),
        this.result(input, trace),
        canceled,
        providerErrorReason(message, canceled),
      );
    } finally {
      releaseInput();
      input.signal?.removeEventListener("abort", abort);
      if (
        progressFailure !== undefined &&
        childExited &&
        input.onCleanupPending
      ) {
        input.onCleanupPending(childExited);
      }
      try {
        if (iterator)
          await closeQuery(
            iterator,
            controller.signal.aborted || !terminalReceived,
          );
      } finally {
        controller.abort();
        if (
          childExited &&
          (input.signal?.aborted ||
            (progressFailure !== undefined && !input.onCleanupPending))
        ) {
          await childExited;
        }
      }
    }
  }
}
