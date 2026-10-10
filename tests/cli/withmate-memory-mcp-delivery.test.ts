import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWithMateMemoryMcpServer } from "../../src-electron/platform/mcp/withmate-memory-mcp.js";

// @test-value v2
// kind = "security"
// claim = "tools/listのSDK sendが成功しても、HTTP ownerによるdelivery確認が失敗すればlisted admissionを確定せずrollbackする"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "SDK send完了をHTTP response送出完了と同一視してdelivery拒否を無視し、CLI fallbackのlisted stateを残す"
// observable = "delivery待機前後のcommit回数と、delivery拒否後のrollback回数"
// observation_boundary = "component-behavior"
// scope = "canonical MCP serverのtoolsListDelivery hookとfallback admission commit境界"
// lifecycle = "permanent"
// impact = "正常送出されていないtool inventoryを取得済みとみなしてagent CLI fallbackを許可する"
// distinction = "既存send rejection testはSDK send後のHTTP delivery待機を通らない。通信とDBを増やさず新しい確認境界だけを検証する"
// @end-test-value
test("tools list admission waits for owner delivery and rolls back delivery failure", async () => {
  let commitCount = 0;
  let rollbackCount = 0;
  let failDelivery!: (error: Error) => void;
  let rollbackDone!: () => void;
  const delivery = new Promise<void>((_resolve, reject) => { failDelivery = reject; });
  const rolledBack = new Promise<void>((resolve) => { rollbackDone = resolve; });
  const server = createWithMateMemoryMcpServer({
    fallbackAdmission: {
      async markListed() {
        return {
          async commit() { commitCount += 1; },
          async rollback() { rollbackCount += 1; rollbackDone(); },
        };
      },
      async markEligible() { return false; },
    },
    toolsListDelivery: () => delivery,
  });
  const client = new Client({ name: "delivery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inventory = await client.listTools();
    assert.ok(inventory.tools.some((tool) => tool.name === "memory.append"));
    assert.equal(commitCount, 0);
    assert.equal(rollbackCount, 0);
    failDelivery(new Error("HTTP response closed before finish"));
    await rolledBack;
    assert.equal(commitCount, 0);
    assert.equal(rollbackCount, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
