import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mapApprovalModeToClaudePermissionMode } from "../../../src-shared/settings/provider-runtime-options.js";
import { buildManagedHttpMcpServers } from "../managed-http-mcp.js";
import {
  buildProviderAgentRuntimeBindingEnv,
  mergeDefinedProviderEnv,
} from "../provider-agent-runtime-binding.js";
import {
  APPROVAL_REVIEW_INSTRUCTIONS,
  approvalReviewDecisionSchema,
  type OpenApprovalReviewer,
} from "../approval-reviewer.js";

// 同梱の Claude CLI は --json-schema を draft-07 で検証する。
const providerSchema = z.toJSONSchema(approvalReviewDecisionSchema, {
  target: "draft-07",
});

/** 次の要求を渡す待機枠を一つ作る。停止時は null を流して入力を終える。 */
function nextReviewInput() {
  let resolve!: (message: SDKUserMessage | null) => void;
  const promise = new Promise<SDKUserMessage | null>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** レビュー用 SDK の起動と、子プロセスの所有・バイナリ解決を行う依存。 */
type ClaudeReviewRuntime = {
  /** 入力ストリームを SDK につなぎ、結果の読み取り・モデル確認・停止の操作を返す。 */
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }): Pick<Query, "next" | "close" | "supportedModels">;
  spawn: typeof spawn;
  resolveBinary: () => string;
};

/** Claude のネイティブ Auto Review で構造化判定を受け取る会話を開く。指定モデルや推論深度を利用できなければ停止して拒否する。 */
export const createClaudeApprovalReviewer =
  (runtime: ClaudeReviewRuntime): OpenApprovalReviewer =>
  async ({ selection, workspacePath, binding, signal }) => {
    signal.throwIfAborted();
    const permissionMode = mapApprovalModeToClaudePermissionMode(
      "on-request",
      "auto-review",
    );

    const controller = new AbortController();
    let input = nextReviewInput();
    /** 必要なときに一件ずつ SDK へ入力し、次の受付枠を作ってから現在の要求を渡す。 */
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      while (!controller.signal.aborted) {
        const message = await input.promise;
        if (!message || controller.signal.aborted) return;
        input = nextReviewInput();
        yield message;
      }
    }
    let stream: ReturnType<ClaudeReviewRuntime["query"]> | undefined;
    let childExited: Promise<void> | undefined;
    /** 永続履歴や代替モデルを使わず、Auto Review と構造化出力を指定して SDK を開始する。 */
    const start = () =>
      runtime.query({
        prompt: prompts(),
        options: {
          cwd: workspacePath,
          pathToClaudeCodeExecutable: runtime.resolveBinary(),
          env: mergeDefinedProviderEnv(
            process.env,
            buildProviderAgentRuntimeBindingEnv(binding),
          ),
          model: selection.model,
          ...(selection.reasoningEffort
            ? { effort: selection.reasoningEffort as Options["effort"] }
            : {}),
          settingSources: ["user", "project", "local"],
          settings: { fallbackModel: [] },
          persistSession: false,
          permissionMode,
          mcpServers: buildManagedHttpMcpServers(binding),
          mcpServersDelivery: "initialize",
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: APPROVAL_REVIEW_INSTRUCTIONS,
            snapshot: false,
          },
          outputFormat: { type: "json_schema", schema: providerSchema },
          abortController: controller,
          // SDK ログ、トランスクリプト、MCP 認証情報はプロバイダー診断に転記しない。
          /** SDK が起動する子を捕捉し、終了待ちを登録してから SDK へ返す。 */
          spawnClaudeCodeProcess: (options) => {
            controller.signal.throwIfAborted();
            const child = runtime.spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            child.stderr?.on("error", () => undefined);
            child.stderr?.resume();
            childExited = new Promise<void>((resolve) => {
              child.once("close", resolve);
              // AbortError は exit より先に届くことがある。待機すべき子プロセスがないのは、起動に失敗した場合だけ。
              child.once("error", () => {
                if (child.pid === undefined) resolve();
              });
            });
            return child;
          },
        },
      });
    /** 入力を閉じて SDK に中断を通知し、起動済みの子の停止を確認できる Promise を返す。 */
    const close = () => {
      if (!controller.signal.aborted) {
        signal.removeEventListener("abort", close);
        input.resolve(null);
        controller.abort();
        try {
          stream?.close();
        } catch {
          /* 管理下の子プロセスの close イベントで停止を確認する。 */
        }
      }
      return childExited;
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      stream = start();
      const model = (await stream.supportedModels()).find(
        (entry) => entry.value === selection.model,
      );
      controller.signal.throwIfAborted();
      const efforts = model?.supportsEffort
        ? (model.supportedEffortLevels ?? [])
        : [];
      if (
        !model ||
        (efforts.length
          ? !efforts.some((effort) => effort === selection.reasoningEffort)
          : selection.reasoningEffort !== "")
      )
        throw new Error("Review model or depth is unavailable.");
    } catch (error) {
      await close();
      throw error;
    }

    let nativeModel: string | undefined;
    return {
      close,
      /** 入力 UUID に対応し、ネイティブのモデルと Auto Review を確認できた成功結果だけから構造化判定を返す。 */
      async review(prompt) {
        controller.signal.throwIfAborted();
        const uuid = randomUUID();
        input.resolve({
          type: "user",
          uuid,
          parent_tool_use_id: null,
          message: { role: "user", content: prompt },
        });
        for (;;) {
          const next = await stream.next();
          if (next.done)
            throw new Error("Approval reviewer stopped without a result.");
          const message = next.value;
          if (message.type === "system" && message.subtype === "init") {
            if (message.permissionMode !== permissionMode) {
              throw new Error("Claude native Auto Review is not active.");
            }
            if (
              !message.model ||
              (nativeModel && message.model !== nativeModel)
            )
              throw new Error("Claude reviewer model changed.");
            // ネイティブの初期化通知で、sonnet などのカタログ上の別名に対応する実際のモデルを取得する。
            nativeModel = message.model;
          }
          if (
            message.type === "assistant" &&
            message.parent_tool_use_id === null &&
            nativeModel &&
            message.message.model !== nativeModel
          )
            throw new Error("Claude reviewer model changed.");
          if (message.type !== "result") continue;
          if (
            !nativeModel ||
            message.subtype !== "success" ||
            message.is_error ||
            message.permission_denials?.length ||
            (message.user_message_uuid !== uuid &&
              !message.user_message_uuids?.includes(uuid))
          ) {
            throw new Error(
              "Approval reviewer did not return a successful result for this request.",
            );
          }
          return message.structured_output;
        }
      },
    };
  };
