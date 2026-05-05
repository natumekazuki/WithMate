import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  assertProviderInstructionTargetRootNotProtected,
  buildProviderInstructionTargetProtectedRoots,
} from "../../src-electron/provider-instruction-target-root-guard.js";
import type { ProviderInstructionTargetInput } from "../../src/provider-instruction-target-state.js";

function buildInput(overrides: Partial<ProviderInstructionTargetInput>): ProviderInstructionTargetInput {
  return {
    providerId: "codex",
    enabled: true,
    rootDirectory: "",
    instructionRelativePath: "AGENTS.md",
    writeMode: "managed_block",
    failPolicy: "warn_continue",
    ...overrides,
  };
}

describe("ProviderInstructionTargetRootGuard", () => {
  it("enabled target の rootDirectory が保護ルート直下/同一なら拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-root-guard-"));
    const protectedRoots = buildProviderInstructionTargetProtectedRoots(path.join(tempDirectory, "UserData"));
    const memoryRuntimeRoot = protectedRoots[1]!;
    const siblingPath = path.join(tempDirectory, "AllowedProject");

    try {
      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: memoryRuntimeRoot,
            }),
            protectedRoots,
          ),
        /保護ディレクトリ配下/,
      );

      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: path.join(memoryRuntimeRoot, "targets", "project"),
            }),
            protectedRoots,
          ),
        /保護ディレクトリ配下/,
      );

      assert.doesNotThrow(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: siblingPath,
            }),
            protectedRoots,
          ),
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("disabled target は rootDirectory 空で許可する", () => {
    const protectedRoots = buildProviderInstructionTargetProtectedRoots(path.join("/tmp", "withmate-user-data"));
    assert.doesNotThrow(() =>
      assertProviderInstructionTargetRootNotProtected(
        buildInput({
          enabled: false,
          rootDirectory: "",
        }),
        protectedRoots,
      ),
    );
  });

  it("disabled target でも保護領域を rootDirectory に指定した場合は拒否する", () => {
    const protectedRoots = buildProviderInstructionTargetProtectedRoots(path.join(os.tmpdir(), "withmate-user-data"));
    assert.throws(
      () =>
        assertProviderInstructionTargetRootNotProtected(
          buildInput({
            enabled: false,
            rootDirectory: protectedRoots[0]!,
          }),
          protectedRoots,
        ),
        /保護ディレクトリ配下/,
    );
  });

  it("Windows namespaced path の表記ゆれでも保護ルート配下なら拒否する", () => {
    const userDataPath = "C:\\Users\\withmate\\AppData\\Roaming\\WithMate";
    const protectedRoots = [
      path.join(userDataPath, "memory-runtime"),
      path.join(userDataPath, "mate-talk-runtime"),
      path.join(userDataPath, "mate"),
      userDataPath,
    ];

    assert.throws(
      () =>
        assertProviderInstructionTargetRootNotProtected(
          buildInput({
            enabled: true,
            rootDirectory: `\\\\?\\${path.join(userDataPath, "memory-runtime", "workspace")}`,
          }),
          protectedRoots,
        ),
      /保護ディレクトリ配下/,
    );

    assert.doesNotThrow(() =>
      assertProviderInstructionTargetRootNotProtected(
        buildInput({
          enabled: true,
          rootDirectory: path.join("C:\\Users\\withmate\\AppData\\Roaming", "WithMate-sibling"),
        }),
        protectedRoots,
      ),
    );
  });

  it("rootDirectory が保護外でも instructionRelativePath 解決後が保護下なら拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-root-guard-resolved-"));
    const userDataPath = path.join(tempDirectory, "WithMate");
    const protectedRoots = buildProviderInstructionTargetProtectedRoots(userDataPath);
    const rootDirectory = path.dirname(userDataPath);

    try {
      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory,
              instructionRelativePath: path.join("WithMate", "memory-runtime", "AGENTS.md"),
            }),
            protectedRoots,
          ),
        /保護ディレクトリ配下/,
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
