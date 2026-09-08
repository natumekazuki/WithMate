import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/session-state.js";
import {
  measureSessionFolders,
  SessionFolderResourceBudget,
} from "../../src-electron/resource-budget-files.js";
import {
  ResourceBudgetError,
  ResourceBudgetStorage,
  type ResourceBudgetReservation,
} from "../../src-electron/resource-budget-storage.js";
import {
  copyFilesToSessionFiles,
  resolveSessionFilesDirectory,
  saveSessionFile,
} from "../../src-electron/session-files.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

function reservation(): ResourceBudgetReservation {
  return {
    reservationId: "reservation-1",
    accountId: "root",
    dimension: "storageBytes",
    amount: 4,
    consumed: 0,
    state: "reserved",
    kind: "storage",
    executionId: null,
    providerGenerationId: null,
    idempotencyKey: "write-1",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

describe("SessionFolder resource budget", () => {
  // @test-value v2
  // kind = "regression"
  // claim = "予算対象外と判定済みの添付は、null予算を受ける共通のcopy/paste経路でSessionFolderへ保存できる"
  // oracle = { type = "contract", ref = "src-electron/session-files.ts#copyFilesToSessionFiles,saveSessionFile" }
  // fault = "予算対象外と判定済みの添付を共通処理がBUDGET_NOT_FOUNDで拒否する、または保存を完了しない"
  // observable = "resourceBudget=nullでcopyとpasteが完了し、SessionFolderへ保存された実体の内容"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("予算対象外と判定した添付をcopyとpasteで保存する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-files-"));
    const userDataPath = path.join(directory, "user-data");
    const sourcePath = path.join(directory, "source.txt");
    await writeFile(sourcePath, "copy");
    try {
      const copied = await copyFilesToSessionFiles(userDataPath, "companion-1", [sourcePath], null);
      assert.equal((await readFile(copied[0])).toString(), "copy");

      const pasted = await saveSessionFile(userDataPath, {
        sessionId: "companion-1",
        fileName: "pasted.txt",
        data: Buffer.from("paste"),
      }, null);
      assert.equal((await readFile(pasted)).toString(), "paste");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "GUI pasteは実ledgerのroot storage hard limitを副作用前に拒否し、exact limitを保存して実容量へ精算する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#admission-と-settlement" }
  // fault = "GUI pasteがstorage reservationを迂回する、境界値を拒否する、または保存後のcommitted量を更新しない"
  // observable = "saveSessionFileの拒否と保存結果、budget.getのstorageBytes committed"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("GUI pasteを実ledgerのexact storage limitでreserveして精算する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-budget-paste-"));
    const dbPath = path.join(directory, "db.sqlite");
    const userDataPath = path.join(directory, "user-data");
    const sessionStorage = new SessionStorageV6(dbPath);
    sessionStorage.insertSession(buildNewSession({
      id: "root",
      taskTitle: "root",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      rootSessionRole: "overall-coordinator",
    }));
    const storage = new ResourceBudgetStorage(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE resource_budget_dimensions_v6 SET hard_limit = 5
      WHERE account_id = 'root' AND dimension = 'storageBytes'`).run();
    const budget = new SessionFolderResourceBudget({
      storage,
      resolveSessionFilesDirectory: (sessionId) => resolveSessionFilesDirectory(userDataPath, sessionId),
      listRootSessionIds: () => ["root"],
    });
    try {
      await assert.rejects(
        saveSessionFile(userDataPath, {
          sessionId: "root",
          fileName: "too-large.txt",
          data: Buffer.from("123456"),
        }, budget),
        (error) => error instanceof ResourceBudgetError && error.code === "BUDGET_HARD_LIMIT_EXCEEDED",
      );
      const sessionFolder = resolveSessionFilesDirectory(userDataPath, "root");
      await assert.rejects(readdir(sessionFolder), /ENOENT/);
      assert.equal(await measureSessionFolders(["root"], () => sessionFolder), 0);

      const saved = await saveSessionFile(userDataPath, {
        sessionId: "root",
        fileName: "exact.txt",
        data: Buffer.from("12345"),
      }, budget);
      assert.equal(path.basename(saved), "exact.txt");
      assert.equal(storage.get("root").dimensions.storageBytes.committed, 5);
    } finally {
      db.close();
      storage.close();
      sessionStorage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "regression"
  // claim = "GUI copyは予約後にsourceが増えても予約byteを超えてSessionFolderへ書き込まない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#admission-と-settlement" }
  // fault = "copyFileが変化後のsource全体を書き込み、検出前にroot hard limitを物理的に超える"
  // observable = "copy失敗後にSessionFolderへ作成されたfileの実byte長とreconciliation呼出"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("予約後に増えたsourceを予約byteまでで停止してreconciliationへ送る", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-budget-copy-"));
    const userDataPath = path.join(directory, "user-data");
    const sourcePath = path.join(directory, "source.txt");
    await writeFile(sourcePath, "abc");
    let reconciled = false;
    const lease = { reservation: reservation(), alreadyCommittedBytes: 0, releaseLock: () => undefined };
    const budget = {
      reserve: async () => {
        await appendFile(sourcePath, "def");
        return lease;
      },
      settleApplied: async () => undefined,
      release: () => undefined,
      reconcileRequired: async () => {
        reconciled = true;
      },
    } as unknown as SessionFolderResourceBudget;
    try {
      await assert.rejects(
        copyFilesToSessionFiles(userDataPath, "root", [sourcePath], budget),
        /grew beyond its reserved SessionFolder storage/,
      );
      const targetDirectory = resolveSessionFilesDirectory(userDataPath, "root");
      const [targetName] = await readdir(targetDirectory);
      assert.equal((await readFile(path.join(targetDirectory, targetName))).byteLength, 3);
      assert.equal(reconciled, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "rootの保存容量は配下の複数SessionFolderを再帰走査し、同じ実体のhard linkを一度だけ合算する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#budget-model" }
  // fault = "子Sessionまたはnested fileを漏らす、あるいはoperation proofのhard linkを別容量として二重計上する"
  // observable = "実在する複数SessionFolderを走査して返したbyte合計"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("root配下のSessionFolderを再帰的に合算し、未作成folderを0として扱う", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-budget-files-"));
    const resolveDirectory = (sessionId: string) => path.join(userDataPath, sessionId);
    try {
      await mkdir(path.join(resolveDirectory("root"), "nested"), { recursive: true });
      await mkdir(resolveDirectory("child"), { recursive: true });
      await writeFile(path.join(resolveDirectory("root"), "a.txt"), "abc");
      await writeFile(path.join(resolveDirectory("root"), "nested", "b.txt"), "de");
      await writeFile(path.join(resolveDirectory("child"), "c.txt"), "fghi");
      await link(
        path.join(resolveDirectory("root"), "a.txt"),
        path.join(resolveDirectory("child"), "a-proof.txt"),
      );

      assert.equal(
        await measureSessionFolders(["root", "child", "missing"], resolveDirectory),
        9,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "SessionFolder scanが完了しない場合はusageを0へ戻さずunknownを永続化してadmissionを拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#budget-model" }
  // fault = "filesystem scan失敗を0 byteとして精算し、新しいeffectを誤って許可する"
  // observable = "markStorageUnknown呼出とreconcileが返すBUDGET_STORAGE_UNKNOWN"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("scan失敗をstorage unknownとして記録しadmissionへ返す", async () => {
    let markedUnknown = false;
    const storage = {
      markStorageUnknown: () => {
        markedUnknown = true;
      },
    };
    const budget = new SessionFolderResourceBudget({
      storage: storage as never,
      resolveSessionFilesDirectory: () => {
        throw new Error("scan unavailable");
      },
      listRootSessionIds: () => ["root"],
    });

    await assert.rejects(
      budget.reconcile("root"),
      (error) => error instanceof ResourceBudgetError && error.code === "BUDGET_STORAGE_UNKNOWN",
    );
    assert.equal(markedUnknown, true);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "managed writeの予約から実容量精算までroot scanを直列化し、途中snapshotでcommittedを巻き戻さない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#admission-と-settlement" }
  // fault = "write中のadmission scanが先に完了し、古いabsolute使用量をledgerへ確定する"
  // observable = "fake ledgerが受け取るabsoluteAmountの順序と、lease中の並行reconcile完了状態"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-files"
  // lifecycle = "permanent"
  // @end-test-value
  it("予約lease中のreconcileを待たせてpublish後の容量を順番に確定する", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-budget-lock-"));
    const directoryPath = path.join(userDataPath, "root");
    const reconciledAmounts: number[] = [];
    const storedReservation = reservation();
    const storage = {
      reserveStorage: () => storedReservation,
      consumeReservation: () => ({ ...storedReservation, consumed: 4, state: "consumed" as const }),
      releaseReservation: () => ({ ...storedReservation, state: "released" as const }),
      markReservationForReconciliation: () => ({
        ...storedReservation,
        state: "reconciliation_required" as const,
      }),
      reconcileCommitted: (input: { absoluteAmount: number }) => {
        reconciledAmounts.push(input.absoluteAmount);
        return {
          dimensions: {
            storageBytes: { committed: input.absoluteAmount, hardLimit: 100 },
          },
        };
      },
    };
    const budget = new SessionFolderResourceBudget({
      storage: storage as never,
      resolveSessionFilesDirectory: () => directoryPath,
      listRootSessionIds: () => ["root"],
      now: () => new Date("2026-09-07T00:00:00.000Z"),
    });

    try {
      await mkdir(directoryPath, { recursive: true });
      const lease = await budget.reserve("root", 4, "write-1");
      let concurrentReconcileFinished = false;
      const concurrentReconcile = budget.reconcile("root").then(() => {
        concurrentReconcileFinished = true;
      });
      await Promise.resolve();
      assert.equal(concurrentReconcileFinished, false);

      await writeFile(path.join(directoryPath, "result.txt"), "data");
      await budget.settleApplied("root", lease, 4);
      await concurrentReconcile;

      assert.deepEqual(reconciledAmounts, [0, 4, 4]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
