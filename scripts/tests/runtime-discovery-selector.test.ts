import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeDiscoveryRegistryRecord } from "../../src/runtime-discovery/runtime-discovery-registry.js";
import { selectRuntimeDiscoveryRecord } from "../../src/runtime-discovery/runtime-discovery-selector.js";

const NOW = new Date("2026-09-05T00:00:30.000Z");

function record(input: {
  applicationInstanceId: string;
  runtimeGenerationId: string;
  runtimeKind?: string;
  heartbeatAt: string;
}): RuntimeDiscoveryRegistryRecord {
  return {
    slotName: input.runtimeGenerationId,
    slotDirectoryPath: input.runtimeGenerationId,
    entry: {
      schemaVersion: "withmate-runtime-discovery-entry-v1",
      applicationInstanceId: input.applicationInstanceId,
      runtimeKind: input.runtimeKind ?? "session",
      runtimeGenerationId: input.runtimeGenerationId,
      buildChannel: "development",
      process: { pid: 1, startedAt: "2026-09-05T00:00:00.000Z" },
      publicationId: "99999999-9999-4999-8999-999999999999",
      publishedAt: "2026-09-05T00:00:00.000Z",
      lease: { heartbeatAt: input.heartbeatAt },
      adapters: [{ adapterKind: "cli", credentialFileName: "credential.json" }],
    },
  };
}

// @test-value v1
// kind = "invariant"
// claim = "shared selectorはfresh entryをchallengeせずactiveとし、expired entryはidentity challenge成功時だけactiveに含める"
// oracle = { type = "adr", ref = "ADR-023 Publish, lease, cleanup / Selection and binding" }
// failure_mode = "lease期限切れだけで生存runtimeをstale化するか、challenge失敗したexpired runtimeをactiveとして暗黙選択する"
// scope = "shared-runtime-discovery-selector"
// lifecycle = "permanent"
// @end-test-value
test("shared selectorはexpired leaseだけをchallengeしてactive集合を決める", async () => {
  const fresh = record({
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    heartbeatAt: "2026-09-05T00:00:20.000Z",
  });
  const expired = record({
    applicationInstanceId: "22222222-2222-4222-8222-222222222222",
    runtimeGenerationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    heartbeatAt: "2026-09-05T00:00:00.000Z",
  });
  const challenged: string[] = [];
  const ambiguous = await selectRuntimeDiscoveryRecord({
    records: [fresh, expired],
    selector: { runtimeKind: "session" },
    now: NOW,
    staleThresholdMs: 20_000,
    challenge: async (entry) => {
      challenged.push(entry.runtimeGenerationId);
      return true;
    },
  });
  assert.equal(ambiguous.kind, "error");
  assert.equal(ambiguous.kind === "error" ? ambiguous.code : "", "runtime_ambiguous");
  assert.deepEqual(challenged, [expired.entry.runtimeGenerationId]);

  const selected = await selectRuntimeDiscoveryRecord({
    records: [fresh, expired],
    selector: { runtimeKind: "session" },
    now: NOW,
    staleThresholdMs: 20_000,
    challenge: async () => false,
  });
  assert.equal(selected.kind, "selected");
  assert.equal(selected.kind === "selected" ? selected.record.entry.runtimeGenerationId : "", fresh.entry.runtimeGenerationId);
});

// @test-value v1
// kind = "security"
// claim = "shared selectorは指定runtimeKind以外のentryを候補にもidentity challengeにも含めない"
// oracle = { type = "adr", ref = "ADR-023 Identity and registry ownership" }
// failure_mode = "Session discoveryがMemory runtimeをchallengeまたは選択し、adapter固有credential境界を横断する"
// scope = "shared-runtime-discovery-selector"
// lifecycle = "permanent"
// distinction = "lease状態ではなくruntimeKindの分離を観測する"
// @end-test-value
test("shared selectorは別runtime kindをchallengeしない", async () => {
  const memory = record({
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeKind: "memory",
    heartbeatAt: "2026-09-05T00:00:00.000Z",
  });
  let challengeCalls = 0;
  const result = await selectRuntimeDiscoveryRecord({
    records: [memory],
    selector: { runtimeKind: "session" },
    now: NOW,
    staleThresholdMs: 20_000,
    challenge: async () => {
      challengeCalls += 1;
      return true;
    },
  });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" ? result.code : "", "runtime_unavailable");
  assert.equal(challengeCalls, 0);
});
