import assert from "node:assert/strict";
import test from "node:test";
import { buildNewSession, projectSessionSummary } from "../../src-shared/session/session-state.js";
import { readSessionFileExplorerContext } from "../../src-electron/files/session-file-explorer-context.js";

function mainSummary() {
  return projectSessionSummary({
    ...buildNewSession({
      id: "main", taskTitle: "Files", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
      characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" },
      approvalMode: "untrusted", allowedAdditionalDirectories: ["C:/main-only"],
    }),
    incarnationId: "owner-1",
  });
}

// @test-value v2
// kind = "contract"
// claim = "FilesのMainとAuxiliary認可は現在の親incarnationと共通の許可rootを返し、親削除と読取失敗を成功へ変更しない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#Files認可metadata" }
// fault = "Auxiliaryの古い個別root集合や削除済み親を再利用する"
// observable = "再読込したFiles contextの親ID・incarnation・workspace・許可root、nullと例外"
// observation_boundary = "public-boundary"
// scope = "readSessionFileExplorerContextのMainとAuxiliary owner解決"
// lifecycle = "permanent"
// impact = "共有一覧で取り消したファイル権限がAuxiliaryで残ることを防ぐ"
// distinction = "既存Explorer testはcontextを直接注入し、保存metadataからの親とroot集合の選択を通らない"
// @end-test-value
test("Files contextはMainとAuxiliaryで現在の親の許可を使用する", async () => {
  let parent = mainSummary();
  let exists = true;
  const auxiliary = { parentSessionId: "main" };
  const reads = {
    assertCurrent() {},
    getAuxiliaryMetadata: async (id: string) => id === "aux" ? auxiliary : null,
    getSessionSummary: async (id: string) => exists && id === "main" ? parent : null,
  };
  assert.deepEqual(await readSessionFileExplorerContext("main", reads), {
    workspacePath: "C:/workspace", parentSessionId: "main", parentIncarnationId: "owner-1", allowedAdditionalDirectories: ["C:/main-only"],
  });
  assert.deepEqual((await readSessionFileExplorerContext("aux", reads))?.allowedAdditionalDirectories, ["C:/main-only"]);
  parent = { ...parent, incarnationId: "owner-2", workspacePath: "C:/replacement", allowedAdditionalDirectories: [] };
  assert.deepEqual(await readSessionFileExplorerContext("aux", reads), {
    workspacePath: "C:/replacement", parentSessionId: "main", parentIncarnationId: "owner-2", allowedAdditionalDirectories: [],
  });
  exists = false;
  assert.equal(await readSessionFileExplorerContext("aux", reads), null);
  await assert.rejects(readSessionFileExplorerContext("aux", {
    ...reads, getAuxiliaryMetadata: async () => { throw new Error("Invalid Character snapshot"); },
  }), /Invalid Character snapshot/);
  await assert.rejects(readSessionFileExplorerContext("main", {
    ...reads, getSessionSummary: async () => { throw new Error("Storage read failed"); },
  }), /Storage read failed/);
});

// @test-value v2
// kind = "invariant"
// claim = "Files contextのAuxiliaryまたは親metadataを待つ間のstorage generation交換は旧rootを返さず失敗する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#Files認可metadata" }
// fault = "metadataのawait後にcurrent ownerを確認せず旧generationの認可を使用する"
// observable = "各読取待機後のgeneration拒否Error"
// observation_boundary = "public-boundary"
// scope = "readSessionFileExplorerContextの非同期storage owner境界"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "DB reset後に旧generationのファイル権限が継続することを防ぐ"
// distinction = "Explorerのrealpathとfile revision検査はDB owner交換自体を観測しない"
// @end-test-value
test("Files contextはどちらのmetadata待機後もgenerationを再確認する", async () => {
  const parent = { ...mainSummary(), incarnationId: "old-owner", workspacePath: "C:/old" };
  for (const stage of ["auxiliary", "parent"] as const) {
    let active = true;
    const result = readSessionFileExplorerContext("aux", {
      assertCurrent: () => { if (!active) throw new Error("Storage generation changed"); },
      getAuxiliaryMetadata: async () => {
        if (stage === "auxiliary") active = false;
        return { parentSessionId: "main" };
      },
      getSessionSummary: async () => { active = false; return parent; },
    });
    await assert.rejects(result, /Storage generation changed/);
  }
});
