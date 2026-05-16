import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
} from "../../src/provider-instruction-target-state.js";
import type { MateProfile } from "../../src/mate/mate-state.js";
import {
  upsertProviderInstructionTargetCommand,
  type UpsertProviderInstructionTargetCommandDeps,
} from "../../src-electron/provider-instruction-target-command-service.js";

function createProfile(overrides: Partial<MateProfile> = {}): MateProfile {
  return {
    id: "mate-1",
    state: "active",
    displayName: "Mate",
    description: "",
    themeMain: "#000000",
    themeSub: "#ffffff",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: "rev-1",
    profileGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    sections: [],
    ...overrides,
  };
}

function createInput(overrides: Partial<ProviderInstructionTargetInput> = {}): ProviderInstructionTargetInput {
  return {
    providerId: "codex",
    enabled: true,
    rootDirectory: "C:/workspace",
    instructionRelativePath: "AGENTS.md",
    writeMode: "managed_block",
    failPolicy: "warn_continue",
    ...overrides,
  };
}

function buildStoredTarget(input: ProviderInstructionTargetInput): ProviderInstructionTarget {
  return {
    providerId: input.providerId,
    targetId: input.targetId ?? "main",
    enabled: input.enabled,
    rootDirectory: input.rootDirectory,
    instructionRelativePath: input.instructionRelativePath,
    writeMode: input.writeMode,
    projectionScope: "mate_only",
    failPolicy: input.failPolicy,
    requiresRestart: input.requiresRestart ?? false,
    lastSyncState: "never",
    lastSyncRunId: null,
    lastSyncedRevisionId: null,
    lastErrorPreview: "",
    lastSyncedAt: null,
  };
}

function createStorageState(initialTarget: ProviderInstructionTarget | null = null) {
  const calls = { getTarget: 0, upsertTarget: 0 };
  let target: ProviderInstructionTarget | null = initialTarget;

  return {
    calls,
    get target() {
      return target;
    },
    set target(next: ProviderInstructionTarget | null) {
      target = next;
    },
    storage: {
      getTarget(providerId: string, targetId = "main") {
        calls.getTarget += 1;
        if (!target || target.providerId !== providerId || target.targetId !== targetId) {
          return null;
        }
        return target;
      },
      upsertTarget(input: ProviderInstructionTargetInput) {
        calls.upsertTarget += 1;
        target = buildStoredTarget(input);
        return target;
      },
    },
  };
}

function createDeps(
  state: ReturnType<typeof createStorageState>,
  overrides: Partial<UpsertProviderInstructionTargetCommandDeps> = {},
): UpsertProviderInstructionTargetCommandDeps {
  return {
    storage: state.storage,
    getMateProfile() {
      return null;
    },
    syncEnabledProviderInstructionTargetsForMateProfile: async () => {},
    syncDisabledProviderInstructionTarget: async () => {
      throw new Error("sync disabled should not be called");
    },
    protectedRoots: [],
    syncDeps: {
      readTextFile: async () => "",
      writeTextFile: async () => {},
    },
    assertProviderInstructionTargetRootNotProtected: () => {},
    logDisabledCleanupFailure: () => {
      throw new Error("log disabled cleanup should not be called");
    },
    ...overrides,
  };
}

describe("ProviderInstructionTargetCommandService", () => {
  it("enabled target 保存時、Mate profile があれば enabled sync を呼び、storage.getTarget の fresh target を返す", async () => {
    const profile = createProfile();
    const storageState = createStorageState();
    let syncCalledProfile: MateProfile | null = null;

    const result = await upsertProviderInstructionTargetCommand(createInput(), createDeps(storageState, {
      getMateProfile: () => profile,
      syncEnabledProviderInstructionTargetsForMateProfile: async (targetProfile) => {
        syncCalledProfile = targetProfile;
        if (!storageState.target) {
          throw new Error("target missing");
        }
        storageState.target = {
          ...storageState.target,
          lastSyncState: "synced",
          lastSyncedRevisionId: "rev-2",
          lastSyncedAt: "2026-02-01T00:00:00.000Z",
          lastErrorPreview: "",
        };
      },
      syncDisabledProviderInstructionTarget: async () => {
        throw new Error("unexpected");
      },
      logDisabledCleanupFailure: () => {},
    }));

    const calledProfile = syncCalledProfile;
    assert.ok(calledProfile);
    assert.deepEqual(calledProfile, profile);
    assert.equal(result.lastSyncState, "synced");
    assert.equal(result.lastSyncedRevisionId, "rev-2");
    assert.equal(result.lastSyncedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(storageState.calls.upsertTarget, 1);
    assert.equal(storageState.calls.getTarget, 2);
  });

  it("enabled->disabled のとき cleanup が失敗したら保存せず例外を伝播する", async () => {
    const initialInput = createInput({ enabled: true });
    const storageState = createStorageState(buildStoredTarget(initialInput));
    const previousTarget = storageState.target;
    let cleanupTargetId: string | null = null;
    let logged = false;

    await assert.rejects(
      () => upsertProviderInstructionTargetCommand(
        createInput({ enabled: false }),
        createDeps(storageState, {
          syncDisabledProviderInstructionTarget: async (_, targetToClean) => {
            cleanupTargetId = `${targetToClean.providerId}:${targetToClean.targetId}`;
            throw new Error("cleanup failed");
          },
          logDisabledCleanupFailure: () => {
            logged = true;
          },
        }),
      ),
      /cleanup failed/,
    );

    assert.equal(cleanupTargetId, "codex:main");
    assert.equal(logged, true);
    assert.equal(storageState.target?.enabled, true);
    assert.equal(previousTarget?.enabled, true);
    assert.equal(storageState.calls.upsertTarget, 0);
    assert.equal(storageState.calls.getTarget, 1);
  });

  it("enabled target の同期先変更で cleanup failedCount があれば旧 target を保存したまま中断する", async () => {
    const initialInput = createInput({
      enabled: true,
      rootDirectory: "C:/workspace-old",
      instructionRelativePath: "AGENTS.md",
      writeMode: "managed_block",
    });
    const storageState = createStorageState(buildStoredTarget(initialInput));
    let logged = false;

    await assert.rejects(
      () => upsertProviderInstructionTargetCommand(
        createInput({
          enabled: true,
          rootDirectory: "C:/workspace-new",
          instructionRelativePath: ".github/copilot-instructions.md",
          writeMode: "managed_block",
        }),
        createDeps(storageState, {
          syncDisabledProviderInstructionTarget: async () => ({
            targetCount: 1,
            syncedCount: 0,
            failedCount: 1,
            skippedCount: 0,
            runIds: [1],
          }),
          syncEnabledProviderInstructionTargetsForMateProfile: async () => {
            throw new Error("enabled sync should not run");
          },
          logDisabledCleanupFailure: () => {
            logged = true;
          },
        }),
      ),
      /previous provider instruction target cleanup failed/,
    );

    assert.equal(logged, true);
    assert.equal(storageState.target?.rootDirectory, "C:/workspace-old");
    assert.equal(storageState.calls.upsertTarget, 0);
  });

  it("enabled target の同期先を変更したときは旧 target の managed block を cleanup してから enabled sync する", async () => {
    const initialInput = createInput({
      enabled: true,
      rootDirectory: "C:/workspace-old",
      instructionRelativePath: "AGENTS.md",
      writeMode: "managed_block",
    });
    const storageState = createStorageState(buildStoredTarget(initialInput));
    const profile = createProfile();
    const cleanupTargets: string[] = [];
    let enabledSyncCalled = false;

    const result = await upsertProviderInstructionTargetCommand(
      createInput({
        enabled: true,
        rootDirectory: "C:/workspace-new",
        instructionRelativePath: ".github/copilot-instructions.md",
        writeMode: "managed_block",
      }),
      createDeps(storageState, {
        getMateProfile: () => profile,
        syncDisabledProviderInstructionTarget: async (_, targetToClean) => {
          cleanupTargets.push(
            `${targetToClean.rootDirectory}/${targetToClean.instructionRelativePath}/${targetToClean.writeMode}`,
          );
        },
        syncEnabledProviderInstructionTargetsForMateProfile: async () => {
          enabledSyncCalled = true;
        },
        logDisabledCleanupFailure: () => {
          throw new Error("cleanup should not fail");
        },
      }),
    );

    assert.deepEqual(cleanupTargets, ["C:/workspace-old/AGENTS.md/managed_block"]);
    assert.equal(enabledSyncCalled, true);
    assert.equal(result.enabled, true);
    assert.equal(result.rootDirectory, "C:/workspace-new");
  });

  it("enabled target の failPolicy だけを変更したときは旧 target cleanup を呼ばない", async () => {
    const initialInput = createInput({ enabled: true, failPolicy: "warn_continue" });
    const storageState = createStorageState(buildStoredTarget(initialInput));
    let cleanupCalled = false;

    await upsertProviderInstructionTargetCommand(
      createInput({ enabled: true, failPolicy: "block_session" }),
      createDeps(storageState, {
        getMateProfile: () => createProfile(),
        syncDisabledProviderInstructionTarget: async () => {
          cleanupCalled = true;
        },
        syncEnabledProviderInstructionTargetsForMateProfile: async () => {},
        logDisabledCleanupFailure: () => {},
      }),
    );

    assert.equal(cleanupCalled, false);
  });

  it("enabled target で Mate profile がない場合は enabled sync をしない", async () => {
    const storageState = createStorageState();
    let syncCalled = false;

    const result = await upsertProviderInstructionTargetCommand(createInput(), createDeps(storageState, {
      syncEnabledProviderInstructionTargetsForMateProfile: async () => {
        syncCalled = true;
      },
    }));

    assert.equal(syncCalled, false);
    assert.equal(result.enabled, true);
    assert.equal(storageState.calls.upsertTarget, 1);
    assert.equal(storageState.calls.getTarget, 2);
  });

  it("root guard 失敗時は storage に保存せず例外を伝播する", async () => {
    const storageState = createStorageState();
    let guardCalled = false;

    await assert.rejects(
      () =>
        upsertProviderInstructionTargetCommand(createInput(), createDeps(storageState, {
          assertProviderInstructionTargetRootNotProtected: () => {
            guardCalled = true;
            throw new Error("root blocked");
          },
        })),
      /root blocked/,
    );

    assert.equal(guardCalled, true);
    assert.equal(storageState.calls.upsertTarget, 0);
    assert.equal(storageState.calls.getTarget, 0);
  });
});
