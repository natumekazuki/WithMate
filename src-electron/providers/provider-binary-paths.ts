import { existsSync } from "node:fs";
import path from "node:path";

/** 配布先や開発環境でネイティブ実行ファイルの配置を解決できるプロバイダー。 */
export type SupportedProviderBinary =
  "codex" | "copilot" | "claude" | "opencode";

/** プラットフォーム別 npm パッケージ名と、そのルートから実行ファイルまでのパス要素。 */
type ProviderBinarySpec = {
  packageSpecifier: string;
  binaryRelativePath: string[];
};

/** Windows・macOS・Linux の x64／arm64 用 Codex バイナリを選び、その他の組み合わせは対象外とする。 */
function resolveCodexSpec(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-win32-x64",
          binaryRelativePath: [
            "vendor",
            "x86_64-pc-windows-msvc",
            "bin",
            "codex.exe",
          ],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-win32-arm64",
          binaryRelativePath: [
            "vendor",
            "aarch64-pc-windows-msvc",
            "bin",
            "codex.exe",
          ],
        };
      }
      return null;
    case "darwin":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-darwin-x64",
          binaryRelativePath: ["vendor", "x86_64-apple-darwin", "bin", "codex"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-darwin-arm64",
          binaryRelativePath: [
            "vendor",
            "aarch64-apple-darwin",
            "bin",
            "codex",
          ],
        };
      }
      return null;
    case "linux":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-linux-x64",
          binaryRelativePath: [
            "vendor",
            "x86_64-unknown-linux-musl",
            "bin",
            "codex",
          ],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-linux-arm64",
          binaryRelativePath: [
            "vendor",
            "aarch64-unknown-linux-musl",
            "bin",
            "codex",
          ],
        };
      }
      return null;
    default:
      return null;
  }
}

/** OS と CPU に対応した Copilot SDK のパッケージと prebuilds 配下の実行ファイルを指定する。 */
function resolveCopilotSpec(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-sdk-win32-x64",
          binaryRelativePath: [
            "prebuilds",
            `win32-${arch}`,
            "copilot-runtime.exe",
          ],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-sdk-win32-arm64",
          binaryRelativePath: [
            "prebuilds",
            `win32-${arch}`,
            "copilot-runtime.exe",
          ],
        };
      }
      return null;
    case "darwin":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-sdk-darwin-x64",
          binaryRelativePath: [
            "prebuilds",
            `${platform}-${arch}`,
            "copilot-runtime",
          ],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-sdk-darwin-arm64",
          binaryRelativePath: [
            "prebuilds",
            `${platform}-${arch}`,
            "copilot-runtime",
          ],
        };
      }
      return null;
    case "linux":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-sdk-linux-x64",
          binaryRelativePath: [
            "prebuilds",
            `${platform}-${arch}`,
            "copilot-runtime",
          ],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-sdk-linux-arm64",
          binaryRelativePath: [
            "prebuilds",
            `${platform}-${arch}`,
            "copilot-runtime",
          ],
        };
      }
      return null;
    default:
      return null;
  }
}

/** 配布するパッケージと実行ファイルをプロバイダー・OS・CPU の組から選ぶ。未対応なら null。 */
export function resolveProviderBinarySpec(
  provider: SupportedProviderBinary,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  switch (provider) {
    case "opencode":
      if (
        !["win32", "darwin"].includes(platform) ||
        !["x64", "arm64"].includes(arch)
      )
        return null;
      return {
        packageSpecifier: `@opencode/cli-${platform === "win32" ? "windows" : platform}-${arch}${arch === "x64" ? "-baseline" : ""}`,
        binaryRelativePath: [
          "bin",
          platform === "win32" ? "opencode.exe" : "opencode",
        ],
      };
    case "codex":
      return resolveCodexSpec(platform, arch);
    case "copilot":
      return resolveCopilotSpec(platform, arch);
    case "claude":
      if (
        !["win32", "darwin"].includes(platform) ||
        !["x64", "arm64"].includes(arch)
      ) {
        return null;
      }
      return {
        packageSpecifier: `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
        binaryRelativePath: [platform === "win32" ? "claude.exe" : "claude"],
      };
  }
}

/** 対応する全プロバイダー・OS・CPU の組について、配布準備に必要なパッケージ名を重複なしで列挙する。 */
export function listSupportedProviderBinaryPackageSpecifiers(): string[] {
  const specs = new Set<string>();
  const providers: SupportedProviderBinary[] = [
    "codex",
    "copilot",
    "claude",
    "opencode",
  ];
  const platforms: Array<{ platform: NodeJS.Platform; arches: string[] }> = [
    { platform: "win32", arches: ["x64", "arm64"] },
    { platform: "darwin", arches: ["x64", "arm64"] },
    { platform: "linux", arches: ["x64", "arm64"] },
  ];

  for (const provider of providers) {
    for (const { platform, arches } of platforms) {
      for (const arch of arches) {
        const spec = resolveProviderBinarySpec(provider, platform, arch);
        if (spec) {
          specs.add(spec.packageSpecifier);
        }
      }
    }
  }

  return [...specs];
}

/** スコープ付きのパッケージ名を、ディレクトリ名として連結できるパス要素に分ける。 */
function splitScopedPackageSpecifier(packageSpecifier: string): string[] {
  return packageSpecifier.split("/");
}

/** パッケージのルートエクスポートが実行ファイルを直接指す場合と、その近くに置かれる場合の両方を確認する。 */
function resolveBinaryFromPackageRootExport(
  resolvedPackagePath: string,
  binaryRelativePath: string[],
  fileExists: (candidate: string) => boolean,
): string | null {
  const normalizedResolvedPath = path.normalize(resolvedPackagePath);
  const normalizedBinaryRelativePath = path.normalize(
    path.join(...binaryRelativePath),
  );
  if (
    normalizedResolvedPath.endsWith(normalizedBinaryRelativePath) &&
    fileExists(resolvedPackagePath)
  ) {
    return resolvedPackagePath;
  }

  const candidate = path.join(
    path.dirname(resolvedPackagePath),
    ...binaryRelativePath,
  );
  return fileExists(candidate) ? candidate : null;
}

/** 配布アプリのリソース配下に格納された実行ファイルを探し、配置または対応情報がなければ null を返す。 */
export function resolvePackagedProviderBinaryPath(
  provider: SupportedProviderBinary,
  resourcesPath: string | undefined = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath,
  fileExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const spec = resolveProviderBinarySpec(provider, platform, arch);
  if (!resourcesPath || !spec) {
    return null;
  }

  const candidate = path.join(
    resourcesPath,
    "provider-binaries",
    ...splitScopedPackageSpecifier(spec.packageSpecifier),
    ...spec.binaryRelativePath,
  );

  return fileExists(candidate) ? candidate : null;
}

/** 開発依存パッケージの package.json を基準に探す。その解決に失敗した場合はルートエクスポートを確認する。 */
export function resolveDevelopmentProviderBinaryPath(
  provider: SupportedProviderBinary,
  resolvePackagePath: (specifier: string) => string,
  fileExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const spec = resolveProviderBinarySpec(provider, platform, arch);
  if (!spec) {
    return null;
  }

  try {
    const packageJsonPath = resolvePackagePath(
      `${spec.packageSpecifier}/package.json`,
    );
    const candidate = path.join(
      path.dirname(packageJsonPath),
      ...spec.binaryRelativePath,
    );
    return fileExists(candidate) ? candidate : null;
  } catch {
    try {
      const packageRootExportPath = resolvePackagePath(spec.packageSpecifier);
      return resolveBinaryFromPackageRootExport(
        packageRootExportPath,
        spec.binaryRelativePath,
        fileExists,
      );
    } catch {
      return null;
    }
  }
}
