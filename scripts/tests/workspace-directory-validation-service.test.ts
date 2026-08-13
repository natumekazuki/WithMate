import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkspaceDirectoryValidationService } from "../../src-electron/workspace-directory-validation-service.js";
import { resolveWorkspaceDirectoryValidationMessage } from "../../src/workspace-directory-validation.js";

function createService({
  absolute = true,
  directory = true,
  statError,
  accessError,
}: {
  absolute?: boolean;
  directory?: boolean;
  statError?: unknown;
  accessError?: unknown;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    service: new WorkspaceDirectoryValidationService({
      isAbsolute(targetPath) {
        calls.push(`absolute:${targetPath}`);
        return absolute;
      },
      async stat(targetPath) {
        calls.push(`stat:${targetPath}`);
        if (statError) throw statError;
        return { isDirectory: () => directory };
      },
      async access(targetPath) {
        calls.push(`access:${targetPath}`);
        if (accessError) throw accessError;
      },
    }),
  };
}

describe("WorkspaceDirectoryValidationService", () => {
  it("入力文字列を変更せず absolute directory の利用可能性を確認する", async () => {
    const { service, calls } = createService();
    const targetPath = "C:\\work space\\repo\\";

    assert.deepEqual(await service.validate(targetPath), { valid: true });
    assert.deepEqual(calls, [
      `absolute:${targetPath}`,
      `stat:${targetPath}`,
      `access:${targetPath}`,
    ]);
  });

  it("relative path、missing、file、unavailable を区別する", async () => {
    assert.deepEqual(await createService({ absolute: false }).service.validate("repo"), {
      valid: false,
      reason: "not-absolute",
    });
    assert.deepEqual(await createService({
      statError: Object.assign(new Error("missing"), { code: "ENOENT" }),
    }).service.validate("C:\\missing"), { valid: false, reason: "missing" });
    assert.deepEqual(await createService({ directory: false }).service.validate("C:\\file.txt"), {
      valid: false,
      reason: "not-directory",
    });
    assert.deepEqual(await createService({ accessError: new Error("denied") }).service.validate("C:\\private"), {
      valid: false,
      reason: "unavailable",
    });
  });

  it("unknown input は filesystem へ渡さない", async () => {
    const { service, calls } = createService();
    assert.deepEqual(await service.validate(null), { valid: false, reason: "empty" });
    assert.deepEqual(calls, []);
  });
});

describe("workspace directory validation messages", () => {
  it("短い英語の recovery message を返し、empty では表示しない", () => {
    assert.equal(resolveWorkspaceDirectoryValidationMessage({ valid: false, reason: "empty" }), "");
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({ valid: false, reason: "not-absolute" }),
      "Enter an absolute path.",
    );
    assert.equal(resolveWorkspaceDirectoryValidationMessage({ valid: false, reason: "missing" }), "Path not found.");
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({ valid: false, reason: "not-directory" }),
      "Not a directory.",
    );
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({ valid: false, reason: "unavailable" }),
      "Directory unavailable.",
    );
  });
});
