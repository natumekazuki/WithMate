import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  buildProviderAgentRuntimeBindingCacheKey,
  buildProviderAgentRuntimeBindingEnv,
  createProviderAgentRuntimeBindingRedactor,
  getProviderAgentRuntimeBindingCapability,
  mergeDefinedProviderEnv,
} from "../../src-electron/provider-agent-runtime-binding.js";

describe("AgentRuntimeBindingRegistry", () => {
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

it("provider envはbindingとturn capabilityを投影しcache keyやglobal envへsecretを混ぜない", () => {
  const registry = new AgentRuntimeBindingRegistry();
  const projection = registry.issueOrReuse({
    actorSessionId: "session-a",
    providerId: "codex",
    operationGrants: ["character.context.get"],
  });
  const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
  const turnProjection = { ...projection, turnCapability: "turn-capability-current" };
  const env = mergeDefinedProviderEnv(
    {
      PATH: "bin",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: "stale",
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "stale",
      [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]: "stale-turn",
      EMPTY: undefined,
    },
    buildProviderAgentRuntimeBindingEnv(turnProjection),
  );

  assert.equal(env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], projection.bindingReference);
  assert.equal(env.WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED, "1");
  assert.equal(env[WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV], turnProjection.turnCapability);
  assert.equal(env.PATH, "bin");
  assert.equal("EMPTY" in env, false);
  assert.equal(process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], before);
  const cacheKey = buildProviderAgentRuntimeBindingCacheKey(turnProjection);
  assert.doesNotMatch(cacheKey, new RegExp(projection.bindingReference));
  assert.doesNotMatch(cacheKey, new RegExp(turnProjection.turnCapability));
  assert.notEqual(
    cacheKey,
    buildProviderAgentRuntimeBindingCacheKey({ ...turnProjection, turnCapability: "turn-capability-next" }),
  );
  assert.equal(getProviderAgentRuntimeBindingCapability("codex").transport, "env");
  assert.equal(getProviderAgentRuntimeBindingCapability("copilot").transport, "env");
  assert.equal(getProviderAgentRuntimeBindingCapability("unknown").transport, "unsupported");
});

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
