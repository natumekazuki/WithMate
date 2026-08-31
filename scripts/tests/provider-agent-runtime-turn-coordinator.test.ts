import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/provider-agent-runtime-turn-coordinator.js";

describe("ProviderAgentRuntimeTurnCoordinator", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "turn capabilityはactor Sessionとproviderのactive leaseにだけ一致し、欠落または別scopeでは認可されない"
  // oracle = { type = "adr", ref = "ADR-021 provider agent runtime turn capability" }
  // failure_mode = "別actor、別provider、またはcapability欠落requestがprovider turnの副作用へ到達する"
  // scope = "provider-agent-runtime-turn-coordinator"
  // lifecycle = "permanent"
  // @end-test-value
  it("actor/providerごとにcurrent capabilityだけをadmitする", () => {
    const coordinator = new ProviderAgentRuntimeTurnCoordinator();
    const handle = coordinator.begin({ actorSessionId: "session-a", providerId: "codex" });

    assert.equal(coordinator.admit({
      actorSessionId: "session-a",
      providerId: "codex",
      turnCapability: handle.capability,
    }).ok, true);
    assert.deepEqual(coordinator.admit({
      actorSessionId: "session-b",
      providerId: "codex",
      turnCapability: handle.capability,
    }), { ok: false, reason: "inactive" });
    assert.deepEqual(coordinator.admit({
      actorSessionId: "session-a",
      providerId: "copilot",
      turnCapability: handle.capability,
    }), { ok: false, reason: "inactive" });
    assert.deepEqual(coordinator.admit({
      actorSessionId: "session-a",
      providerId: "codex",
      turnCapability: undefined,
    }), { ok: false, reason: "inactive" });
    assert.throws(
      () => coordinator.begin({ actorSessionId: "session-a", providerId: "codex" }),
      /already active/,
    );
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "turn終了後のcapabilityとstale handleは後続turnのactive leaseを認可または失効できない"
  // oracle = { type = "adr", ref = "ADR-021 provider agent runtime turn capability" }
  // failure_mode = "前turnの遅延requestまたはstale cleanupが次turnの副作用へ誤帰属する"
  // scope = "provider-agent-runtime-turn-coordinator"
  // lifecycle = "permanent"
  // distinction = "current leaseのscope分離ではなく、endと次turn beginをまたぐstale capability/handleを扱う"
  // @end-test-value
  it("endと次turnの間でstale capabilityとhandleを分離する", () => {
    const coordinator = new ProviderAgentRuntimeTurnCoordinator();
    const first = coordinator.begin({ actorSessionId: "session-a", providerId: "codex" });
    coordinator.end(first);
    const next = coordinator.begin({ actorSessionId: "session-a", providerId: "codex" });

    assert.deepEqual(coordinator.admit({
      actorSessionId: "session-a",
      providerId: "codex",
      turnCapability: first.capability,
    }), { ok: false, reason: "inactive" });
    coordinator.end(first);
    const admission = coordinator.admit({
      actorSessionId: "session-a",
      providerId: "codex",
      turnCapability: next.capability,
    });
    assert.equal(admission.ok, true);
    if (admission.ok) {
      assert.equal(admission.handle, next);
    }

    coordinator.end(next);
    assert.deepEqual(coordinator.admit({
      actorSessionId: "session-a",
      providerId: "codex",
      turnCapability: next.capability,
    }), { ok: false, reason: "inactive" });
  });
});
