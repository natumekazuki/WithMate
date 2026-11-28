import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudeApprovalReviewer } from "../../src-electron/providers/claude/claude-approval-reviewer.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";

/** 指定した権限モードの起動通知を作り、Reviewerが実際のモードを確認できるようにする。 */
function initMessage(
  permissionMode: SDKSystemMessage["permissionMode"],
): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    tools: ["Bash"],
    permissionMode,
    mcp_servers: [{ name: "withmate-session", status: "connected" }],
    agents: ["Explore"],
    plugins: [{ name: "cc-plugin-privacy", path: "builtin" }],
    apiKeySource: "none",
    claude_code_version: "test",
    cwd: "workspace",
    model: "chosen-model",
    slash_commands: [],
    output_style: "default",
    skills: [],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "review",
  };
}

/** 承認元のモデル・作業ディレクトリと管理MCPの接続設定を含む入力を作る。 */
function input() {
  return {
    selection: {
      providerId: "claude",
      model: "chosen-model",
      reasoningEffort: "high",
    } as const,
    workspacePath: "source-workspace",
    appSettings: normalizeAppSettings({}),
    binding: {
      bindingId: "binding",
      bindingReference: "source-secret",
      providerId: "opencode",
      executionGeneration: "generation",
      transport: "env",
      expiresAt: null,
      turnCapability: "turn-secret",
      managedMcp: {
        sessionUrl: "http://127.0.0.1/session",
        glossaryUrl: "http://127.0.0.1/glossary",
        token: "managed-secret",
      },
    } as const,
  };
}

/** モックを使うケースで実プロセス起動に進んだ場合に失敗させる。 */
const unusedSpawn = () => {
  throw new Error("SDK fixture does not spawn a process");
};

// @test-value v2
// kind = "contract"
// claim = "Claude審査は共通設定のModel・Depthと通常Session接続でネイティブAuto Reviewを要求し、対応する入力の構造化値だけを取り出す"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "ネイティブAuto Reviewを要求しない、審査指示や認証済み履歴への経路を渡さない、または自然文・異なる入力の結果を判定にする"
// observable = "SDKの起動設定、同じSDK会話の入力、構造化結果・自然文・異なる入力への返値"
// observation_boundary = "public-boundary"
// scope = "Claude reviewer adapterとSDK transportの境界"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "共通審査testのadapter stubはClaude SDKの起動オプションと構造化終端の入力ID照合を通らない"
// @end-test-value
/** ネイティブAuto Reviewの設定で一つの会話を開き、判定を対応する入力だけへ返して終了できることを確認する。 */
test("Claude review uses native Auto Review and correlates structured output with each input", async () => {
  const decisions = [
    { decision: "allow_once", reason: "Authorized." },
    undefined,
    { decision: "deny", reason: "Not this request." },
  ];
  let opened = 0;
  let closed = 0;
  let reviewed = 0;
  const open = createClaudeApprovalReviewer({
    spawn: unusedSpawn,
    /** 実行ファイルの有無をテスト環境に依存させず、設定の検証に集中する。 */
    resolveBinary: () => "unused-native-binary",
    /** SDK起動時のモデル・設定・接続・出力形式を照合し、入力に対応する模擬ストリームを返す。 */
    query: ({ prompt, options }) => {
      opened++;
      assert.equal(options.model, "chosen-model");
      assert.equal(options.effort, "high");
      assert.equal(options.cwd, "source-workspace");
      assert.deepEqual(options.settingSources, ["user", "project", "local"]);
      assert.equal(options.permissionMode, "auto");
      assert.equal(options.persistSession, false);
      assert.deepEqual(options.settings, { fallbackModel: [] });
      assert.equal(options.canUseTool, undefined);
      assert.equal(options.mcpServersDelivery, "initialize");
      assert.deepEqual(options.mcpServers?.["withmate-session"], {
        type: "http",
        url: "http://127.0.0.1/session",
        headers: { "x-withmate-mcp-token": "managed-secret" },
      });
      assert.match(
        JSON.stringify(options.systemPrompt),
        /do not execute it.*Skip routine development steps.*WithMate history/s,
      );
      assert.doesNotMatch(JSON.stringify(options.systemPrompt), /-secret/);
      assert.equal(options.outputFormat?.type, "json_schema");
      assert.equal(
        options.outputFormat.schema.$schema,
        "http://json-schema.org/draft-07/schema#",
      );
      const inputs = prompt[Symbol.asyncIterator]();
      let sentInit = false;
      return {
        /** 要求したモデルと推論レベルが利用可能なモデル一覧を返す。 */
        async supportedModels() {
          return [
            {
              value: "chosen-model",
              displayName: "Chosen",
              description: "",
              supportsEffort: true,
              supportedEffortLevels: ["high"],
            },
          ];
        },
        /** 中断で会話が閉じた回数を記録する。 */
        close() {
          closed++;
        },
        /** 起動通知の後に各入力を受け取り、判定なしや別入力の結果も模擬する。 */
        async next(): Promise<IteratorResult<SDKMessage, void>> {
          if (!sentInit) {
            sentInit = true;
            return { done: false, value: initMessage("auto") };
          }
          const { value } = await inputs.next();
          const index = reviewed++;
          assert.equal(value.message.content, `operation ${index}`);
          return {
            done: false,
            value: {
              type: "result",
              subtype: "success",
              is_error: false,
              user_message_uuid: index === 2 ? "unrelated" : value.uuid,
              result: "allow_once",
              structured_output: decisions[index],
            } as SDKMessage,
          };
        },
      };
    },
  });
  const signal = new AbortController();
  const conversation = await open({ ...input(), signal: signal.signal });
  assert.deepEqual(await conversation.review("operation 0"), decisions[0]);
  assert.equal(await conversation.review("operation 1"), undefined);
  await assert.rejects(conversation.review("operation 2"), /for this request/);
  signal.abort();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

// @test-value v2
// kind = "security"
// claim = "選択Depth非対応、Auto Review無効、モデル代替、審査役の操作が否認された場合はClaudeの判定を採用しない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "非対応Depthへ置換するか、選択と異なる実行条件や許可に失敗した審査の結果を採用する"
// observable = "起動回数、SDKへ渡す入力の消費有無、open/reviewの失敗とcleanup"
// observation_boundary = "public-boundary"
// scope = "Claude reviewer adapterの不成立時の境界"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "正常SDKの起動設定だけでは、本番SDKからの異なる実行条件や否認付き結果を受理しないことを観測しない"
// @end-test-value
/** 推論レベル不足、Auto Review未起動、モデル置換、権限拒否を許可判定として扱わないことを確認する。 */
test("Claude review rejects unavailable depth, inactive Auto Review, or a substituted model", async () => {
  for (const scenario of [
    "depth",
    "wrong-mode",
    "different-model",
    "native-denial",
  ] as const) {
    let opened = 0;
    let closed = 0;
    const open = createClaudeApprovalReviewer({
      spawn: unusedSpawn,
      /** 異常系でもネイティブ実行ファイルの探索に依存しないようにする。 */
      resolveBinary: () => "unused-native-binary",
      /** ケースごとの起動通知・利用可能レベル・結果を返すSDKストリームを用意する。 */
      query: ({ prompt }) => {
        opened++;
        const inputs = prompt[Symbol.asyncIterator]();
        let requestId: string | null = null;
        let emittedSubstitute = false;
        return {
          /** 深度不足のケースだけ、要求されたlevelをモデル能力から除く。 */
          async supportedModels() {
            return [
              {
                value: "chosen-model",
                displayName: "Chosen",
                description: "",
                supportsEffort: true,
                supportedEffortLevels: [scenario === "depth" ? "low" : "high"],
              },
            ];
          },
          /** 設定や判定が拒否された後もストリームを閉じた回数を記録する。 */
          close() {
            closed++;
          },
          /** 起動通知と結果の異常を順に返し、深度不足時には入力取得が起きないことを確認する。 */
          async next() {
            assert.notEqual(
              scenario,
              "depth",
              "no prompt may be requested before validating the selection",
            );
            if (requestId === null) {
              const { value } = await inputs.next();
              assert.ok(value.uuid);
              requestId = value.uuid;
              return {
                done: false,
                value: initMessage(
                  scenario === "wrong-mode" ? "default" : "auto",
                ),
              };
            }
            if (scenario === "different-model" && !emittedSubstitute) {
              emittedSubstitute = true;
              return {
                done: false,
                value: {
                  type: "assistant",
                  parent_tool_use_id: null,
                  message: { model: "replacement-model" },
                } as SDKMessage,
              };
            }
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                is_error: false,
                user_message_uuid: requestId,
                permission_denials:
                  scenario === "native-denial"
                    ? [
                        {
                          tool_name: "mcp__withmate-session__get_message",
                          tool_use_id: "withmate-history",
                          tool_input: {},
                        },
                      ]
                    : [],
                structured_output: {
                  decision: "allow_once",
                  reason: "A result from an unsafe session.",
                },
              } as SDKMessage,
            };
          },
        };
      },
    });
    const signal = new AbortController();
    if (scenario !== "depth") {
      const conversation = await open({ ...input(), signal: signal.signal });
      await assert.rejects(conversation.review("operation"), {
        message:
          scenario === "wrong-mode"
            ? /Auto Review is not active/
            : scenario === "different-model"
              ? /model changed/
              : /for this request/,
      });
      conversation.close();
    } else {
      await assert.rejects(
        open({ ...input(), signal: signal.signal }),
        /depth is unavailable/,
      );
    }
    assert.deepEqual([opened, closed], [1, 1]);
  }
});
