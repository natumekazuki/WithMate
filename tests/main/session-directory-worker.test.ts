import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { RuntimeTurnInactiveError, runWithRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "security"
// claim = "Directory変更はWorker待機中に呼出Turnが失効した場合、書込みを行わない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "proxyからWorkerへadmissionが伝わらず、失効済みTurnのDirectory変更をcommitする"
// observable = "失効後のWorker error、保存一覧の不変、通常呼出の保存結果と会話本文"
// observation_boundary = "public-boundary"
// scope = "session-directory-storage-worker-admission"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "Main processでの事前assertだけではWorker待機中の失効や実SQLiteの影響を検出できない"
// @end-test-value
test("directory mutations carry Turn admission to the storage Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-directory-worker-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const options = { dbPath, userDataPath: directory };
  const initial = createV6StorageWorkerBundle(options);
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    await initial.initialize();
    const saved = await initial.stores.session.insertSession({ ...buildNewSession({ id: "main", taskTitle: "Main",
      workspaceLabel: "Workspace", workspacePath: directory, branch: "main", characterId: "unknown", character: "Unknown",
      characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: "untrusted" }),
      messages: [{ role: "user", text: "keep conversation" }] });
    await initial.client.close();
    reopened = createV6StorageWorkerBundle(options);
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const incarnation = getSessionIncarnationId(saved);
    const pending = runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.setSessionAdditionalDirectories(saved.id, incarnation, ["C:/shared"]));
    Atomics.store(new Int32Array(state), 0, 1);
    await assert.rejects(pending, RuntimeTurnInactiveError);
    assert.deepEqual((await reopened.stores.session.getSession(saved.id))?.allowedAdditionalDirectories, []);
    const updated = await reopened.stores.session.setSessionAdditionalDirectories(saved.id, incarnation, ["C:/shared"]);
    assert.deepEqual(updated.allowedAdditionalDirectories, ["C:/shared"]);
    assert.equal((await reopened.stores.session.getSession(saved.id))?.messages[0]?.text, "keep conversation");
  } finally {
    await reopened?.client.close();
    await initial.client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
