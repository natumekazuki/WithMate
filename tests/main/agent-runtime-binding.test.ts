import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
  buildProviderAgentRuntimeBindingCacheKey,
  buildProviderAgentRuntimeBindingEnv,
  createProviderAgentRuntimeBindingRedactor,
  getProviderAgentRuntimeBindingCapability,
  mergeDefinedProviderEnv,
} from "../../src-electron/providers/provider-agent-runtime-binding.js";

/** 実行世代にひもづく権限の発行・失効と、その観測結果を検証する。 */
describe("AgentRuntimeBindingRegistry", () => {
  /** 同じ発行条件では参照を保つ一方、許可対象外の操作は拒むことを確かめる。 */
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
    assert.equal(
      registry.resolve(first.bindingReference, "character.context.get").ok,
      true,
    );
    assert.deepEqual(registry.resolve(first.bindingReference, "memory.write"), {
      ok: false,
      code: "SESSION_BINDING_FORBIDDEN",
    });
  });

  /** 実行、会話、アプリ全体の各単位で失効させ、以後は以前の参照を使えないことを確かめる。 */
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
    assert.deepEqual(
      registry.resolve(first.bindingReference, "character.context.get"),
      {
        ok: false,
        code: "SESSION_BINDING_INVALID",
      },
    );

    registry.revokeSession("session-a");
    assert.equal(registry.getExecutionGeneration("session-a", "codex"), null);
    assert.equal(
      registry.resolve(next.bindingReference, "character.context.get").ok,
      false,
    );
    const other = registry.issueOrReuse({
      actorSessionId: "session-b",
      providerId: "codex",
      operationGrants: ["character.context.get"],
    });
    registry.revokeAll();
    assert.equal(
      registry.resolve(other.bindingReference, "character.context.get").ok,
      false,
    );
  });

  /** 同値な権限スナップショットはキー順に依存せず再利用し、内容の変更では世代を切り替える。 */
  it("authority snapshotまたはgrantが変わると旧generationを再利用しない", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const first = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: {
        hierarchy: { parentSessionId: "parent-a" },
        revision: "role-v1",
      },
      operationGrants: ["character.context.get"],
    });
    const reorderedSame = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: {
        revision: "role-v1",
        hierarchy: { parentSessionId: "parent-a" },
      },
      operationGrants: ["character.context.get"],
    });
    assert.equal(reorderedSame.executionGeneration, first.executionGeneration);

    const changed = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      authoritySnapshot: {
        revision: "role-v2",
        hierarchy: { parentSessionId: "parent-a" },
      },
      operationGrants: ["character.context.get"],
    });
    assert.notEqual(changed.executionGeneration, first.executionGeneration);
    assert.equal(
      registry.resolve(first.bindingReference, "character.context.get").ok,
      false,
    );
  });

  // @test-value v2
  // kind = "security"
  // claim = "runtime binding解決は期限切れ・unknown・binding不在をdispatch前に区別する"
  // oracle = { type = "contract", ref = "src-electron/providers/agent-runtime-binding.ts: resolve" }
  // fault = "無効なbindingを有効としてservice dispatchへ渡し、権限外のruntime操作を許可する"
  // observable = "resolve結果のok/codeと各失敗分類"
  // observation_boundary = "public-boundary"
  // scope = "agent-runtime-binding-resolution"
  // lifecycle = "permanent"
  // distinction = "binding発行の成功確認では検出できない解決時の失敗分類を検証する"
  // @end-test-value
  /** 期限ちょうどで失効し、未提示だけを無効な参照とは別のコードで拒むことを確かめる。 */
  it("期限切れ、unknown、bindingなしをservice dispatch前に区別する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-a",
      providerId: "codex",
      operationGrants: ["character.context.get"],
      now: new Date("2026-08-15T00:00:00.000Z"),
      expiresAt: "2026-08-15T00:01:00.000Z",
    });
    const missing = registry.resolve(undefined, "character.context.get");
    const unknown = registry.resolve("unknown", "character.context.get");
    const expired = registry.resolve(
      binding.bindingReference,
      "character.context.get",
      new Date("2026-08-15T00:01:00.000Z"),
    );
    assert.equal(missing.ok, false);
    assert.equal(unknown.ok, false);
    assert.equal(expired.ok, false);
    if (missing.ok || unknown.ok || expired.ok)
      throw new Error("expected binding resolution failure");
    assert.equal(missing.code, "SESSION_BINDING_REQUIRED");
    assert.equal(unknown.code, "SESSION_BINDING_INVALID");
    assert.equal(expired.code, "SESSION_BINDING_INVALID");
  });

  /** 表記が異なる同一時刻は同じ期限とし、期限を短くすると発行済み参照を置き換える。 */
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
    assert.equal(
      registry.resolve(first.bindingReference, "character.context.get").ok,
      false,
    );
  });

  /** 未対応分岐でも不正な日時を見逃さず、参照を一件も登録しないことを確かめる。 */
  it("不正な期限は未対応providerでも発行前に拒否する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    assert.throws(
      () =>
        registry.issueOrReuse({
          actorSessionId: "session-a",
          providerId: "unknown",
          operationGrants: ["character.context.get"],
          expiresAt: "not-a-date",
        }),
      /expiresAt must be a valid date-time/,
    );
    assert.equal(registry.getActiveBindingCount(), 0);
  });

  /** 未対応 provider には能力なしを示し、有効な実行参照を持たせない。 */
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

  /** 再利用を除く世代変化だけを通知し、購読側の例外で発行や失効を妨げないことを確かめる。 */
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

  /** 期限到達後の参照照会で有効世代が消え、その遷移が購読側にも伝わることを確かめる。 */
  it("観測されたexpiryをgenerationからnullへの変更として通知する", () => {
    const registry = new AgentRuntimeBindingRegistry();
    const changes: Array<{
      previousExecutionGeneration: string | null;
      executionGeneration: string | null;
    }> = [];
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
      registry.getExecutionGeneration(
        "session-expiry",
        "codex",
        new Date("2026-08-24T00:01:00.000Z"),
      ),
      null,
    );
    assert.deepEqual(
      changes.map(({ previousExecutionGeneration, executionGeneration }) => ({
        previousExecutionGeneration,
        executionGeneration,
      })),
      [
        {
          previousExecutionGeneration: null,
          executionGeneration: binding.executionGeneration,
        },
        {
          previousExecutionGeneration: binding.executionGeneration,
          executionGeneration: null,
        },
      ],
    );
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Runtime owner selector is projected only into the provider client environment and changes cache identity without exposing credentials in cache keys"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// fault = "provider projection mutates process.env, exposes binding credentials in cache keys, or omits runtime generation from cache identity"
// observable = "returned environment, unchanged process.env values, and cache key contents and equality across turn/runtime generations"
// observation_boundary = "component-behavior"
// scope = "provider-agent-runtime-binding"
// lifecycle = "permanent"
// @end-test-value
/** 実行先へ渡す環境だけで古い値を差し替え、キャッシュは資格情報を露出せず世代別に分ける。 */
it("provider envはbindingとruntime owner selectorを投影しcache keyやglobal envへsecretを混ぜない", () => {
  const registry = new AgentRuntimeBindingRegistry();
  const projection = registry.issueOrReuse({
    actorSessionId: "session-a",
    providerId: "codex",
    operationGrants: ["character.context.get"],
  });
  const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
  const beforeApplicationInstance =
    process.env[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV];
  const beforeGeneration =
    process.env[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV];
  const turnProjection = {
    ...projection,
    turnCapability: "turn-capability-current",
    runtimeOwner: {
      applicationInstanceId: "app-instance-a",
      runtimeGenerationId: "memory-generation-a",
    },
  };
  const env = mergeDefinedProviderEnv(
    {
      PATH: "bin",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: "stale",
      [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()]:
        "stale-app",
      [WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV.toLowerCase()]:
        "stale-generation",
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "stale",
      [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]: "stale-turn",
      EMPTY: undefined,
    },
    buildProviderAgentRuntimeBindingEnv(turnProjection),
  );

  assert.equal(
    env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
    projection.bindingReference,
  );
  assert.equal(
    env[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV],
    "app-instance-a",
  );
  assert.equal(
    env[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
    "memory-generation-a",
  );
  assert.equal(env.WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED, "1");
  assert.equal(
    env[WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV],
    turnProjection.turnCapability,
  );
  assert.equal(env.PATH, "bin");
  assert.equal("EMPTY" in env, false);
  assert.equal(
    process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
    before,
  );
  assert.equal(
    process.env[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV],
    beforeApplicationInstance,
  );
  assert.equal(
    process.env[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
    beforeGeneration,
  );
  const cacheKey = buildProviderAgentRuntimeBindingCacheKey(turnProjection);
  assert.doesNotMatch(cacheKey, new RegExp(projection.bindingReference));
  assert.doesNotMatch(cacheKey, new RegExp(turnProjection.turnCapability));
  assert.notEqual(
    cacheKey,
    buildProviderAgentRuntimeBindingCacheKey({
      ...turnProjection,
      turnCapability: "turn-capability-next",
    }),
  );
  assert.notEqual(
    cacheKey,
    buildProviderAgentRuntimeBindingCacheKey({
      ...turnProjection,
      runtimeOwner: {
        applicationInstanceId: "app-instance-a",
        runtimeGenerationId: "memory-generation-b",
      },
    }),
  );
  assert.equal(
    getProviderAgentRuntimeBindingCapability("codex").transport,
    "env",
  );
  assert.equal(
    getProviderAgentRuntimeBindingCapability("copilot").transport,
    "env",
  );
  assert.equal(
    getProviderAgentRuntimeBindingCapability("unknown").transport,
    "unsupported",
  );
});

/** 現在の資格情報だけを入れ子のキーと値から伏せ、元入力と他世代の表記を保つ。 */
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
  assert.equal(
    input[Object.keys(input)[0] as keyof typeof input]?.[0],
    `before ${projection.bindingReference} after`,
  );
});

/** 伏せる資格情報を持たない投影では、入力を複製せずそのまま返す。 */
it("provider projection redactorはbindingなしとunsupported projectionで入力を維持する", () => {
  const input = { value: "opaque-reference-current" };

  assert.equal(
    createProviderAgentRuntimeBindingRedactor(undefined).sanitize(input),
    input,
  );
  assert.equal(
    createProviderAgentRuntimeBindingRedactor({
      bindingId: "",
      bindingReference: "",
      providerId: "unknown",
      executionGeneration: "",
      transport: "unsupported",
      expiresAt: null,
    }).sanitize(input),
    input,
  );
});
