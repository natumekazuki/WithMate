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
    const memoryRuntimeRoot = protectedRoots[0]!;
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
        /protected WithMate directory/,
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
        /protected WithMate directory/,
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

  it("userData root 自体は provider root として許可し、内部生成ディレクトリだけ拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-root-guard-user-data-"));
    const userDataPath = path.join(tempDirectory, "UserData");
    const protectedRoots = buildProviderInstructionTargetProtectedRoots(userDataPath);

    try {
      assert.doesNotThrow(() =>
        assertProviderInstructionTargetRootNotProtected(
          buildInput({
            enabled: true,
            rootDirectory: userDataPath,
            instructionRelativePath: "AGENTS.md",
          }),
          protectedRoots,
        ),
      );

      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: path.join(userDataPath, "mate"),
            }),
            protectedRoots,
          ),
        /protected WithMate directory/,
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
        /protected WithMate directory/,
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
      /protected WithMate directory/,
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
        /protected WithMate directory/,
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("additionalProtectedRoots の重複は1つにまとめられ、rootDirectory と instructionRelativePath 解決先の両方が拒否される", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-root-guard-additional-"));
    const userDataPath = path.join(tempDirectory, "WithMate");
    const additionalProtectedRoot = path.join(tempDirectory, "ExternalSource");

    const protectedRoots = buildProviderInstructionTargetProtectedRoots(userDataPath, {
      additionalProtectedRoots: [additionalProtectedRoot, additionalProtectedRoot, path.join(additionalProtectedRoot, ".")],
    });

    try {
      const normalizedAdditionalProtectedRoot = path.resolve(additionalProtectedRoot);
      const additionalProtectedRootMatches = protectedRoots.filter(
        (root) => path.resolve(root) === normalizedAdditionalProtectedRoot,
      );
      assert.equal(additionalProtectedRootMatches.length, 1);

      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: normalizedAdditionalProtectedRoot,
            }),
            protectedRoots,
          ),
        /protected WithMate directory/,
      );

      assert.throws(
        () =>
          assertProviderInstructionTargetRootNotProtected(
            buildInput({
              enabled: true,
              rootDirectory: tempDirectory,
              instructionRelativePath: path.relative(
                tempDirectory,
                path.join(additionalProtectedRoot, "AGENTS.md"),
              ),
            }),
            protectedRoots,
          ),
        /protected WithMate directory/,
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
