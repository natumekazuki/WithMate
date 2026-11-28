import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../../src-electron/platform/agent-runtime/runtime-turn-admission.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "実Worker到着前に失効したturnのSession・履歴・設定・Coordination操作を拒否し、次turnの正当な操作は通す"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "Mainの受付時だけで確認を終えて取消済み要求をWorkerへ適用する、または次turnまで誤拒否する"
// observable = "各公開storage proxyの失効例外とeffect、保存設定/Directory/Coordination一覧/履歴の状態と次turn結果"
// observation_boundary = "public-boundary"
// scope = "通常storageのtyped proxy・実Worker transport・共有失効状態・実SQLite"
// lifecycle = "permanent"
// impact = "取消済みProviderの遅延保存と権限失効後の会話/相談読取を防ぎ、次turnの利用を維持する"
// distinction = "型検査やadmission単体testではstructured clone後のworker側検査と実DB副作用を確認できないため、4経路を一fixtureで確認する"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("shared storage checks captured turn admission on arrival without blocking the next turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-shared-turn-worker-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const fixtureStorage = new SessionStorageV6(dbPath);
  let saved: ReturnType<SessionStorageV6["insertSession"]>;
  try {
    saved = fixtureStorage.insertSession({
      ...buildNewSession({ id: "admission", taskTitle: "Admission", workspaceLabel: "Fixture", workspacePath: directory,
        branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
        characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: "on-request" }),
      messages: [{ role: "user", text: "saved history" }],
    });
  } finally { fixtureStorage.close(); }
  const worker = createV6StorageWorkerBundle({ dbPath, userDataPath: directory });
  try {
    const incarnationId = getSessionIncarnationId(saved);
    const owner = { sessionId: saved.id, incarnationId };
    const history = {
      scope: { source: { kind: "main" as const, ...owner, ownerIdentity: JSON.stringify(["main", saved.id, incarnationId]) }, fromMessageSeq: 0, throughMessageSeq: 0 },
      operation: "list_messages" as const, request: {},
    };
    const operations: Array<() => Promise<unknown>> = [
      () => worker.stores.session.setSessionAdditionalDirectories(saved.id, incarnationId, [directory]),
      () => worker.stores.session.readSessionHistory(history),
      () => worker.stores.settings.setWorktreeRoot(directory),
      () => worker.stores.coordination.execute({ actor: { kind: "user" }, request: { operation: "list", crewRootSessionId: saved.id, offset: 0, limit: 10 } }),
    ];
    // ready イベントが処理される前にすべての呼び出しをキューに入れ、その後に共有状態を失効させる。
    // これにより Worker との競合を避けながら、Main 側の入口検査をすでに通過したことを確認できる。
    await Promise.all(operations.map((operation) => {
      const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const pending = runWithRuntimeTurnAdmission({ state }, operation);
      Atomics.store(new Int32Array(state), 0, 1);
      return assert.rejects(pending, (error: unknown) => error instanceof RuntimeTurnInactiveError && error.effect === "none");
    }));
    await worker.initialize();
    assert.equal((await worker.stores.settings.getWorktreePolicy()).rootPath, null);
    assert.deepEqual((await worker.stores.session.getSessionSummary(saved.id))?.allowedAdditionalDirectories, []);
    const beforeCoordination = await worker.stores.coordination.execute({ actor: { kind: "user" }, request: { operation: "list", crewRootSessionId: saved.id, offset: 0, limit: 10 } });
    assert.equal((await worker.stores.session.readSessionHistory(history)).ok, true);

    const next = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    for (const operation of operations) await runWithRuntimeTurnAdmission({ state: next }, operation);
    assert.equal((await worker.stores.settings.getWorktreePolicy())?.rootPath, directory);
    assert.deepEqual((await worker.stores.session.getSessionSummary(saved.id))?.allowedAdditionalDirectories, [directory]);
    assert.equal((await worker.stores.session.readSessionHistory(history)).ok, true);
    assert.deepEqual(await worker.stores.coordination.execute({ actor: { kind: "user" }, request: { operation: "list", crewRootSessionId: saved.id, offset: 0, limit: 10 } }), beforeCoordination);
  } finally {
    await worker.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
