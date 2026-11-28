import assert from "node:assert/strict";
import test from "node:test";

import { resolveSkillDiscoveryRequest } from "../../src/skills/skill-discovery-request.js";

/** Auxiliary の実行先が親と異なる場合、検索には Auxiliary のプロバイダーと親のワークスペースを組み合わせる。 */
test("Skill候補は Auxiliary ID ではなく親workspaceと実行providerから取得する", () => {
  assert.deepEqual(
    resolveSkillDiscoveryRequest({
      parentProviderId: "copilot",
      parentWorkspacePath: "C:/workspace/main",
      auxiliaryProviderId: "codex",
    }),
    {
      providerId: "codex",
      workspacePath: "C:/workspace/main",
    },
  );
});

/** Auxiliary がない通常のセッションでは、親のプロバイダーとワークスペースだけで候補検索の要求を組み立てる。 */
test("Skill候補は Auxiliary がない場合も親Sessionのproviderとworkspaceを使う", () => {
  assert.deepEqual(
    resolveSkillDiscoveryRequest({
      parentProviderId: "copilot",
      parentWorkspacePath: "C:/workspace/main",
    }),
    {
      providerId: "copilot",
      workspacePath: "C:/workspace/main",
    },
  );
});

/** プロバイダーが分かっていても、親ワークスペースのない要求は検索先として扱わない。 */
test("Skill候補は親workspaceを特定できない場合に取得しない", () => {
  assert.equal(
    resolveSkillDiscoveryRequest({
      parentProviderId: "codex",
      auxiliaryProviderId: "codex",
    }),
    null,
  );
});
