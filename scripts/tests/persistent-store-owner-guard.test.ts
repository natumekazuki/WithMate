import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";
import {
  assertPersistentStoreOwnerActive,
  capturePersistentStoreOwner,
} from "../../src-electron/persistent-store-owner-guard.js";

function createSession(id: string): Session {
  return buildNewSession({
    id,
    taskTitle: id,
    workspaceLabel: id,
    workspacePath: `C:\\${id}`,
    branch: "main",
    characterId: "character:test",
    character: "Test",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    provider: "codex",
    messages: undefined,
  } as never);
}

describe("persistent store owner guard", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "永続storeのowner切替後に、旧Session mutation queueの遅延応答が新storageまたは新cacheへ反映されない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
  // fault = "旧ownerのstorage応答後に新ownerのcacheへSessionを投影する"
  // observable = "旧storageのwrite数、新storageのwrite数、cacheのSession一覧、mutation promiseの拒否"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-generation-boundary"
  // lifecycle = "permanent"
  // impact = "DB reset/recreate中の遅延writeによる新generationデータ汚染と表示不整合を防ぐ"
  // distinction = "通常のSessionPersistenceService testではowner切替後の旧queueとlate acknowledgementを観測しない"
  // @end-test-value
  it("rejects late old-owner acknowledgements without projecting into the new owner", async () => {
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    let activeOwner: typeof oldOwner | typeof newOwner | null = oldOwner;
    const captured = capturePersistentStoreOwner(() => activeOwner, "Session persistence test");
    const session = createSession("session-old");
    let cachedSessions = [session];
    let oldWrites = 0;
    let newWrites = 0;
    let storageStarted!: () => void;
    const storageStartedPromise = new Promise<void>((resolve) => { storageStarted = resolve; });
    let releaseStorage!: (stored: Session) => void;
    const storageResponse = new Promise<Session>((resolve) => { releaseStorage = resolve; });

    const persistence = new SessionPersistenceService({
      getSessions: () => {
        captured.assertActive("test cache read");
        return cachedSessions;
      },
      setSessions: (nextSessions) => {
        captured.assertActive("test cache write");
        cachedSessions = nextSessions;
      },
      getSession: (sessionId) => cachedSessions.find((entry) => entry.id === sessionId) ?? null,
      isSessionRunInFlight: () => false,
      upsertStoredSession: async (nextSession) => {
        captured.assertActive("test storage write");
        if (activeOwner === oldOwner) oldWrites += 1;
        else newWrites += 1;
        storageStarted();
        const stored = await storageResponse;
        captured.assertActive("test storage acknowledgement");
        return stored;
      },
      replaceStoredSessions: () => undefined,
      listStoredSessions: () => [],
      getAppSettings: () => ({}) as never,
      getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: () => undefined,
    });

    const first = persistence.upsertSession({ ...session, messages: [{ role: "user", text: "old" }] });
    await storageStartedPromise;
    const second = persistence.upsertSession({ ...session, id: "session-queued", messages: [{ role: "user", text: "queued" }] });
    activeOwner = newOwner;
    releaseStorage({ ...session, messages: [{ role: "user", text: "late" }] });

    await assert.rejects(first, /古い永続store世代/);
    await assert.rejects(second, /古い永続store世代/);
    assert.equal(oldWrites, 1);
    assert.equal(newWrites, 0);
    assert.deepEqual(cachedSessions, [session]);
    assertPersistentStoreOwnerActive(() => activeOwner, newOwner, "new owner remains active");
  });
});
