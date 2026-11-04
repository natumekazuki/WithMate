import assert from "node:assert/strict";
import { test } from "node:test";
import { createMainSessionRuntime } from "../../src-electron/app/main-session-runtime-assembly.js";
import { createAuxiliarySessionRuntime } from "../../src-electron/auxiliary/auxiliary-session-runtime-assembly.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import type { SessionRuntimeServiceDeps } from "../../src-electron/session/session-runtime-service.js";
import { AFFECT_SCHEMA_VERSION } from "../../src-shared/character-affect/affect-contract.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";

const time = "2026-11-04T00:00:00.000Z";

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの通常turnは保存済みAffectだけをpromptへ投影し、Memoryの検索と送信はAgentの必要時取得に委ねる"
// oracle = { type = "contract", ref = "docs/design/v6-memory-foundation.md; docs/design/prompt-composition.md" }
// fault = "本番assemblyが入力文でMemoryを事前検索するか、取得済みMemory preview/bodyを通常promptへ自動注入するか、Affect取得も無効にする"
// observable = "MemoryV6Service.search呼出件数、fake Providerがreal composeProviderPromptで生成するpromptのAffect targetとMemory sentinel"
// observation_boundary = "consumer"
// scope = "Main/Auxiliary production assemblies and SessionRuntimeService through real CharacterContextApplicationService, Memory/Affect Worker storage and prompt composition; conversation writes and Provider are stubs"
// lifecycle = "permanent"
// impact = "Agentが必要と判断する前に保存済み記憶がProviderへ送信されるprivacy契約違反を検出する"
// distinction = "型とprompt/helper単体ではassemblyからMemory検索が再接続されたことを検出できないため、共通fixture一つで両通常turn経路を確認する"
// risk_tags = ["privacy"]
// @end-test-value
test("両本番assemblyはMemoryを能動取得へ残しAffectだけを通常promptへ渡す", async () => {
  const f = await backgroundHistoryFixture(undefined, undefined, () => new Date(time));
  try {
    const saved = await f.memory.append(createLocalUserMemoryPrincipal(), {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "character", scope: "character", character: { type: "id", id: "character" } },
      kind: "context", title: "Recall sentinel", preview: "PRIVATE_MEMORY_PREVIEW", body: "PRIVATE_MEMORY_BODY",
      tags: [], idempotencyKey: "recall-sentinel",
    });
    assert.ok(!("error" in saved), JSON.stringify(saved));
    let searches = 0;
    const search = f.memory.search.bind(f.memory);
    f.memory.search = (...args) => { searches += 1; return search(...args); };
    for (const kind of ["main", "auxiliary"] as const) {
      const id = kind === "main" ? "main" : "aux";
      await f.memoryWorker.affectStorage.recordEvent({
        schemaVersion: AFFECT_SCHEMA_VERSION, characterId: "character", userId: "local-user", sessionId: id,
        layer: "session", targetType: "bug", targetId: `affect-${kind}`, family: "interest",
        value: { label: `saved-affect-${kind}`, valence: 0.4, arousal: 0.3 }, intensity: 0.6,
        reason: "A reproduction was found.", evidence: "Saved fixture experience.", occurredAt: time,
        idempotencyKey: `affect-${kind}`,
      }, { sessionSource: f.scope(id).history.source });
      let session: Session = { ...f.sessions.get(id)!, model: "test", reasoningEffort: "", messages: [], messageCount: 0,
        characterRuntimeSnapshot: { characterId: "character", name: "Character", description: "", iconFilePath: "",
          theme: { main: "#123456", sub: "#abcdef" }, definitionMarkdown: "Character", definitionSha256: "fixture",
          definitionByteSize: 9, snapshotAt: time } };
      let live: LiveSessionRunState | null = null;
      const prompts: string[] = [];
      const adapter: ProviderCodingAdapter = {
        composePrompt: composeProviderPrompt,
        async runSessionTurn(input) {
          prompts.push(composeProviderPrompt(input).logicalPrompt.composedText);
          return { threadId: null, assistantText: "answer", usage: null };
        },
        async getProviderQuotaTelemetry() { return null; }, async invalidateSessionThread() {}, async invalidateAllSessionThreads() {},
      };
      const keep = async (next: Session) => { session = next; return next; };
      const owner = { assertActive() {}, isActive: () => true };
      const admission = { runSessionAdmissionExclusive: async <T>(_id: string, action: () => T | Promise<T>): Promise<T> => action() };
      const catalog = { id: "codex", label: "Fixture", defaultModelId: "test", defaultReasoningEffort: "",
        models: [{ id: "test", label: "Fixture", reasoningEfforts: [""] }] };
      const resolution = { resolveRuntimeSessionForTurn: (next: Session) => next,
        resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
        resolveProviderCatalog: () => ({ provider: catalog, snapshot: { providers: [catalog] } }) };
      const failures: unknown[] = [];
      let enabled = true;
      const memory = { getAppSettings: () => normalizeAppSettings({ characterAffectContextEnabled: enabled }),
        getCharacterContextService: () => f.characterContext,
        onCharacterContextFailure: (_session: Session, error: unknown) => { failures.push(error); } };
      const turn = { createSessionTurn: (input: Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]) => ({ id: 100, ...input }), updateSessionTurn() {} };
      const liveState = { setLiveSessionRun: (_id: string, state: LiveSessionRunState | null) => { live = state; }, getLiveSessionRun: () => live,
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {} };
      const interaction = { waitForApprovalDecision: () => "approve" as const,
        waitForElicitationResponse: () => ({ action: "cancel" as const }),
        invalidateProviderSessionThread: async () => {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {} };
      const writes = { appendRunningInput: keep, appendTerminalSession: keep, checkpointRuntimeMetadata: keep, persistRunningTurnStart: keep };
      const runtime = kind === "main" ? createMainSessionRuntime({ owner, admission,
        sessions: { ...writes, getSession: () => session, clearCharacterAuthoringRuntimeState: (next) => next },
        resolution: { ...resolution, resolveProviderSession: (next) => next, resolveSessionFolderPath: () => f.directory },
        provider: { getProviderCodingAdapter: () => adapter }, memory, turn, live: liveState, interaction, notification: {}, timing: {},
      }) : createAuxiliarySessionRuntime({ owner, admission,
        auxiliary: { ...writes, getRuntimeSession: async () => session, getSession: async (key) => f.auxiliary.getAuxiliarySessionMetadata(key),
          isAuxiliarySession: async () => true }, parent: { getSession: async (key) => f.worker.stores.session.getSession(key) }, resolution,
        provider: { getProviderCodingAdapter: () => adapter, resetProviderSessionThread: async () => {},
          resolveProviderSession: (next) => next, resolveSessionFolderPath: () => f.directory,
          issueRuntimeBinding: async (next, provider) => f.bindings.issueOrReuse({ actorSessionId: next.id, providerId: provider.id, operationGrants: [] }) },
        memory, turn, live: liveState,
        interaction: { ...interaction, cancelApprovals() {}, cancelElicitations() {} }, notification() {},
      });
      const run = async () => {
        const result = await runtime.runSessionTurn(id, { executionOptions: captureSessionExecutionOptions(session), userMessage: "Recall sentinel" });
        await runtime.waitForPendingRuns();
        assert.equal(result.runState, "idle");
        assert.deepEqual(failures, []);
        assert.equal(searches, 0);
      };
      await run();
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /# Character Affect Context/);
      assert.ok(prompts[0].includes(`saved-affect-${kind}`));
      assert.ok(prompts[0].includes(`affect-${kind}`));
      assert.doesNotMatch(prompts[0], /relatedCharacterMemory|PRIVATE_MEMORY_PREVIEW|PRIVATE_MEMORY_BODY/);
      enabled = false;
      await run();
      assert.equal(prompts.length, 2);
      assert.doesNotMatch(prompts[1], /# Character Affect Context|saved-affect-|relatedCharacterMemory|PRIVATE_MEMORY_PREVIEW|PRIVATE_MEMORY_BODY/);
    }
  } finally { await f.close(); }
});
