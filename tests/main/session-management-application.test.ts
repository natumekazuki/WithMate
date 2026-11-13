import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManagementApplication,
  SessionManagementError,
  type SessionManagementApplicationDeps,
} from "../../src-electron/session/session-management-application.js";
import type { RelatedSession } from "../../src-electron/session/session-relationship-resolver.js";
const main = (
  id: string,
  parentSessionId: string | null = null,
): RelatedSession => ({
  id,
  incarnationId: `${id}-v1`,
  kind: "main",
  role: parentSessionId ? "executor" : "overall-coordinator",
  sessionRole: parentSessionId ? "executor" : "overall-coordinator",
  rootSessionId: "parent",
  parentSessionId,
  createdBySessionId: parentSessionId,
  mainSessionId: id,
  mainIncarnationId: `${id}-v1`,
  title: id,
  description: "full description",
  runState: "idle",
  provider: "codex",
  workspacePath: "C:/workspace",
});
const reference = (entry: RelatedSession) => ({
  kind: "main" as const,
  sessionId: entry.id,
  incarnationId: entry.incarnationId,
});
function setup(entries: RelatedSession[]) {
  const calls: string[] = [];
  const deps: SessionManagementApplicationDeps = {
    listSessions: async () => entries,
    currentTurn: async () => ({
      turnId: "turn-actual",
      receipt: null,
      origin: null,
    }),
    crewFolder: async () => ({
      rootSessionId: "parent",
      path: "crew-files/parent",
    }),
    directories: async (target, change, assertCurrent) => {
      assertCurrent();
      calls.push(`directories:${target.id}:${target.mainSessionId}:${target.mainIncarnationId}:${change?.operation ?? "list"}:${change?.directoryPath ?? ""}`);
      return { workspacePath: "workspace", sessionFolderPath: "session-folder", crewFolder: { rootSessionId: "parent", path: "crew-folder" }, additionalDirectories: [] };
    },
    updateMetadata: async () => {
      calls.push("metadata");
      return {};
    },
    enqueue: async (_target, _input, actor, turnId, current) => {
      current();
      calls.push(`${actor.id}:${turnId}`);
      return { id: "receipt" };
    },
    getReceipt: async () => null,
    cancelReceipt: async () => {
      calls.push("cancel");
      return {};
    },
    steer: async () => { throw new Error("unused"); },
    stopTurn: async () => {
      calls.push("stop");
      return {};
    },
    readExecution: async () => ({ ok: true }),
    coordinate: async () => ({ items: [], total: 0, nextOffset: null }),
    createChild: async () => {
      throw new Error("unused");
    },
    catalog: async () => ({ providers: [] }),
  };
  return { application: new SessionManagementApplication(deps), deps, calls };
}

// @test-value v2
// kind = "security"
// claim = "追加Directoryの一覧・追加・解除は実actor自身と直属子だけを対象とし、Auxiliary自身は所属Mainの識別を保持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "親、兄弟、別Crew、旧incarnationを許可するか、Auxiliaryの所有Mainを誤認する"
// observable = "許可対象と拒否コード、Directory callbackに渡る正確な対象と変更"
// observation_boundary = "public-boundary"
// scope = "session-directory-authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "一般Session metadataの読取や親子送信のtestではDirectory固有の対象制限を検証しない"
// @end-test-value
test("directory operations admit self and direct children with exact identities", async () => {
  const parent = main("parent"), child = main("child", "parent"), grandchild = main("grandchild", "child"), sibling = main("sibling", "parent");
  const other = { ...main("other"), rootSessionId: "other" };
  const auxiliary: RelatedSession = { ...child, id: "aux", incarnationId: "aux-v1", kind: "auxiliary", role: "auxiliary", parentSessionId: null };
  const auxReference = { kind: "auxiliary" as const, sessionId: auxiliary.id, incarnationId: auxiliary.incarnationId, mainSessionId: child.id, mainIncarnationId: child.incarnationId };
  const { application, calls } = setup([parent, child, grandchild, sibling, other, auxiliary]);
  const context = { actor: reference(child), assertCurrent() {} };
  for (const operation of ["list_directories", "add_directory", "remove_directory"] as const) {
    const path = operation === "list_directories" ? {} : { directoryPath: "C:/shared" };
    for (const allowed of [child, grandchild]) {
      assert.equal((await application.execute(operation, { target: reference(allowed), ...path }, context)).ok, true);
    }
    for (const denied of [parent, sibling, other]) {
      await assert.rejects(application.execute(operation, { target: reference(denied), ...path }, context),
        (error) => error instanceof SessionManagementError && error.code === "SESSION_FORBIDDEN");
    }
    await assert.rejects(application.execute(operation, { target: { ...reference(child), incarnationId: "old" }, ...path }, context),
      (error) => error instanceof SessionManagementError && error.code === "SESSION_REPLACED");
    assert.equal((await application.execute(operation, { target: auxReference, ...path }, { actor: auxReference, assertCurrent() {} })).ok, true);
    await assert.rejects(application.execute(operation, { target: reference(child), ...path }, { actor: auxReference, assertCurrent() {} }),
      (error) => error instanceof SessionManagementError && error.code === "SESSION_FORBIDDEN");
  }
  assert.deepEqual(calls, [
    "directories:child:child:child-v1:list:", "directories:grandchild:grandchild:grandchild-v1:list:", "directories:aux:child:child-v1:list:",
    "directories:child:child:child-v1:add:C:/shared", "directories:grandchild:grandchild:grandchild-v1:add:C:/shared", "directories:aux:child:child-v1:add:C:/shared",
    "directories:child:child:child-v1:remove:C:/shared", "directories:grandchild:grandchild:grandchild-v1:remove:C:/shared", "directories:aux:child:child-v1:remove:C:/shared",
  ]);
});
// @test-value v2
// kind = "invariant"
// claim = "通常送信は実親子の双方向だけを受理し兄弟宛と自己宛を拒否する"
// oracle = { type = "contract", ref = "GitHub #835 通常送信と取消・Turn停止の公開契約" }
// fault = "関連一覧にある任意Sessionへ送信を許可する"
// observable = "application送信結果と拒否時のenqueue未実行"
// observation_boundary = "public-boundary"
// scope = "session-management-application"
// lifecycle = "permanent"
// @end-test-value
test("direct parent-child sending uses the actual actor and Turn", async () => {
  const parent = main("parent"),
    child = main("child", "parent"),
    sibling = main("sibling", "parent");
  const { application, calls } = setup([parent, child, sibling]);
  const context = { actor: reference(child), assertCurrent() {} };
  assert.equal(
    (
      await application.execute(
        "enqueue",
        { target: reference(parent), requestId: "11111111-1111-4111-8111-111111111111", message: "report", approvalMode: "on-request", codexSandboxMode: "workspace-write" },
        context,
      )
    ).ok,
    true,
  );
  assert.deepEqual(calls, ["child:turn-actual"]);
  assert.equal(
    (
      await application.execute(
        "enqueue",
        { target: reference(child), requestId: "22222222-2222-4222-8222-222222222222", message: "request", model: "model", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "workspace-write" },
        { actor: reference(parent), assertCurrent() {} },
      )
    ).ok,
    true,
  );
  assert.deepEqual(calls, ["child:turn-actual", "parent:turn-actual"]);
  for (const target of [child, sibling])
    await assert.rejects(
      application.execute(
        "enqueue",
        { target: reference(target), requestId: "33333333-3333-4333-8333-333333333333", message: "request", approvalMode: "on-request" },
        context,
      ),
      (error) =>
        error instanceof SessionManagementError &&
        error.code === "SESSION_FORBIDDEN",
    );
  assert.equal(calls.length, 2);
});
// @test-value v2
// kind = "invariant"
// claim = "request keyの回復は保存済み送信元と対象の一致を必要とし全Crew読取から回復権限を導かない"
// oracle = { type = "contract", ref = "GitHub #835 request key照会" }
// fault = "別送信者のrequest keyからreceiptを返す"
// observable = "get_receiptのSESSION_FORBIDDENと本人への返却"
// observation_boundary = "public-boundary"
// scope = "session-management-application"
// lifecycle = "permanent"
// @end-test-value
test("request-key recovery verifies immutable saved actor and target", async () => {
  const parent = main("parent"),
    child = main("child", "parent");
  const { application, deps } = setup([parent, child]);
  deps.getReceipt = async () => ({
    accepted: {
      origin: {
        kind: "session",
        actorKind: "main",
        actorSessionId: parent.id,
        actorIncarnationId: parent.incarnationId,
        targetSessionId: child.id,
        targetIncarnationId: child.incarnationId,
        operation: "send",
      },
    },
  });
  const input = { target: reference(child), requestId: "11111111-1111-4111-8111-111111111111" };
  assert.equal(
    (
      await application.execute("get_receipt", input, {
        actor: reference(parent),
        assertCurrent() {},
      })
    ).ok,
    true,
  );
  await assert.rejects(
    application.execute("get_receipt", input, {
      actor: reference(child),
      assertCurrent() {},
    }),
    (error) =>
      error instanceof SessionManagementError &&
      error.code === "SESSION_FORBIDDEN",
  );
});
// @test-value v2
// kind = "invariant"
// claim = "Mainと同名IDのAuxiliary bindingをMainの送信actorへ読み替えない"
// oracle = { type = "contract", ref = "GitHub #835 actual Main/Auxiliary identity" }
// fault = "IDだけでactorを探索してAuxiliaryをMainとして認可する"
// observable = "Auxiliaryの送信拒否とMain子からの送信成功"
// observation_boundary = "public-boundary"
// scope = "session-management-application"
// lifecycle = "permanent"
// @end-test-value
test("saved kind disambiguates colliding Main and Auxiliary IDs", async () => {
  const parent = main("parent"),
    child = main("child", "parent");
  const auxiliary: RelatedSession = {
    ...child,
    kind: "auxiliary",
    role: "auxiliary",
    incarnationId: "aux-v1",
    parentSessionId: null,
    mainSessionId: parent.id,
    mainIncarnationId: parent.incarnationId,
  };
  const { application, calls } = setup([parent, child, auxiliary]);
  const input = { target: reference(parent), requestId: "11111111-1111-4111-8111-111111111111", message: "hello", approvalMode: "on-request" };
  await assert.rejects(
    application.execute("enqueue", input, {
      actor: {
        kind: "auxiliary",
        sessionId: auxiliary.id,
        incarnationId: auxiliary.incarnationId,
        mainSessionId: parent.id,
        mainIncarnationId: parent.incarnationId,
      },
      assertCurrent() {},
    }),
    (error) =>
      error instanceof SessionManagementError &&
      error.code === "SESSION_FORBIDDEN",
  );
  assert.equal(
    (
      await application.execute("enqueue", input, {
        actor: reference(child),
        assertCurrent() {},
      })
    ).ok,
    true,
  );
  assert.equal(calls.length, 1);
});
// @test-value v2
// kind = "security"
// claim = "取消と停止は実直属親から子だけを許可し子が送信者でも親の制御権限を与えない"
// oracle = { type = "contract", ref = "GitHub #835 未dispatch取消と実行中Turn停止の親限定契約" }
// fault = "双方向送信の許可やreceipt送信実績を親Turn停止の許可へ拡大する"
// observable = "取消と停止の成功方向、逆方向のSESSION_FORBIDDEN、実callback回数"
// observation_boundary = "public-boundary"
// scope = "session-management-application"
// lifecycle = "permanent"
// @end-test-value
test("only the saved direct parent controls child receipts and Turns", async () => {
  const parent = main("parent"),
    child = main("child", "parent");
  const { application, calls } = setup([parent, child]);
  for (const operation of ["cancel_receipt", "stop_turn"] as const) {
    const key =
      operation === "cancel_receipt"
        ? { receiptId: "exact-receipt" }
        : { turnId: "exact-turn" };
    assert.equal(
      (
        await application.execute(
          operation,
          { target: reference(child), ...key },
          { actor: reference(parent), assertCurrent() {} },
        )
      ).ok,
      true,
    );
    await assert.rejects(
      application.execute(
        operation,
        { target: reference(parent), ...key },
        { actor: reference(child), assertCurrent() {} },
      ),
      (error) =>
        error instanceof SessionManagementError &&
        error.code === "SESSION_FORBIDDEN",
    );
  }
  assert.deepEqual(calls, ["cancel", "stop"]);
});
// @test-value v2
// kind = "contract"
// claim = "全Crewの公開保存readと明示対象CrewFolder参照は送信の親子権限に制限されない"
// oracle = { type = "contract", ref = "GitHub #835 全Crewの読取と現在実行の参照 / #928 Crew共有保存場所" }
// fault = "別Crewという理由で保存readを拒否するか対象FolderをactorのFolderへ付け替える"
// observable = "全Crew一覧の対象metadata、別Crew getのFolder、execution read宛先"
// observation_boundary = "public-boundary"
// scope = "session-management-application"
// lifecycle = "permanent"
// @end-test-value
test("explicit cross-Crew reads preserve the saved target and public Folder reference", async () => {
  const actor = main("parent");
  const other = { ...main("other"), rootSessionId: "other" };
  const { application, deps } = setup([actor, other]);
  deps.crewFolder = async (target) => ({
    rootSessionId: target.rootSessionId,
    path: `crew-files/${target.rootSessionId}`,
  });
  deps.readExecution = async (target) => ({
    ok: true,
    actualTarget: target.id,
  });
  const context = { actor: reference(actor), assertCurrent() {} };
  const listing = await application.execute(
    "list",
    { allCrews: true },
    context,
  );
  assert.deepEqual(
    (listing.entries as RelatedSession[]).map((entry) => entry.id),
    ["parent", "other"],
  );
  const detail = await application.execute(
    "get",
    { target: reference(other) },
    context,
  );
  assert.deepEqual(detail.crewFolder, {
    rootSessionId: "other",
    path: "crew-files/other",
  });
  const execution = await application.execute(
    "get_execution",
    { target: reference(other), turnId: "1" },
    context,
  );
  assert.equal(execution.actualTarget, "other");
});
