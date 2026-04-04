import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  listSupportedProviderBinaryPackageSpecifiers,
  resolveDevelopmentProviderBinaryPath,
  resolvePackagedProviderBinaryPath,
  resolveProviderBinarySpec,
} from "../../src-electron/provider-binary-paths.js";

describe("provider-binary-paths", () => {
  it("provider ごとの native package spec を返す", () => {
    assert.deepEqual(resolveProviderBinarySpec("codex", "win32", "x64"), {
      packageSpecifier: "@openai/codex-win32-x64",
      binaryRelativePath: ["vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"],
    });
    assert.deepEqual(resolveProviderBinarySpec("copilot", "darwin", "arm64"), {
      packageSpecifier: "@github/copilot-darwin-arm64",
      binaryRelativePath: ["copilot"],
    });
    assert.equal(resolveProviderBinarySpec("codex", "win32", "ia32"), null);
  });

  it("packaged runtime では resources/provider-binaries 配下を優先する", () => {
    const resourcesPath = "C:\\Program Files\\WithMate\\resources";
    const expected = path.join(
      resourcesPath,
      "provider-binaries",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );

    const resolved = resolvePackagedProviderBinaryPath(
      "codex",
      resourcesPath,
      (candidate) => candidate === expected,
      "win32",
      "x64",
    );

    assert.equal(resolved, expected);
  });

  it("development runtime では package.json 基準で native binary を解決する", () => {
    const packageJsonPath = path.join("F:\\repo", "node_modules", "@github", "copilot-win32-x64", "package.json");
    const expected = path.join("F:\\repo", "node_modules", "@github", "copilot-win32-x64", "copilot.exe");
    const resolved = resolveDevelopmentProviderBinaryPath(
      "copilot",
      (specifier) => {
        assert.equal(specifier, "@github/copilot-win32-x64/package.json");
        return packageJsonPath;
      },
      (candidate) => candidate === expected,
      "win32",
      "x64",
    );

    assert.equal(resolved, expected);
  });

  it("stage 対象 package の一覧に provider native package を含む", () => {
    const specifiers = listSupportedProviderBinaryPackageSpecifiers();

    assert.equal(specifiers.includes("@openai/codex-win32-x64"), true);
    assert.equal(specifiers.includes("@github/copilot-win32-x64"), true);
  });
});
