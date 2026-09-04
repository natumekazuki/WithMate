import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProviderAgentRuntimeAuthoritySnapshot } from "../../src-electron/provider-agent-runtime-binding.js";

describe("buildProviderAgentRuntimeAuthoritySnapshot", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "actor Sessionのidentity・Role bindingとknown workspace projectがcanonical authorityへ投影される"
  // oracle = { type = "adr", ref = "ADR-024" }
  // failure_mode = "binding authorityがSession Roleを落とすか、caller入力や未canonicalなworkspace値を許可集合へ投影する"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // @end-test-value
  it("workspace projectをknown resolverのIDへcanonicalizeする", () => {
    const snapshot = buildProviderAgentRuntimeAuthoritySnapshot({
      sessionId: "session-a",
      sessionKind: "default",
      sessionRoleBinding: {
        sessionRole: "standalone",
        roleContractRevision: 1,
        rootSessionId: "session-a",
        parentSessionId: null,
        delegationDepth: 0,
      },
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
      sessionKind: "default",
      sessionRoleBinding: {
        sessionRole: "standalone",
        roleContractRevision: 1,
        rootSessionId: "session-a",
        parentSessionId: null,
        delegationDepth: 0,
      },
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
      sessionId: "authoring-session",
      sessionKind: "character-authoring",
      sessionRoleBinding: null,
      characterId: "character-a",
      workspacePath: "C:/missing",
      resolveCanonicalProjectId: () => null,
    }), {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: [],
      sessionKind: "character-authoring",
    });
    assert.equal(buildProviderAgentRuntimeAuthoritySnapshot({
      sessionId: "authoring-session",
      sessionKind: "character-authoring",
      sessionRoleBinding: null,
      characterId: "   ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), null);
    assert.throws(() => buildProviderAgentRuntimeAuthoritySnapshot({
      sessionId: "session-a",
      sessionKind: "default",
      sessionRoleBinding: null,
      characterId: "character-a",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), /Session Role binding tuple is invalid/);
    assert.throws(() => buildProviderAgentRuntimeAuthoritySnapshot({
      sessionId: "authoring-session",
      sessionKind: "character-authoring",
      sessionRoleBinding: {
        sessionRole: "standalone",
        roleContractRevision: 1,
        rootSessionId: "authoring-session",
        parentSessionId: null,
        delegationDepth: 0,
      },
      characterId: "character-a",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), /Character-authoring Session cannot carry/);
  });

});
