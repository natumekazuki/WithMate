import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildProviderInstructionTargetProtectedRoots,
} from "../../src-electron/provider-instruction-target-root-guard.js";
import {
  buildProviderInstructionTargetProtectedRootsWithWorkspace,
} from "../../src-electron/provider-instruction-target-protected-roots.js";

describe("ProviderInstructionTargetProtectedRoots", () => {
  it("workspace root を追加して保護ルートを構築できる", () => {
    const userDataPath = path.join(os.tmpdir(), "WithMate");
    const workspaceRoot = path.join(os.tmpdir(), "ProjectRoot");
    const secondWorkspaceRoot = path.join(os.tmpdir(), "ProjectRoot2");
    const protectedRoots = buildProviderInstructionTargetProtectedRootsWithWorkspace(userDataPath, {
      workspacePath: workspaceRoot,
      workspacePaths: [secondWorkspaceRoot],
    });
    const expectedWorkspaceRoot = path.resolve(workspaceRoot);
    const expectedSecondWorkspaceRoot = path.resolve(secondWorkspaceRoot);

    assert.equal(
      protectedRoots.includes(expectedWorkspaceRoot),
      true,
    );
    assert.equal(
      protectedRoots.includes(expectedSecondWorkspaceRoot),
      true,
    );
  });

  it("workspace root が空文字または undefined なら追加しない", () => {
    const userDataPath = path.join(os.tmpdir(), "WithMate");
    const baseProtectedRoots = buildProviderInstructionTargetProtectedRoots(userDataPath);

    assert.deepEqual(
      buildProviderInstructionTargetProtectedRootsWithWorkspace(userDataPath, {
        workspacePath: "",
      }),
      baseProtectedRoots,
    );

    assert.deepEqual(
      buildProviderInstructionTargetProtectedRootsWithWorkspace(userDataPath, {
        workspacePath: undefined,
      }),
      baseProtectedRoots,
    );

    assert.deepEqual(
      buildProviderInstructionTargetProtectedRootsWithWorkspace(userDataPath, {
        workspacePaths: ["", "   ", null, undefined],
      }),
      baseProtectedRoots,
    );
  });
});
