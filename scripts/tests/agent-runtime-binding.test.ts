import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
  buildProviderAgentRuntimeBindingCacheKey,
  buildProviderAgentRuntimeBindingEnv,
  createProviderAgentRuntimeBindingRedactor,
  getProviderAgentRuntimeBindingCapability,
  mergeDefinedProviderEnv,
} from "../../src-electron/provider-agent-runtime-binding.js";

describe("AgentRuntimeBindingRegistry", () => {
  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 19 preserves its observable contract"
  // oracle = { type = "contract", ref = "-19" }
  // failure_mode = "line 19 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("same generationはopaque referenceを再利用し、operation grantを検証する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { revision: "role-v1" },
      operationGrants: ["character.context.get"],
    });
    const retry = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { revision: "role-v1" },
      operationGrants: ["character.context.get"],
    });

    assert.equal(retry.bindingId, first.bindingId);
    assert.equal(retry.bindingReference, first.bindingReference);
    assert.equal(retry.executionGeneration, first.executionGeneration);
    assert.equal(
      registry.getExecutionGeneration("session-a", "codex"),
      first.executionGeneration,
    );
    assert.equal(registry.resolve(first.bindingReference, "character.context.get").ok, true);
    assert.deepEqual(registry.resolve(first.bindingReference, "memory.write"), {
      ok: false,
      code: "SESSION_BINDING_FORBIDDEN",
    });
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 48 preserves its observable contract"
  // oracle = { type = "contract", ref = "-48" }
  // failure_mode = "line 48 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("provider execution再生成、Session削除、app終了でstale referenceを失効する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
    });
    registry.revokeProviderExecution("session-a", "codex");
    const next = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
    });
    assert.notEqual(next.executionGeneration, first.executionGeneration);
    assert.deepEqual(registry.resolve(first.bindingReference, "character.context.get"), {
      ok: false,
      code: "SESSION_BINDING_INVALID",
    });

    registry.revokeSession("session-a");
    assert.equal(registry.getExecutionGeneration("session-a", "codex"), null);
    assert.equal(registry.resolve(next.bindingReference, "character.context.get").ok, false);
    const other = registry.issueOrReuse({
      actorSessionId: "session-b",
      providerId: "codex",
      operationGrants: ["character.context.get"],
    });
    registry.revokeAll();
    assert.equal(registry.resolve(other.bindingReference, "character.context.get").ok, false);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 79 preserves its observable contract"
  // oracle = { type = "contract", ref = "-79" }
  // failure_mode = "line 79 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("authority snapshotまたはgrantが変わると旧generationを再利用しない", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { hierarchy: { parentSessionId: "parent-a" }, revision: "role-v1" },
      operationGrants: ["character.context.get"],
    });
    const reorderedSame = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { revision: "role-v1", hierarchy: { parentSessionId: "parent-a" } },
      operationGrants: ["character.context.get"],
    });
    assert.equal(reorderedSame.executionGeneration, first.executionGeneration);

    const changed = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { revision: "role-v2", hierarchy: { parentSessionId: "parent-a" } },
      operationGrants: ["character.context.get"],
    });
    assert.notEqual(changed.executionGeneration, first.executionGeneration);
    assert.equal(registry.resolve(first.bindingReference, "character.context.get").ok, false);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 105 preserves its observable contract"
  // oracle = { type = "contract", ref = "-105" }
  // failure_mode = "line 105 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("期限切れ、unknown、bindingなしをservice dispatch前に区別する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
      now: new Date("2026-08-15T00:00:00.000Z"),
      expiresAt: "2026-08-15T00:01:00.000Z",
    });
    assert.equal(registry.resolve(undefined, "character.context.get").code, "SESSION_BINDING_REQUIRED");
    assert.equal(registry.resolve("unknown", "character.context.get").code, "SESSION_BINDING_INVALID");
    assert.equal(
      registry.resolve(binding.bindingReference, "character.context.get", new Date("2026-08-15T00:01:00.000Z")).code,
      "SESSION_BINDING_INVALID",
    );
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 122 preserves its observable contract"
  // oracle = { type = "contract", ref = "-122" }
  // failure_mode = "line 122 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("期限を正規化してreuse identityへ含める", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
      now: new Date("2026-08-15T00:00:00.000Z"),
      expiresAt: "2026-08-15T01:00:00+00:00",
    });
    const sameInstant = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
      now: new Date("2026-08-15T00:00:30.000Z"),
      expiresAt: "2026-08-15T01:00:00.000Z",
    });
    assert.equal(sameInstant.bindingId, first.bindingId);
    assert.equal(sameInstant.expiresAt, "2026-08-15T01:00:00.000Z");

    const shortened = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
      now: new Date("2026-08-15T00:01:00.000Z"),
      expiresAt: "2026-08-15T00:02:00.000Z",
    });
    assert.notEqual(shortened.bindingId, first.bindingId);
    assert.equal(registry.resolve(first.bindingReference, "character.context.get").ok, false);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 152 preserves its observable contract"
  // oracle = { type = "contract", ref = "-152" }
  // failure_mode = "line 152 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("不正な期限は未対応providerでも発行前に拒否する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    assert.throws(() => registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "unknown",
      operationGrants: ["character.context.get"],
      expiresAt: "not-a-date",
    }), /expiresAt must be a valid date-time/);
    assert.equal(registry.getActiveBindingCount(), 0);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 163 preserves its observable contract"
  // oracle = { type = "contract", ref = "-163" }
  // failure_mode = "line 163 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("未対応providerへauthorityを発行しない", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const projection = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "unknown",
      operationGrants: ["character.context.get"],
    });
    assert.equal(projection.transport, "unsupported");
    assert.equal(projection.bindingReference, "");
    assert.equal(registry.getActiveBindingCount(), 0);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 175 preserves its observable contract"
  // oracle = { type = "contract", ref = "-175" }
  // failure_mode = "line 175 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("binding state transitionをgeneration tupleだけで通知し、reuseでは通知しない", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const changes: Array<{
      actorSessionId: string;
      providerId: string;
      previousExecutionGeneration: string | null;
      executionGeneration: string | null;
    }> = [];
    const unsubscribe = registry.subscribeChanges((change) => {
      changes.push(change);
    });
    registry.subscribeChanges(() => {
      throw new Error("projection listener failed");
    });

    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { workspace: "first" },
      operationGrants: ["glossary.read"],
    });
    const reused = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { workspace: "first" },
      operationGrants: ["glossary.read"],
    });
    const replacement = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: { workspace: "second" },
      operationGrants: ["glossary.read"],
    });
    registry.revokeSession("session-a");
    unsubscribe();

    assert.equal(reused.executionGeneration, first.executionGeneration);
    assert.deepEqual(changes, [
      {
        actorSessionId: "session-a",
        providerId: "codex",
        previousExecutionGeneration: null,
        executionGeneration: first.executionGeneration,
      },
      {
        actorSessionId: "session-a",
        providerId: "codex",
        previousExecutionGeneration: first.executionGeneration,
        executionGeneration: replacement.executionGeneration,
      },
      {
        actorSessionId: "session-a",
        providerId: "codex",
        previousExecutionGeneration: replacement.executionGeneration,
        executionGeneration: null,
      },
    ]);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 234 preserves its observable contract"
  // oracle = { type = "contract", ref = "-234" }
  // failure_mode = "line 234 violates its expected output or boundary behavior"
  // scope = "agent-runtime-binding.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("観測されたexpiryをgenerationからnullへの変更として通知する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const changes: Array<{ previousExecutionGeneration: string | null; executionGeneration: string | null }> = [];
    registry.subscribeChanges((change) => {
      changes.push(change);
    });
    const binding = registry.issueOrReuse({
      actorSessionId: "session-expiry",
      providerId: "codex",
      operationGrants: ["glossary.read"],
      now: new Date("2026-08-24T00:00:00.000Z"),
      expiresAt: "2026-08-24T00:01:00.000Z",
    });

    assert.equal(
      registry.getExecutionGeneration("session-expiry", "codex", new Date("2026-08-24T00:01:00.000Z")),
      null,
    );
    assert.deepEqual(changes.map(({ previousExecutionGeneration, executionGeneration }) => ({
      previousExecutionGeneration,
      executionGeneration,
    })), [
      { previousExecutionGeneration: null, executionGeneration: binding.executionGeneration },
      { previousExecutionGeneration: binding.executionGeneration, executionGeneration: null },
    ]);
  });
});

// @test-value v1
// kind = "invariant"
// claim = "Memory runtime owner selector is projected only into the provider client environment and changes cache identity"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "provider client leaks selector through process.env or reuses a client across runtime generations"
// scope = "provider-agent-runtime-binding"
// lifecycle = "permanent"
// @end-test-value
it("provider envはbindingとMemory owner selectorを投影しcache keyやglobal envへsecretを混ぜない", () => {
  const registry = new AgentRuntimeBindingRegistry();
  const projection = registry.issueOrReuse({
    actorSessionId: "session-a",
    providerId: "codex",
    operationGrants: ["character.context.get"],
  });
  const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
  const beforeApplicationInstance = process.env[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV];
  const beforeGeneration = process.env[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV];
  const turnProjection = {
    ...projection,
    turnCapability: "turn-capability-current",
    memoryRuntimeOwner: {
      applicationInstanceId: "app-instance-a",
      runtimeGenerationId: "memory-generation-a",
    },
  };
  const env = mergeDefinedProviderEnv(
    {
      PATH: "bin",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: "stale",
      [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()]: "stale-app",
      [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV.toLowerCase()]: "stale-generation",
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "stale",
      [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]: "stale-turn",
      EMPTY: undefined,
    },
    buildProviderAgentRuntimeBindingEnv(turnProjection),
  );

  assert.equal(env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], projection.bindingReference);
  assert.equal(env[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-a");
  assert.equal(env[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-a");
  assert.equal(env.WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED, "1");
  assert.equal(env[WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV], turnProjection.turnCapability);
  assert.equal(env.PATH, "bin");
  assert.equal("EMPTY" in env, false);
  assert.equal(process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], before);
  assert.equal(process.env[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], beforeApplicationInstance);
  assert.equal(process.env[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], beforeGeneration);
  const cacheKey = buildProviderAgentRuntimeBindingCacheKey(turnProjection);
  assert.doesNotMatch(cacheKey, new RegExp(projection.bindingReference));
  assert.doesNotMatch(cacheKey, new RegExp(turnProjection.turnCapability));
  assert.notEqual(
    cacheKey,
    buildProviderAgentRuntimeBindingCacheKey({ ...turnProjection, turnCapability: "turn-capability-next" }),
  );
  assert.notEqual(
    cacheKey,
    buildProviderAgentRuntimeBindingCacheKey({
      ...turnProjection,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-a", runtimeGenerationId: "memory-generation-b" },
    }),
  );
  assert.equal(getProviderAgentRuntimeBindingCapability("codex").transport, "env");
  assert.equal(getProviderAgentRuntimeBindingCapability("copilot").transport, "env");
  assert.equal(getProviderAgentRuntimeBindingCapability("unknown").transport, "unsupported");
});

// @test-value v1
// kind = "regression"
// claim = "test declaration at line 330 preserves its observable contract"
// oracle = { type = "contract", ref = "-330" }
// failure_mode = "line 330 violates its expected output or boundary behavior"
// scope = "agent-runtime-binding.test"
// lifecycle = "permanent"
// @end-test-value
it("provider projection redactorは現在のreferenceとturn capabilityをnested key/valueから非破壊で除去する", () => {
  const projection = {
    bindingId: "binding-a",
    bindingReference: "opaque-reference-current",
    providerId: "codex",
    executionGeneration: "generation-a",
    transport: "env" as const,
    expiresAt: null,
    turnCapability: "turn-capability-current",
  };
  const redactor = createProviderAgentRuntimeBindingRedactor(projection);
  const input = {
    [`prefix-${projection.bindingReference}`]: [
      `before ${projection.bindingReference} after`,
      { nested: projection.bindingReference },
      projection.turnCapability,
    ],
    otherGeneration: "opaque-reference-other",
    partial: "opaque-reference",
    envName: WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  };

  const sanitized = redactor.sanitize(input);

  assert.deepEqual(sanitized, {
    [`prefix-${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`]: [
      `before ${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER} after`,
      { nested: PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER },
      PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
    ],
    otherGeneration: "opaque-reference-other",
    partial: "opaque-reference",
    envName: WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  });
  assert.equal(Object.keys(input)[0], `prefix-${projection.bindingReference}`);
  assert.equal(input[Object.keys(input)[0] as keyof typeof input]?.[0], `before ${projection.bindingReference} after`);
});

// @test-value v1
// kind = "regression"
// claim = "test declaration at line 368 preserves its observable contract"
// oracle = { type = "contract", ref = "-368" }
// failure_mode = "line 368 violates its expected output or boundary behavior"
// scope = "agent-runtime-binding.test"
// lifecycle = "permanent"
// @end-test-value
it("provider projection redactorはbindingなしとunsupported projectionで入力を維持する", () => {
  const input = { value: "opaque-reference-current" };

  assert.equal(createProviderAgentRuntimeBindingRedactor(undefined).sanitize(input), input);
  assert.equal(createProviderAgentRuntimeBindingRedactor({
    bindingId: "",
    bindingReference: "",
    providerId: "unknown",
    executionGeneration: "",
    transport: "unsupported",
    expiresAt: null,
  }).sanitize(input), input);
});
