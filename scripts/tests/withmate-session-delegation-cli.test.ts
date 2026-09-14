import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  WITHMATE_SESSION_CLI_EXIT_CODES,
  runWithMateSessionCli,
} from "../withmate-session.js";

const connection = {
  adapter: "cli" as const,
  baseUrl: "http://127.0.0.1:4567",
  apiSecret: "api-secret",
  adapterSecret: "cli-secret",
  applicationInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function capture() {
  let value = "";
  return { stream: { write(chunk: string) { value += chunk; } }, json: () => JSON.parse(value.trim()) as Record<string, any> };
}

const turn = {
  provider: "codex",
  userMessage: "delegate",
  model: "gpt-5",
  reasoningEffort: "medium",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  attachments: [],
};
const createInput = {
  idempotencyKey: "delegation-create",
  dispatch: "prepare",
  items: [{
    target: { kind: "existing", sessionId: "session-1" },
    work: { kind: "existing", workItemId: "work-1" },
    turn: { catalogRevision: 1, turn },
  }],
};

// @test-value v2
// kind = "contract"
// claim = "CLIのdelegation 6サブコマンドはnamespaced commandとして解析され、対応するdotted operationをruntimeへ渡す"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "delegation commandが未登録扱いになるか、異なるoperation discriminatorでruntimeへ送られる"
// observable = "runtime clientへ渡るrequest envelopeのoperationとCLI成功exit code"
// observation_boundary = "public-boundary"
// scope = "withmate-session CLI delegation command parsing"
// lifecycle = "permanent"
// @end-test-value
test("delegation CLI subcommands dispatch their canonical operations", async () => {
  const cases = [
    ["create", createInput, "delegation.create"],
    ["get", { delegationId: "delegation-1" }, "delegation.get"],
    ["list", { limit: 10 }, "delegation.list"],
    ["retry", { delegationId: "delegation-1", expectedRevision: 1, idempotencyKey: "retry-1", dispatch: "enqueue" }, "delegation.retry"],
    ["cancel", { delegationId: "delegation-1", expectedRevision: 1, idempotencyKey: "cancel-1" }, "delegation.cancel"],
    ["compensate", { delegationId: "delegation-1", expectedRevision: 1, idempotencyKey: "compensate-1" }, "delegation.compensate"],
  ] as const;

  for (const [command, input, operation] of cases) {
    const output = capture();
    const requests: any[] = [];
    const exitCode = await runWithMateSessionCli(["delegation", command, "--json", JSON.stringify(input)], {
      stdout: output.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult(operation, {} as never) };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok, `${command}: ${JSON.stringify(output.json())}`);
    assert.equal(requests[0]?.operation, operation, command);
    assert.equal(output.json().result.schemaVersion, SESSION_RUNTIME_RESULT_SCHEMA_VERSION);
  }
});
