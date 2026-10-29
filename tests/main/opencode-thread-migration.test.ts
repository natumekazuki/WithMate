import assert from "node:assert/strict";
import { it } from "node:test";
import type { OpenCodeClient, SessionInfo, SessionTransferData } from "@opencode/client";
import { migrateOpenCodeThread } from "../../src-electron/providers/opencode/opencode-thread-migration.js";

const runtimeOwner = { kind: "main" as const, id: "owner", incarnationId: "incarnation" };
const workspacePath = process.cwd();

function session(id: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project", location: { directory: workspacePath },
    metadata: { withmateOwner: { schema: 1, ...runtimeOwner } }, permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } };
}

function fixture() {
  const sourceData = new Map<string, SessionTransferData>(["root", "child", "archived", "grandchild"].map((id) => [id, {
    info: { ...session(id, id === "root" ? undefined : id === "grandchild" ? "child" : "root"),
      time: { created: 1, updated: 2, ...(id === "archived" ? { archived: 3 } : {}) } },
    messages: [{ id: `message-${id}`, type: "user", text: `history-${id}`, time: { created: 1 } }],
  }]));
  const targetData = new Map<string, SessionTransferData>();
  const imports: string[] = [];
  const exports: string[] = [];
  const pages: Array<{ parentID?: string | null; cursor?: string; archived?: boolean }> = [];
  let failImport = "";
  let pending = "";
  let active = "";
  let repeatedCursor = false;
  const source = { session: {
    get: async ({ sessionID }: { sessionID: string }) => sourceData.get(sessionID)!.info,
    inbox: { list: async ({ sessionID }: { sessionID: string }) => sessionID === pending ? [{ type: "synthetic" }] : [] },
    active: async () => active ? { [active]: {} } : {},
    list: async (query: { parentID?: string | null; cursor?: string; archived?: boolean }) => {
      pages.push(query);
      const ids = query.parentID === "root" ? (query.cursor ? ["archived"] : ["child"]) : query.parentID === "child" ? ["grandchild"] : [];
      return { data: ids.map((id) => sourceData.get(id)!.info), cursor: { next: query.parentID === "root" && (!query.cursor || repeatedCursor) ? "page-2" : undefined } };
    },
    export: async ({ sessionID, sanitize }: { sessionID: string; sanitize?: boolean }) => {
      assert.equal(sanitize, undefined);
      exports.push(sessionID);
      return structuredClone(sourceData.get(sessionID)!);
    },
  } } as unknown as OpenCodeClient;
  const target = { session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      if (!targetData.has(sessionID)) throw { _tag: "SessionNotFoundError", sessionID, message: "missing" };
      return targetData.get(sessionID)!.info;
    },
    import: async (data: SessionTransferData & { location: { directory: string } }) => {
      if (data.info.id === failImport) throw new Error("interrupted import");
      assert.ok(!data.info.parentID || targetData.has(data.info.parentID));
      assert.equal(data.location.directory, workspacePath);
      imports.push(data.info.id);
      targetData.set(data.info.id, structuredClone({ info: data.info, messages: data.messages }));
      return data.info;
    },
  } } as unknown as OpenCodeClient;
  return { sourceData, targetData, imports, exports, pages, run: (signal?: AbortSignal) => migrateOpenCodeThread({ source, target, rootID: "root", workspacePath, runtimeOwner, signal }),
    fail: (id: string) => { failImport = id; }, pending: (id: string) => { pending = id; }, active: (id: string) => { active = id; },
    repeatCursor: () => { repeatedCursor = true; } };
}

// @test-value v2
// kind = "contract"
// claim = "公開済みOpenCode thread familyを親順に移しID・owner・permissions・本文とarchived子を維持する"
// oracle = { type = "contract", ref = "docs/releases/README.md" }
// fault = "rootだけ移す、paginationを途中で止める、sanitizeで会話を消す、または子を親より先にimportする"
// observable = "移行先familyの保存内容、import順、一覧query、source保存内容"
// observation_boundary = "public-boundary"
// scope = "OpenCode native thread transfer"
// lifecycle = "permanent"
// impact = "公開済み会話の継続contextや子会話を失う"
// distinction = "型検査では検出できない複数Sessionとpaginationの移行をin-memory client境界で低コストに検査する"
// @end-test-value
it("migrates the complete paginated family without changing source data", async () => {
  const scenario = fixture();
  const original = structuredClone(scenario.sourceData);
  assert.equal((await scenario.run()).id, "root");
  assert.deepEqual(scenario.imports, ["root", "child", "archived", "grandchild"]);
  assert.deepEqual(scenario.targetData, original);
  assert.deepEqual(scenario.sourceData, original);
  assert.ok(scenario.pages.some((page) => page.parentID === "root" && page.cursor === "page-2"));
  assert.ok(scenario.pages.every((page) => page.archived === undefined));
});

// @test-value v2
// kind = "invariant"
// claim = "途中import失敗後の再試行は既存の同owner familyを再利用し残りだけを移す"
// oracle = { type = "contract", ref = "docs/releases/README.md" }
// fault = "部分移行の既存ID衝突で再試行不能になるか移行済み会話を上書きする"
// observable = "失敗後と再試行後の移行先内容とimport呼出し"
// observation_boundary = "public-boundary"
// scope = "OpenCode transfer recovery"
// lifecycle = "permanent"
// @end-test-value
it("resumes after a partial import without importing existing identities twice", async () => {
  const scenario = fixture();
  scenario.fail("archived");
  await assert.rejects(scenario.run(), /interrupted import/);
  assert.deepEqual(scenario.imports, ["root", "child"]);
  scenario.fail("");
  await scenario.run();
  await scenario.run();
  assert.deepEqual(scenario.imports, ["root", "child", "archived", "grandchild"]);
  assert.deepEqual(scenario.targetData, scenario.sourceData);
});

// @test-value v2
// kind = "invariant"
// claim = "sourceと既存targetのID・owner schema/incarnation・親・workspace不一致は移行継続として受け入れない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "同IDの別Sessionや異なる所有境界へ会話を接続する"
// observable = "移行APIの拒否と衝突targetの不変性"
// observation_boundary = "public-boundary"
// scope = "OpenCode transfer ownership"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
it("rejects foreign source and target identities", async () => {
  const mutations: Array<(info: SessionInfo) => void> = [
    (info) => { info.id = "wrong"; },
    (info) => { info.metadata = { withmateOwner: { schema: 2, ...runtimeOwner } }; },
    (info) => { info.metadata = { withmateOwner: { schema: 1, ...runtimeOwner, incarnationId: "other" } }; },
    (info) => { info.parentID = "other"; },
    (info) => { info.location.directory = `${workspacePath}/other`; },
  ];
  for (const mutate of mutations) {
    const source = fixture();
    mutate(source.sourceData.get("root")!.info);
    await assert.rejects(source.run(), /does not match/);
    assert.equal(source.imports.length, 0);
    const target = fixture();
    target.targetData.set("child", structuredClone(target.sourceData.get("child")!));
    mutate(target.targetData.get("child")!.info);
    const before = structuredClone(target.targetData.get("child"));
    await assert.rejects(target.run(), /does not match/);
    assert.deepEqual(target.targetData.get("child"), before);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "移行で保持できない子inboxや実行中family、循環pagination、取消を成功扱いせず転送前に拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "未確定会話を落とした移行を完了するか不正な一覧を無限走査する"
// observable = "API拒否とtarget import件数"
// observation_boundary = "public-boundary"
// scope = "OpenCode transfer admission"
// lifecycle = "permanent"
// @end-test-value
it("rejects pending children, active threads, malformed traversal and cancellation before importing", async () => {
  const pending = fixture();
  pending.pending("child");
  await assert.rejects(pending.run(), /empty source inbox/);
  assert.equal(pending.imports.length, 0);
  const active = fixture();
  active.active("grandchild");
  await assert.rejects(active.run(), /still active/);
  assert.equal(active.imports.length, 0);
  const cursor = fixture();
  cursor.repeatCursor();
  await assert.rejects(cursor.run(), /cursor did not advance/);
  assert.equal(cursor.imports.length, 0);
  const canceled = fixture();
  await assert.rejects(canceled.run(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(canceled.imports.length, 0);
});
