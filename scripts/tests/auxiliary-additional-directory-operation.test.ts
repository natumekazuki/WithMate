import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveAuxiliaryAdditionalDirectoryPickerBase,
  runAddAuxiliaryAdditionalDirectoryOperation,
  runRemoveAuxiliaryAdditionalDirectoryOperation,
} from "../../src/auxiliary-additional-directory-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

describe("resolveAuxiliaryAdditionalDirectoryPickerBase", () => {
  it("picker base、workspace、fallback の順に base path を選ぶ", () => {
    assert.equal(
      resolveAuxiliaryAdditionalDirectoryPickerBase({
        pickerBaseDirectory: "C:/picked",
        workspacePath: "C:/workspace",
        fallbackPath: "C:/fallback",
      }),
      "C:/picked",
    );
    assert.equal(
      resolveAuxiliaryAdditionalDirectoryPickerBase({
        pickerBaseDirectory: "",
        workspacePath: "C:/workspace",
        fallbackPath: "C:/fallback",
      }),
      "C:/workspace",
    );
    assert.equal(
      resolveAuxiliaryAdditionalDirectoryPickerBase({
        pickerBaseDirectory: "",
        workspacePath: "",
        fallbackPath: "C:/fallback",
      }),
      "C:/fallback",
    );
    assert.equal(
      resolveAuxiliaryAdditionalDirectoryPickerBase({
        pickerBaseDirectory: "",
        workspacePath: null,
        fallbackPath: null,
      }),
      null,
    );
  });
});

describe("runAddAuxiliaryAdditionalDirectoryOperation", () => {
  it("active session がない場合は picker を開かない", async () => {
    let picked = false;

    await runAddAuxiliaryAdditionalDirectoryOperation({
      activeAuxiliarySession: null,
      pickerBaseDirectory: "",
      pickDirectory: async () => {
        picked = true;
        return "C:/selected";
      },
      setPickerBaseDirectory: () => {},
      updateActiveAuxiliarySession: async () => {},
      createTimestampLabel: () => "updated",
    });

    assert.equal(picked, false);
  });

  it("running session の場合は picker を開かない", async () => {
    let picked = false;

    await runAddAuxiliaryAdditionalDirectoryOperation({
      activeAuxiliarySession: makeAuxiliarySession({ runState: "running" }),
      pickerBaseDirectory: "",
      pickDirectory: async () => {
        picked = true;
        return "C:/selected";
      },
      setPickerBaseDirectory: () => {},
      updateActiveAuxiliarySession: async () => {},
      createTimestampLabel: () => "updated",
    });

    assert.equal(picked, false);
  });

  it("選択された directory を picker base と active session に反映する", async () => {
    const current = makeAuxiliarySession({ allowedAdditionalDirectories: ["C:/existing"] });
    let pickerBase = "";
    let updatedSession: AuxiliarySession | null = null;

    await runAddAuxiliaryAdditionalDirectoryOperation({
      activeAuxiliarySession: current,
      pickerBaseDirectory: "",
      workspacePath: "C:/workspace",
      pickDirectory: async (basePath) => {
        assert.equal(basePath, "C:/workspace");
        return "C:/selected";
      },
      setPickerBaseDirectory: (directoryPath) => {
        pickerBase = directoryPath;
      },
      updateActiveAuxiliarySession: async (recipe) => {
        updatedSession = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.equal(pickerBase, "C:/selected");
    assert.deepEqual(updatedSession, {
      ...current,
      allowedAdditionalDirectories: ["C:/existing", "C:/selected"],
      updatedAt: "updated",
    });
  });

  it("picker がキャンセルされた場合は更新しない", async () => {
    let pickerBase = "";
    let updated = false;

    await runAddAuxiliaryAdditionalDirectoryOperation({
      activeAuxiliarySession: makeAuxiliarySession(),
      pickerBaseDirectory: "",
      pickDirectory: async () => null,
      setPickerBaseDirectory: (directoryPath) => {
        pickerBase = directoryPath;
      },
      updateActiveAuxiliarySession: async () => {
        updated = true;
      },
      createTimestampLabel: () => "updated",
    });

    assert.equal(pickerBase, "");
    assert.equal(updated, false);
  });
});

describe("runRemoveAuxiliaryAdditionalDirectoryOperation", () => {
  it("指定 directory を active session から削除する", async () => {
    const current = makeAuxiliarySession({
      allowedAdditionalDirectories: ["C:/keep", "C:/remove"],
    });
    let updatedSession: AuxiliarySession | null = null;

    await runRemoveAuxiliaryAdditionalDirectoryOperation({
      directoryPath: "C:/remove",
      updateActiveAuxiliarySession: async (recipe) => {
        updatedSession = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updatedSession, {
      ...current,
      allowedAdditionalDirectories: ["C:/keep"],
      updatedAt: "updated",
    });
  });
});
