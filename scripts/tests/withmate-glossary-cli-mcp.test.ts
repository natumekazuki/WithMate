import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GLOSSARY_RUNTIME_SCHEMA_VERSION } from "../../src/glossary-contract.js";
import {
  GLOSSARY_RUNTIME_OPERATION_PATHS,
} from "../../src/glossary-operation-schema.js";
import {
  GLOSSARY_MCP_TOOL_DEFINITIONS,
  createWithMateGlossaryMcpServer,
} from "../withmate-glossary-mcp.js";
import { callGlossaryRuntime } from "../withmate-glossary-runtime-client.js";
import {
  runWithMateGlossaryCli,
  WITHMATE_GLOSSARY_CLI_EXIT_CODES,
} from "../withmate-glossary.js";
import type {
  WithMateMemoryRuntimeOperation,
  WithMateMemoryRuntimeResponse,
} from "../withmate-memory-runtime-client.js";

const CLI_ENV = {
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
  WITHMATE_MEMORY_API_SECRET: "api-secret",
  WITHMATE_MEMORY_OPERATOR_API_SECRET: "operator-secret",
  WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "runtime-a",
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-reference",
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
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
  it("全operationをcanonical input schemaで公開し、pathやSession IDをauthority inputに持たない", async () => {
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
  it("MCPと同じrequest bodyを構築し、caller pathやSession ID optionを受け付けない", async () => {
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

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "GLOSSARY_TRANSPORT_ERROR");
      assert.equal(result.effect, "unknown");
      assert.equal(result.retryable, false);
    }
  });
});
