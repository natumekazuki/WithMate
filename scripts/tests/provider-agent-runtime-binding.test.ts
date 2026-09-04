import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProviderAgentRuntimeAuthoritySnapshot } from "../../src-electron/provider-agent-runtime-binding.js";

describe("buildProviderAgentRuntimeAuthoritySnapshot", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "actor Sessionのcharacterとknown workspace projectだけがcanonical authorityへ投影される"
  // oracle = { type = "adr", ref = "ADR-024" }
  // failure_mode = "binding authorityがcaller入力や未canonicalなworkspace値を許可集合へ投影する"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // @end-test-value
  it("workspace projectをknown resolverのIDへcanonicalizeする", () => {
    const snapshot = buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: " character-a ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: (workspacePath) => {
        assert.equal(workspacePath, "C:/workspace");
        return " project-z ";
      },
    });

    assert.deepEqual(snapshot, {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: ["project-z"],
    });
  });

  // @test-value v1
  // kind = "security"
  // claim = "unresolved workspaceはProject authorityを持たず、空characterはsnapshotを生成しない"
  // oracle = { type = "adr", ref = "ADR-024" }
  // failure_mode = "解決不能なworkspaceまたは空のCharacter identityへauthorityを付与してMemory targetを越権する"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // distinction = "既知workspaceのcanonical化とは異なり、fail-closedの境界を検証する"
  // @end-test-value
  it("unresolved workspaceは空、空characterはnullにする", () => {
    assert.deepEqual(buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "character-a",
      workspacePath: "C:/missing",
      resolveCanonicalProjectId: () => null,
    }), {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: [],
    });
    assert.equal(buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "   ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), null);
  });

});
