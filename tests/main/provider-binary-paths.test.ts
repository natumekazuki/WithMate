import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  listSupportedProviderBinaryPackageSpecifiers,
  resolveDevelopmentProviderBinaryPath,
  resolvePackagedProviderBinaryPath,
  resolveProviderBinarySpec,
} from "../../src-electron/providers/provider-binary-paths.js";

describe("provider-binary-paths", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "OpenCodeはWindows/macOSのx64 baselineとarm64の公式実行物をASAR外から解決し、欠損時はnullにする"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
  // fault = "Windows package名をwin32にする、bin階層を落とす、x64非baselineを選ぶ、存在しない実行物を返す"
  // observable = "platform spec、stage一覧、開発時と配布時のbinary pathと欠損時null"
  // observation_boundary = "public-boundary"
  // scope = "OpenCode binary resolution"
  // lifecycle = "permanent"
  // impact = "利用者のPATH依存や配布版起動失敗につながる"
  // distinction = "packageの文字列と配置の対応は型検査できず、四targetを低コストで検証できる"
  // @end-test-value
  it("OpenCode公式baseline/arm64実行物を対応OSの配布pathへ解決する", () => {
    const packages = listSupportedProviderBinaryPackageSpecifiers();
    const targets = [
      ["win32", "x64", "@opencode/cli-windows-x64-baseline", "opencode.exe"],
      ["win32", "arm64", "@opencode/cli-windows-arm64", "opencode.exe"],
      ["darwin", "x64", "@opencode/cli-darwin-x64-baseline", "opencode"],
      ["darwin", "arm64", "@opencode/cli-darwin-arm64", "opencode"],
    ] as const;
    for (const [platform, arch, packageSpecifier, binary] of targets) {
      assert.deepEqual(resolveProviderBinarySpec("opencode", platform, arch), { packageSpecifier, binaryRelativePath: ["bin", binary] });
      assert.ok(packages.includes(packageSpecifier));
      const root = path.join("space 日本語", "node_modules", packageSpecifier);
      const expected = path.join(root, "bin", binary);
      assert.equal(resolveDevelopmentProviderBinaryPath("opencode", specifier => {
        assert.equal(specifier, `${packageSpecifier}/package.json`);
        return path.join(root, "package.json");
      }, candidate => candidate === expected, platform, arch), expected);
      const resources = path.join("Program Files 日本語", "resources");
      const packaged = path.join(resources, "provider-binaries", packageSpecifier, "bin", binary);
      assert.equal(resolvePackagedProviderBinaryPath("opencode", resources, candidate => candidate === packaged, platform, arch), packaged);
      assert.equal(resolvePackagedProviderBinaryPath("opencode", resources, () => false, platform, arch), null);
    }
    assert.equal(resolveProviderBinarySpec("opencode", "linux", "x64"), null);
    assert.equal(resolveProviderBinarySpec("opencode", "win32", "ia32"), null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Claudeの公式native packageを配布対象OSで解決し、開発時のpackage配置とASAR外の配布pathを返し、配布先に実行物がなければnullを返す"
  // oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
  // fault = "Claudeを別Providerのpackageへ写す、配布先をASAR内にする、または配布先の不足した実行物を存在する扱いで返す"
  // observable = "native package spec、stage対象一覧、開発時・配布時の実行pathと配布先不足時のnull"
  // observation_boundary = "public-boundary"
  // scope = "provider-binary-paths"
  // lifecycle = "permanent"
  // impact = "配布版で公式Claude実行物を起動できない、または別Providerへ接続する"
  // distinction = "型検査ではpackage名と実ファイル配置の対応を検証できず、既存testはCodexとCopilotだけを対象にする"
  // @end-test-value
  it("Claude公式実行物を対応OSのpackageとASAR外のpathへ解決する", () => {
    const packages = listSupportedProviderBinaryPackageSpecifiers();
    for (const platform of ["win32", "darwin"] as const) {
      for (const arch of ["x64", "arm64"]) {
        const packageSpecifier = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
        const fileName = platform === "win32" ? "claude.exe" : "claude";
        assert.deepEqual(resolveProviderBinarySpec("claude", platform, arch), {
          packageSpecifier,
          binaryRelativePath: [fileName],
        });
        assert.ok(packages.includes(packageSpecifier));
        const packageRoot = path.join("work space 日本語", "node_modules", packageSpecifier);
        assert.equal(resolveDevelopmentProviderBinaryPath(
          "claude",
          (specifier) => {
            assert.equal(specifier, `${packageSpecifier}/package.json`);
            return path.join(packageRoot, "package.json");
          },
          (candidate) => candidate === path.join(packageRoot, fileName),
          platform,
          arch,
        ), path.join(packageRoot, fileName));
        const resourcesPath = path.join("Program Files 日本語", "WithMate", "resources");
        const expected = path.join(resourcesPath, "provider-binaries", packageSpecifier, fileName);
        assert.equal(resolvePackagedProviderBinaryPath(
          "claude", resourcesPath, (candidate) => candidate === expected, platform, arch,
        ), expected);
        assert.equal(resolvePackagedProviderBinaryPath(
          "claude", resourcesPath, () => false, platform, arch,
        ), null);
      }
    }
    assert.equal(resolveProviderBinarySpec("claude", "win32", "ia32"), null);
    assert.equal(resolveProviderBinarySpec("claude", "linux", "x64"), null);
  });

  it("provider ごとの native package spec を返す", () => {
    assert.deepEqual(resolveProviderBinarySpec("codex", "win32", "x64"), {
      packageSpecifier: "@openai/codex-win32-x64",
      binaryRelativePath: ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
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
      "bin",
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

  it("development runtime では package.json subpath が非公開でも root export から native binary を解決する", () => {
    const expected = path.join("F:\\repo", "node_modules", "@github", "copilot-win32-x64", "copilot.exe");
    const resolved = resolveDevelopmentProviderBinaryPath(
      "copilot",
      (specifier) => {
        if (specifier === "@github/copilot-win32-x64/package.json") {
          throw Object.assign(new Error("Package subpath './package.json' is not defined by exports"), {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          });
        }
        assert.equal(specifier, "@github/copilot-win32-x64");
        return expected;
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
