import { existsSync } from "node:fs";
import path from "node:path";

export type SupportedProviderBinary = "codex" | "copilot";

type ProviderBinarySpec = {
  packageSpecifier: string;
  binaryRelativePath: string[];
};

function resolveCodexSpec(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-win32-x64",
          binaryRelativePath: ["vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-win32-arm64",
          binaryRelativePath: ["vendor", "aarch64-pc-windows-msvc", "codex", "codex.exe"],
        };
      }
      return null;
    case "darwin":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-darwin-x64",
          binaryRelativePath: ["vendor", "x86_64-apple-darwin", "codex", "codex"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-darwin-arm64",
          binaryRelativePath: ["vendor", "aarch64-apple-darwin", "codex", "codex"],
        };
      }
      return null;
    case "linux":
      if (arch === "x64") {
        return {
          packageSpecifier: "@openai/codex-linux-x64",
          binaryRelativePath: ["vendor", "x86_64-unknown-linux-musl", "codex", "codex"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@openai/codex-linux-arm64",
          binaryRelativePath: ["vendor", "aarch64-unknown-linux-musl", "codex", "codex"],
        };
      }
      return null;
    default:
      return null;
  }
}

function resolveCopilotSpec(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-win32-x64",
          binaryRelativePath: ["copilot.exe"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-win32-arm64",
          binaryRelativePath: ["copilot.exe"],
        };
      }
      return null;
    case "darwin":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-darwin-x64",
          binaryRelativePath: ["copilot"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-darwin-arm64",
          binaryRelativePath: ["copilot"],
        };
      }
      return null;
    case "linux":
      if (arch === "x64") {
        return {
          packageSpecifier: "@github/copilot-linux-x64",
          binaryRelativePath: ["copilot"],
        };
      }
      if (arch === "arm64") {
        return {
          packageSpecifier: "@github/copilot-linux-arm64",
          binaryRelativePath: ["copilot"],
        };
      }
      return null;
    default:
      return null;
  }
}

export function resolveProviderBinarySpec(
  provider: SupportedProviderBinary,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProviderBinarySpec | null {
  return provider === "codex" ? resolveCodexSpec(platform, arch) : resolveCopilotSpec(platform, arch);
}

export function listSupportedProviderBinaryPackageSpecifiers(): string[] {
  const specs = new Set<string>();
  const providers: SupportedProviderBinary[] = ["codex", "copilot"];
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

function splitScopedPackageSpecifier(packageSpecifier: string): string[] {
  return packageSpecifier.split("/");
}

export function resolvePackagedProviderBinaryPath(
  provider: SupportedProviderBinary,
  resourcesPath: string | undefined = process.resourcesPath,
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
    const packageJsonPath = resolvePackagePath(`${spec.packageSpecifier}/package.json`);
    const candidate = path.join(path.dirname(packageJsonPath), ...spec.binaryRelativePath);
    return fileExists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
