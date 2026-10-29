import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GLOSSARY_RUNTIME_SCHEMA_VERSION } from "../../src-shared/glossary/glossary-contract.js";
import {
  GLOSSARY_RUNTIME_OPERATION_PATHS,
} from "../../src-shared/glossary/glossary-operation-schema.js";
import {
  GLOSSARY_MCP_TOOL_DEFINITIONS,
  createWithMateGlossaryMcpServer,
} from "../../src-electron/platform/mcp/withmate-glossary-mcp.js";
import { callGlossaryRuntime } from "../../src-electron/platform/mcp/withmate-glossary-runtime-client.js";
import {
  runWithMateGlossaryCli,
  WITHMATE_GLOSSARY_CLI_EXIT_CODES,
} from "../../src-cli/glossary/withmate-glossary.js";
import type {
  WithMateMemoryRuntimeOperation,
  WithMateMemoryRuntimeResponse,
} from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";

const CLI_ENV = {
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
  WITHMATE_MEMORY_API_SECRET: "api-secret",
  WITHMATE_MEMORY_OPERATOR_API_SECRET: "operator-secret",
  WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "22222222-2222-4222-8222-222222222222",
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-reference",
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "turn-capability",
};

const MCP_ENV = {
  ...CLI_ENV,
  WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
};

function echoRuntimeCall(calls: WithMateMemoryRuntimeOperation[]) {
  return async (
    _connection: unknown,
    operation: WithMateMemoryRuntimeOperation,
    _options: unknown,
  ): Promise<WithMateMemoryRuntimeResponse> => {
    calls.push(operation);
    return {
      ok: true,
      status: 200,
      value: {
        schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
        ok: true,
        received: operation.body,
      },
    };
  };
}

describe("withmate-glossary MCP contract", () => {
// @test-value v2
// kind = "contract"
// claim = "Glossary MCPがcanonical input schemaと明示repository selectorを公開する"
// oracle = { type = "contract", ref = "Glossary runtime contract" }
// fault = "Session IDによる権限自己申告を許可する、またはrepository selectorをschemaから落とす"
// observable = "SDK listToolsの公開schemaとget dispatch body"
// observation_boundary = "public-boundary"
// scope = "glossary-mcp"
// lifecycle = "permanent"
// @end-test-value
it("全operationがcanonical schemaを公開しSession ID自己申告を持たない", async () => {
    const calls: WithMateMemoryRuntimeOperation[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWithMateGlossaryMcpServer({ env: MCP_ENV, runtimeCall: echoRuntimeCall(calls) });
    const client = new Client({ name: "withmate-glossary-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        GLOSSARY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
      );
      for (const tool of tools.tools) {
        const properties = tool.inputSchema.properties ?? {};
        assert.equal(Object.hasOwn(properties, "path"), false);
        assert.equal(Object.hasOwn(properties, "sessionId"), false);
        assert.equal(Object.hasOwn(properties, "schemaVersion"), false);
      }
      const update = tools.tools.find((tool) => tool.name === "glossary.update");
      assert.ok(update?.inputSchema.required?.includes("explicitUserRequest"));
      const listTargets = tools.tools.find((tool) => tool.name === "glossary.list_targets");
      assert.ok(JSON.stringify(listTargets?.inputSchema).includes('"repository"'));

      const result = await client.callTool({
        name: "glossary.get",
        arguments: { termOrAlias: "RT" },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls[0], {
        method: "POST",
        path: GLOSSARY_RUNTIME_OPERATION_PATHS.get,
        body: {
          schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
          termOrAlias: "RT",
          selector: { kind: "primary" },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("withmate-glossary CLI contract", () => {
// @test-value v2
// kind = "contract"
// claim = "Glossary CLIとMCPが同じrequest bodyを構築する"
// oracle = { type = "contract", ref = "Glossary runtime contract" }
// fault = "CLIだけが異なるdefault selectorを送信し、またはSession ID optionを受け入れる"
// observable = "CLI dispatch bodyと不正option時のexit code"
// observation_boundary = "public-boundary"
// scope = "glossary-cli"
// lifecycle = "permanent"
// @end-test-value
it("MCPと同じdefault requestを構築し未知optionやSession ID optionを拒否する", async () => {
    const calls: WithMateMemoryRuntimeOperation[] = [];
    let output = "";
    const exitCode = await runWithMateGlossaryCli(["get", "--term", "RT"], {
      env: CLI_ENV,
      runtimeCall: echoRuntimeCall(calls),
      stdout: { write: (value) => { output += String(value); return true; } },
      stderr: { write: () => true },
    });
    assert.equal(exitCode, WITHMATE_GLOSSARY_CLI_EXIT_CODES.ok);
    assert.equal((JSON.parse(output) as { schemaVersion: string }).schemaVersion, GLOSSARY_RUNTIME_SCHEMA_VERSION);
    assert.deepEqual(calls[0], {
      method: "POST",
      path: GLOSSARY_RUNTIME_OPERATION_PATHS.get,
      body: {
        termOrAlias: "RT",
        selector: { kind: "primary" },
        schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      },
    });

    for (const args of [["list", "--path", "C:/other"], ["list", "--session-id", "other"]]) {
      const rejected = await runWithMateGlossaryCli(args, {
        env: CLI_ENV,
        stdout: { write: () => true },
        stderr: { write: () => true },
      });
      assert.equal(rejected, WITHMATE_GLOSSARY_CLI_EXIT_CODES.usage);
    }
  });

// @test-value v1
// kind = "security"
// claim = "binding欠落時にGlossary dispatchを拒否する"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "provider executionがunboundへdowngradeする"
// scope = "glossary-cli"
// lifecycle = "permanent"
// @end-test-value
it("provider execution markerにbindingがなければdispatchせずstructured authority errorを返す", async () => {
    let calls = 0;
    let output = "";
    const exitCode = await runWithMateGlossaryCli(["list"], {
      env: {
        ...CLI_ENV,
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "",
      },
      runtimeCall: async () => {
        calls += 1;
        throw new Error("must not dispatch");
      },
      stdout: { write: (value) => { output += String(value); return true; } },
      stderr: { write: () => true },
    });
    assert.equal(exitCode, WITHMATE_GLOSSARY_CLI_EXIT_CODES.operationError);
    assert.equal(calls, 0);
    assert.equal((JSON.parse(output) as { code: string }).code, "GLOSSARY_SESSION_BINDING_REQUIRED");
  });

// @test-value v2
// kind = "invariant"
// claim = "dispatch済みwriteのresponse lossをeffect unknownへ分類する"
// oracle = { type = "contract", ref = "Glossary runtime contract" }
// fault = "保存結果を成功と誤認する"
// observable = "runtime envelopeのok/code/effect/retryableとdispatch回数"
// observation_boundary = "public-boundary"
// scope = "glossary-cli"
// lifecycle = "permanent"
// distinction = "HTTP statusだけでは検出できないresponse schema不一致のunknown分類を確認する"
// @end-test-value
it("dispatch済みwriteの非glossary responseはHTTP statusによらずeffect unknownにする", async () => {
    const result = await callGlossaryRuntime({
      operation: "create",
      path: GLOSSARY_RUNTIME_OPERATION_PATHS.create,
      body: {
        schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
        selector: { kind: "primary" },
        mode: "explicit",
        entry: { term: "Runtime", definition: "definition" },
      },
    }, {
      adapter: "cli",
      env: CLI_ENV,
      runtimeCall: async () => ({ ok: true, status: 200, value: {} }),
    });

    assert.ok("ok" in result);
    assert.equal(result.ok, false);
    assert.ok("code" in result);
    assert.ok("effect" in result);
    assert.ok("retryable" in result);
    assert.equal(result.code, "GLOSSARY_TRANSPORT_ERROR");
    assert.equal(result.effect, "unknown");
    assert.equal(result.retryable, false);
  });

// @test-value v2
// kind = "security"
// claim = "Glossary CLIのruntime dispatchが413応答をGLOSSARY_LIMIT_EXCEEDED/effect noneへ分類する"
// oracle = { type = "contract", ref = "src-electron/platform/mcp/withmate-glossary-runtime-client.ts" }
// fault = "runtimeから返された413を成功、transport error、またはretryableとして誤分類する"
// observable = "exchange path、turn capability、runtime dispatch call count、413 responseのenvelope分類"
// observation_boundary = "public-boundary"
// scope = "glossary-cli"
// lifecycle = "permanent"
// distinction = "実HTTP serverのbody受信・拒否ではなく、CLIとruntimeCallの公開dispatch境界に限定して413分類を確認する"
// @end-test-value
it("Glossary専用exchangeのruntime 413応答をeffect noneに分類する", async () => {
    let exchangePath = "";
    let turnCapability = "";
    let dispatchCalls = 0;
    const result = await callGlossaryRuntime({
      operation: "create_batch",
      path: GLOSSARY_RUNTIME_OPERATION_PATHS.create_batch,
      body: {
        schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
        selector: { kind: "primary" },
        mode: "explicit",
        entries: [{ term: "Runtime", definition: "definition" }],
      },
    }, {
      adapter: "cli",
      env: CLI_ENV,
      runtimeCall: async (_connection, _operation, options) => {
        dispatchCalls += 1;
        exchangePath = options.exchangePath ?? "";
        turnCapability = options.turnCapability ?? "";
        return { ok: false, status: 413, value: { error: { code: "MEMORY_REQUEST_TOO_LARGE" } } };
      },
    });

    assert.equal(exchangePath, WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH);
    assert.equal(turnCapability, CLI_ENV.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY);
    assert.equal(dispatchCalls, 1);
    assert.ok("ok" in result);
    assert.equal(result.ok, false);
    assert.ok("code" in result);
    assert.ok("effect" in result);
    assert.ok("retryable" in result);
    assert.equal(result.code, "GLOSSARY_LIMIT_EXCEEDED");
    assert.equal(result.effect, "none");
    assert.equal(result.retryable, false);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Glossary全9操作のCLIとSDK MCPは明示repositoryを同じbodyと同じ結果で扱う"
// oracle = { type = "contract", ref = "docs/runbooks/repository-glossary.md#Managed Skill、MCP、CLI" }
// fault = "CLIだけがrepository selectorやexplicit markerを落とし、操作結果や入力errorを異なる意味へ変える"
// observable = "各entryのruntime dispatch body、認可option、JSON結果と入力失敗時のdispatch件数"
// observation_boundary = "public-boundary"
// scope = "glossary-cli-mcp-parity"
// lifecycle = "permanent"
// distinction = "個別schema testやstorage testで代替できない両transport実entryの9操作結線を確認する"
// impact = "transport切替で別repositoryや異なる書込契約を使用することを防ぐ"
// @end-test-value
it("全9操作が無bindingの明示repositoryで同じdispatchと結果を返す", async () => {
  const selector = { kind: "repository", path: process.cwd() };
  const entry = { term: "Parity", definition: "shared contract" };
  const revision = "a".repeat(64);
  const inputs = {
    list_targets: { selector }, list: { selector }, search: { selector, query: "Parity" }, get: { selector, termOrAlias: "Parity" },
    create: { selector, mode: "explicit", entry }, create_batch: { selector, mode: "explicit", entries: [entry] },
    update: { selector, expectedRevision: revision, targetTerm: "Parity", entry, explicitUserRequest: true },
    delete: { selector, expectedRevision: revision, targetTerm: "Parity", explicitUserRequest: true }, validate: { selector },
  };
  const unboundEnv = { ...MCP_ENV, WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "", WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "", WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "" };
  const calls: WithMateMemoryRuntimeOperation[] = [];
  const runtimeCall = async (_connection: unknown, operation: WithMateMemoryRuntimeOperation, options: { bindingReference?: string; turnCapability?: string; exchangePath?: string }) => {
    assert.equal(options.bindingReference, undefined);
    assert.equal(options.turnCapability, undefined);
    assert.equal(options.exchangePath, WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH);
    return echoRuntimeCall(calls)(_connection, operation, options);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWithMateGlossaryMcpServer({ env: unboundEnv, runtimeCall });
  const client = new Client({ name: "glossary-full-parity", version: "1.0.0" });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (const [operation, body] of Object.entries(inputs)) {
      let output = "";
      const exit = await runWithMateGlossaryCli([operation.replaceAll("_", "-"), "--json", JSON.stringify(body)], {
        env: unboundEnv, runtimeCall, stdout: { write: (value) => { output += String(value); return true; } }, stderr: { write: () => true },
      });
      const tool = await client.callTool({ name: `glossary.${operation}`, arguments: body });
      assert.equal(exit, 0);
      assert.deepEqual(JSON.parse(output), tool.structuredContent);
      assert.deepEqual(calls.at(-1), calls.at(-2));
      assert.deepEqual(calls.at(-1)?.body, { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION, ...body });
    }
    const count = calls.length;
    let invalid = "";
    assert.equal(await runWithMateGlossaryCli(["update", "--json", JSON.stringify({ selector })], {
      env: unboundEnv, runtimeCall, stdout: { write: (value) => { invalid += String(value); return true; } }, stderr: { write: () => true },
    }), WITHMATE_GLOSSARY_CLI_EXIT_CODES.usage);
    assert.equal(JSON.parse(invalid).code, "GLOSSARY_INVALID_REQUEST");
    assert.equal((await client.callTool({ name: "glossary.update", arguments: { selector } })).isError, true);
    assert.equal(calls.length, count);
    let shorthand = "";
    assert.equal(await runWithMateGlossaryCli(["list-targets", "--repository", selector.path], {
      env: unboundEnv, runtimeCall, stdout: { write: (value) => { shorthand += String(value); return true; } }, stderr: { write: () => true },
    }), 0);
    assert.deepEqual(JSON.parse(shorthand).received.selector, selector);
    let schema = "";
    assert.equal(await runWithMateGlossaryCli(["schema"], { env: {}, stdout: { write: (value) => { schema += String(value); return true; } } }), 0);
    const projection = JSON.parse(schema) as { operations: Array<{ inputSchema: { properties: Record<string, unknown> } }> };
    assert.equal(projection.operations.length, 9);
    assert.ok(projection.operations.every((operation) => operation.inputSchema.properties.selector));
  } finally { await client.close(); await server.close(); }
});
