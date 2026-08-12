import assert from "node:assert/strict";
import test from "node:test";

import { resolveSkillDiscoveryRequest } from "../../src/skill-discovery-request.js";

test("Skill候補は Auxiliary ID ではなく親workspaceと実行providerから取得する", () => {
  assert.deepEqual(resolveSkillDiscoveryRequest({
    parentProviderId: "copilot",
    parentWorkspacePath: "C:/workspace/main",
    auxiliaryProviderId: "codex",
  }), {
    providerId: "codex",
    workspacePath: "C:/workspace/main",
  });
});

test("Skill候補は Auxiliary がない場合も親Sessionのproviderとworkspaceを使う", () => {
  assert.deepEqual(resolveSkillDiscoveryRequest({
    parentProviderId: "copilot",
    parentWorkspacePath: "C:/workspace/main",
  }), {
    providerId: "copilot",
    workspacePath: "C:/workspace/main",
  });
});

test("Skill候補は親workspaceを特定できない場合に取得しない", () => {
  assert.equal(resolveSkillDiscoveryRequest({
    parentProviderId: "codex",
    auxiliaryProviderId: "codex",
  }), null);
});
