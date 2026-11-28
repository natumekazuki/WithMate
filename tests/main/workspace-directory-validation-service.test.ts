import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkspaceDirectoryValidationService } from "../../src-electron/files/workspace-directory-validation-service.js";
import { resolveWorkspaceDirectoryValidationMessage } from "../../src-shared/window/workspace-directory-validation.js";

/** ファイルシステムを触らずに絶対パス判定、stat、access の結果と呼出順を制御できる検証用サービスを作る。 */
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
      /** 受け取ったパスを記録し、指定された絶対パス判定を返す。 */
      isAbsolute(targetPath) {
        calls.push(`absolute:${targetPath}`);
        return absolute;
      },
      /** パスの存在・種別を照会した事実を記録し、欠損時の例外も再現する。 */
      async stat(targetPath) {
        calls.push(`stat:${targetPath}`);
        if (statError) throw statError;
        return {
          /** stat に成功した対象がファイルかディレクトリかを切り替える。 */
          isDirectory: () => directory,
        };
      },
      /** アクセス確認に渡されたパスを記録し、指定時は拒否を再現する。 */
      async access(targetPath) {
        calls.push(`access:${targetPath}`);
        if (accessError) throw accessError;
      },
    }),
  };
}

/** Workspace の候補を検証する際のパスの扱いと、利用できない理由の区分を確認する。 */
describe("WorkspaceDirectoryValidationService", () => {
  /** 空白や末尾区切りを含む絶対パスを変更せず、種別とアクセスを順に確認して有効と判定することを確かめる。 */
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

  /** 相対パス、存在しないパス、ファイル、アクセス不能なディレクトリを、それぞれ異なる理由で拒否することを確認する。 */
  it("relative path、missing、file、unavailable を区別する", async () => {
    assert.deepEqual(
      await createService({ absolute: false }).service.validate("repo"),
      {
        valid: false,
        reason: "not-absolute",
      },
    );
    assert.deepEqual(
      await createService({
        statError: Object.assign(new Error("missing"), { code: "ENOENT" }),
      }).service.validate("C:\\missing"),
      { valid: false, reason: "missing" },
    );
    assert.deepEqual(
      await createService({ directory: false }).service.validate(
        "C:\\file.txt",
      ),
      {
        valid: false,
        reason: "not-directory",
      },
    );
    assert.deepEqual(
      await createService({
        accessError: new Error("denied"),
      }).service.validate("C:\\private"),
      {
        valid: false,
        reason: "unavailable",
      },
    );
  });

  /** null は空の入力として扱い、パスやファイルシステムの照会を行わないことを確認する。 */
  it("unknown input は filesystem へ渡さない", async () => {
    const { service, calls } = createService();
    assert.deepEqual(await service.validate(null), {
      valid: false,
      reason: "empty",
    });
    assert.deepEqual(calls, []);
  });
});

/** Workspace を選べない理由を案内文に変換する表示用の関数を確認する。 */
describe("workspace directory validation messages", () => {
  /** 空の入力には案内を出さず、他の拒否理由には区別できる短い英語の文言を返すことを確かめる。 */
  it("短い英語の recovery message を返し、empty では表示しない", () => {
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({
        valid: false,
        reason: "empty",
      }),
      "",
    );
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({
        valid: false,
        reason: "not-absolute",
      }),
      "Enter an absolute path.",
    );
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({
        valid: false,
        reason: "missing",
      }),
      "Path not found.",
    );
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({
        valid: false,
        reason: "not-directory",
      }),
      "Not a directory.",
    );
    assert.equal(
      resolveWorkspaceDirectoryValidationMessage({
        valid: false,
        reason: "unavailable",
      }),
      "Directory unavailable.",
    );
  });
});
