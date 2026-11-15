import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendCrewFilesDirectory, resolveCrewFilesDirectory, resolveSessionFilesDirectory } from "../../src-electron/files/session-files.js";
import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";

// @test-value v2
// kind = "contract"
// claim = "同じ保存済みCrew起点を使う別MainはProvider rootとFilesで同じ共有fileを読み、各SessionFolderを保持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md#crew-folder" }
// fault = "Main IDごとに共有folderを分離する、FilesとProviderへ別pathを返す、または再準備で共有内容を消す"
// observable = "Provider許可root、Files rootのpath、file descriptorと共有fileの内容"
// observation_boundary = "public-boundary"
// scope = "Crew managed directoryとFiles rootの共有"
// lifecycle = "permanent"
// impact = "異なるWorkspace間の資料引継ぎが成立しなくなる"
// distinction = "型検査や単独SessionFolder testでは複数Mainと実filesystemの同一共有先を確認できない"
// @end-test-value
test("CrewのProviderとFilesは同一の共有先を使い継続する", async () => {
  const temporaryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-crew-files-"));
  try {
    const crewPath = resolveCrewFilesDirectory(temporaryPath, "root");
    const first = appendCrewFilesDirectory(temporaryPath, { allowedAdditionalDirectories: [] }, "root");
    await writeFile(path.join(crewPath, "handoff.txt"), "shared result");
    const second = appendCrewFilesDirectory(temporaryPath, { allowedAdditionalDirectories: [] }, "root");
    assert.deepEqual(first.allowedAdditionalDirectories, [crewPath]);
    assert.deepEqual(second.allowedAdditionalDirectories, [crewPath]);
    assert.equal(appendCrewFilesDirectory(temporaryPath, second, "root"), second);
    const explorer = new SessionFileExplorerService({
      userDataPath: temporaryPath,
      getSessionContext: async (id) => ({ workspacePath: path.join(temporaryPath, id), parentSessionId: id,
        crewRootSessionId: "root", allowedAdditionalDirectories: second.allowedAdditionalDirectories }),
    });
    for (const id of ["root", "worker"]) {
      const roots = await explorer.listRoots(id);
      assert.equal(roots.find((root) => root.kind === "crew-folder")?.displayPath, crewPath);
      assert.equal(roots.find((root) => root.kind === "session-folder")?.displayPath, resolveSessionFilesDirectory(temporaryPath, id));
      assert.equal(roots.filter((root) => root.displayPath === crewPath).length, 1);
      const descriptor = await explorer.inspectFile({ sessionId: id, rootId: "crew-folder", relativePath: "handoff.txt" });
      assert.equal(await readFile(descriptor.absoluteFilePath, "utf8"), "shared result");
      assert.equal(await explorer.resolvePathActionTarget({ sessionId: id, rootId: "crew-folder", relativePath: "handoff.txt", nodeKind: "file" }), path.join(crewPath, "handoff.txt"));
    }
    assert.notEqual(resolveCrewFilesDirectory(temporaryPath, "other"), crewPath);
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});
