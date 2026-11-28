import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mapApprovalModeToClaudePermissionMode } from "../../../src-shared/settings/provider-runtime-options.js";
import { buildManagedHttpMcpServers } from "../managed-http-mcp.js";
import { buildProviderAgentRuntimeBindingEnv, mergeDefinedProviderEnv } from "../provider-agent-runtime-binding.js";
import { APPROVAL_REVIEW_INSTRUCTIONS, approvalReviewDecisionSchema, type OpenApprovalReviewer } from "../approval-reviewer.js";

// 同梱の Claude CLI は --json-schema を draft-07 で検証する。
const providerSchema = z.toJSONSchema(approvalReviewDecisionSchema, { target: "draft-07" });

function nextReviewInput() {
  let resolve!: (message: SDKUserMessage | null) => void;
  const promise = new Promise<SDKUserMessage | null>((accept) => { resolve = accept; });
  return { promise, resolve };
}

type ClaudeReviewRuntime = {
  query(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Pick<Query, "next" | "close" | "supportedModels">;
  spawn: typeof spawn;
  resolveBinary: () => string;
};

export const createClaudeApprovalReviewer = (runtime: ClaudeReviewRuntime): OpenApprovalReviewer => async ({ selection, workspacePath, binding, signal }) => {
  signal.throwIfAborted();
  const permissionMode = mapApprovalModeToClaudePermissionMode("on-request", "auto-review");

  const controller = new AbortController();
  let input = nextReviewInput();
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
  const start = () => runtime.query({ prompt: prompts(), options: {
    cwd: workspacePath, pathToClaudeCodeExecutable: runtime.resolveBinary(),
    env: mergeDefinedProviderEnv(process.env, buildProviderAgentRuntimeBindingEnv(binding)),
    model: selection.model,
    ...(selection.reasoningEffort ? { effort: selection.reasoningEffort as Options["effort"] } : {}),
    settingSources: ["user", "project", "local"],
    settings: { fallbackModel: [] },
    persistSession: false, permissionMode,
    mcpServers: buildManagedHttpMcpServers(binding),
    mcpServersDelivery: "initialize",
    systemPrompt: { type: "preset", preset: "claude_code", append: APPROVAL_REVIEW_INSTRUCTIONS, snapshot: false },
    outputFormat: { type: "json_schema", schema: providerSchema },
    abortController: controller,
    // SDK ログ、トランスクリプト、MCP 認証情報はプロバイダー診断に転記しない。
    spawnClaudeCodeProcess: (options) => {
      controller.signal.throwIfAborted();
      const child = runtime.spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
        signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stderr?.on("error", () => undefined);
      child.stderr?.resume();
      childExited = new Promise<void>((resolve) => {
        child.once("close", resolve);
        // AbortError は exit より先に届くことがある。待機すべき子プロセスがないのは、起動に失敗した場合だけ。
        child.once("error", () => { if (child.pid === undefined) resolve(); });
      });
      return child;
    },
  } });
  const close = () => {
    if (!controller.signal.aborted) {
      signal.removeEventListener("abort", close);
      input.resolve(null);
      controller.abort();
      try { stream?.close(); }
      catch { /* 管理下の子プロセスの close イベントで停止を確認する。 */ }
    }
    return childExited;
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    stream = start();
    const model = (await stream.supportedModels()).find((entry) => entry.value === selection.model);
    controller.signal.throwIfAborted();
    const efforts = model?.supportsEffort ? model.supportedEffortLevels ?? [] : [];
    if (!model || (efforts.length ? !efforts.some((effort) => effort === selection.reasoningEffort)
      : selection.reasoningEffort !== "")) throw new Error("Review model or depth is unavailable.");
  } catch (error) { await close(); throw error; }

  let nativeModel: string | undefined;
  return {
    close,
    async review(prompt) {
      controller.signal.throwIfAborted();
      const uuid = randomUUID();
      input.resolve({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: prompt } });
      for (;;) {
        const next = await stream.next();
        if (next.done) throw new Error("Approval reviewer stopped without a result.");
        const message = next.value;
        if (message.type === "system" && message.subtype === "init") {
          if (message.permissionMode !== permissionMode) {
            throw new Error("Claude native Auto Review is not active.");
          }
          if (!message.model || (nativeModel && message.model !== nativeModel)) throw new Error("Claude reviewer model changed.");
          // ネイティブの初期化通知で、sonnet などのカタログ上の別名に対応する実際のモデルを取得する。
          nativeModel = message.model;
        }
        if (message.type === "assistant" && message.parent_tool_use_id === null
          && nativeModel && message.message.model !== nativeModel) throw new Error("Claude reviewer model changed.");
        if (message.type !== "result") continue;
        if (!nativeModel || message.subtype !== "success" || message.is_error || message.permission_denials?.length
          || (message.user_message_uuid !== uuid && !message.user_message_uuids?.includes(uuid))) {
          throw new Error("Approval reviewer did not return a successful result for this request.");
        }
        return message.structured_output;
      }
    },
  };
};
