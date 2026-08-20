import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupArtifactOperations } from "../../src/artifact-operation-grouping.js";
import type { AuditLogOperation } from "../../src/runtime-state.js";

function operation(type: string, summary: string): AuditLogOperation {
  return { type, summary };
}

describe("groupArtifactOperations", () => {
  it("連続する同じoperation typeだけをまとめ、到着順のgroupを維持する", () => {
    const operations = [
      operation("command_execution", "npm test"),
      operation("command_execution", "npm run typecheck"),
      operation("mcp_tool_call", "filesystem/read"),
      operation("command_execution", "npm run build"),
      operation("command_execution", "npm run lint"),
    ];

    const groups = groupArtifactOperations(operations);

    assert.deepEqual(groups.map((group) => ({
      type: group.type,
      summaries: group.operations.map((entry) => entry.summary),
    })), [
      {
        type: "command_execution",
        summaries: ["npm test", "npm run typecheck"],
      },
      {
        type: "mcp_tool_call",
        summaries: ["filesystem/read"],
      },
      {
        type: "command_execution",
        summaries: ["npm run build", "npm run lint"],
      },
    ]);
  });

  it("空のoperation timelineは空のgroupを返す", () => {
    assert.deepEqual(groupArtifactOperations([]), []);
  });
});
