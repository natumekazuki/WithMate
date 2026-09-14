import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";

const binding: ResolvedAgentRuntimeBinding = {
  bindingId: "binding-grant-effect",
  bindingIdHash: "binding-grant-effect-hash",
  actorSessionId: "session-actor",
  providerId: "codex",
  executionGeneration: "generation-1",
  authoritySnapshot: {},
  operationGrants: ["session.runtime.invoke"],
  createdAt: "2026-09-14T00:00:00.000Z",
  expiresAt: null,
};

const catalog: ModelCatalogSnapshot = { revision: 1, providers: [] };

function serviceWithOwnerFailure(): SessionExternalApplicationService {
  const authority = {
    authorize: () => ({ input: {}, proof: {} as MutationAuthorityProof }),
    authorizeSessionAct: () => ({ input: {}, proof: {} as MutationAuthorityProof }),
    canSessionAct: () => true,
    grantCreate: () => { throw new Error("grant owner response lost after mutation"); },
    grantRevoke: () => { throw new Error("grant owner response lost after mutation"); },
    grantGet: () => { throw new Error("grant owner response lost"); },
    grantList: () => { throw new Error("grant owner response lost"); },
  };
  return new SessionExternalApplicationService({
    authorityService: authority,
    executionService: {
      beginShutdown() {}, resumeRootQueues() {},
      async run() { throw new Error("unused"); }, async enqueue() { throw new Error("unused"); },
      get() { throw new Error("unused"); }, listPage() { return []; }, async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); }, resolveReplay() { return null; },
    },
    crudService: { async create() { throw new Error("unused"); }, async list() { throw new Error("unused"); }, async get() { throw new Error("unused"); }, async rename() { throw new Error("unused"); } },
    currentModelCatalog: () => catalog,
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    resolveTurnInitiator: async () => null,
    getTurnAuthoritySession: () => null,
  });
}

// @test-value v2
// kind = "invariant"
// claim = "public grant ownerのresponse lossはmutationをindeterminate、readをnot_appliedとして外部contractへ写像する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Mutation envelope" }
// fault = "grant.create/revokeのowner failureを未適用と誤報する、またはgrant.get/listのread failureを不確実な副作用として報告する"
// observable = "SessionExternalApplicationServiceのpublic error effectとstable code"
// observation_boundary = "public-boundary"
// scope = "grant owner response-loss effect projection"
// lifecycle = "permanent"
// distinction = "実際のexecute operationを通し、grant owner methodの例外をapplication error mappingで観測する"
// @end-test-value
test("grant owner response loss distinguishes mutation from read effects", async () => {
  const service = serviceWithOwnerFailure();
  const inputs = {
    "grant.create": {
      parentGrantId: "grant-parent", parentGrantRevision: 1, granteeSessionId: "session-child", actions: ["turn.run"],
      resourceKind: "execution", relationSelector: "direct_child", targetSessionRoles: ["executor"], effectClass: "external_side_effect",
      delegable: false, childCeiling: [], expiresAt: null, idempotencyKey: "grant-create-effect",
    },
    "grant.revoke": { grantId: "grant-1", expectedRevision: 1, idempotencyKey: "grant-revoke-effect" },
    "grant.get": { grantId: "grant-1" },
    "grant.list": { limit: 10 },
  } as const;
  for (const [operation, expectedEffect] of [["grant.create", "indeterminate"], ["grant.revoke", "indeterminate"], ["grant.get", "not_applied"], ["grant.list", "not_applied"]] as const) {
    const response = await service.execute(operation, inputs[operation], binding);
    assert.equal("error" in response, true, operation);
    if ("error" in response) {
      assert.equal(response.error.code, "RUNTIME_UNAVAILABLE", operation);
      assert.equal(response.error.effect, expectedEffect, operation);
    }
  }
});
