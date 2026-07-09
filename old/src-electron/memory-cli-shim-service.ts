import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryV6CliShimDiagnostics } from "../src/memory-v6/memory-diagnostics-state.js";

const POSIX_MANAGED_MARKER = "# Managed by WithMate Memory CLI shim";
const POSIX_SHIM_FILE_NAME = "withmate-memory";
const POSIX_SHIM_METADATA_FILE_NAME = ".withmate-memory-shim.json";

export type MemoryCliShimServiceDeps = {
  appExecutablePath: string;
  bundledCliScriptPath: string;
  homeDirectory: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
};

export class MemoryCliShimService {
  constructor(private readonly deps: MemoryCliShimServiceDeps) {}

  async getDiagnostics(): Promise<MemoryV6CliShimDiagnostics> {
    const platform = this.resolvePlatform();
    if (platform === "win32") {
      return {
        platform,
        commandName: "withmate-memory",
        supported: false,
        status: "managed-by-installer",
        shimDirectory: null,
        shimPath: null,
        pathContainsShimDirectory: true,
        message: "Windows installer manages the withmate-memory command alias.",
      };
    }

    if (!this.isPosixPlatform(platform)) {
      return {
        platform,
        commandName: "withmate-memory",
        supported: false,
        status: "unsupported",
        shimDirectory: null,
        shimPath: null,
        pathContainsShimDirectory: false,
        message: "Memory CLI shim is not supported on this platform.",
      };
    }

    const shimDirectory = this.resolveShimDirectory();
    const shimPath = path.join(shimDirectory, POSIX_SHIM_FILE_NAME);
    const pathContainsShimDirectory = this.pathContainsDirectory(shimDirectory);

    try {
      const currentScript = await readFile(shimPath, "utf8");
      const expectedScript = this.buildPosixShimScript();
      const managed = await this.hasManagedMetadata();
      if (currentScript !== expectedScript) {
        return {
          platform,
          commandName: "withmate-memory",
          supported: true,
          status: managed ? "stale" : "blocked-existing",
          shimDirectory,
          shimPath,
          pathContainsShimDirectory,
          message: managed
            ? "WithMate CLI shim exists but points to an older app path."
            : "A non-WithMate withmate-memory file already exists at the shim path.",
        };
      }

      if (!managed) {
        return {
          platform,
          commandName: "withmate-memory",
          supported: true,
          status: "blocked-existing",
          shimDirectory,
          shimPath,
          pathContainsShimDirectory,
          message: "A non-WithMate withmate-memory file already exists at the shim path.",
        };
      }

      return {
        platform,
        commandName: "withmate-memory",
        supported: true,
        status: pathContainsShimDirectory ? "installed" : "installed-path-missing",
        shimDirectory,
        shimPath,
        pathContainsShimDirectory,
        message: pathContainsShimDirectory
          ? "withmate-memory is available from the configured shim directory."
          : "withmate-memory shim is installed, but the shim directory is not on PATH.",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          platform,
          commandName: "withmate-memory",
          supported: true,
          status: "failed",
          shimDirectory,
          shimPath,
          pathContainsShimDirectory,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        platform,
        commandName: "withmate-memory",
        supported: true,
        status: "not-installed",
        shimDirectory,
        shimPath,
        pathContainsShimDirectory,
        message: pathContainsShimDirectory
          ? "withmate-memory shim is not installed."
          : "withmate-memory shim is not installed, and ~/.local/bin is not on PATH.",
      };
    }
  }

  async install(): Promise<MemoryV6CliShimDiagnostics> {
    const platform = this.resolvePlatform();
    if (!this.isPosixPlatform(platform)) {
      throw new Error("Memory CLI shim install is only available on macOS and Linux.");
    }

    const shimDirectory = this.resolveShimDirectory();
    const shimPath = path.join(shimDirectory, POSIX_SHIM_FILE_NAME);
    await mkdir(shimDirectory, { recursive: true });

    try {
      await readFile(shimPath, "utf8");
      if (!await this.hasManagedMetadata()) {
        throw new Error("A non-WithMate withmate-memory file already exists at the shim path.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await writeFile(shimPath, this.buildPosixShimScript(), "utf8");
    await writeFile(this.resolveMetadataPath(), `${JSON.stringify({
      managedBy: "WithMate",
      commandName: "withmate-memory",
      version: 1,
    }, null, 2)}\n`, "utf8");
    await chmod(shimPath, 0o755);
    return this.getDiagnostics();
  }

  async uninstall(): Promise<MemoryV6CliShimDiagnostics> {
    const platform = this.resolvePlatform();
    if (!this.isPosixPlatform(platform)) {
      throw new Error("Memory CLI shim uninstall is only available on macOS and Linux.");
    }

    const shimPath = path.join(this.resolveShimDirectory(), POSIX_SHIM_FILE_NAME);
    try {
      await readFile(shimPath, "utf8");
      if (!await this.hasManagedMetadata()) {
        throw new Error("A non-WithMate withmate-memory file exists at the shim path.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.getDiagnostics();
      }
      throw error;
    }

    await rm(shimPath, { force: true });
    await rm(this.resolveMetadataPath(), { force: true });
    return this.getDiagnostics();
  }

  async isPathShimUsable(): Promise<boolean> {
    const diagnostics = await this.getDiagnostics();
    return diagnostics.status === "installed";
  }

  private resolvePlatform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private isPosixPlatform(platform: NodeJS.Platform): boolean {
    return platform === "darwin" || platform === "linux";
  }

  private resolveShimDirectory(): string {
    return path.join(this.deps.homeDirectory, ".local", "bin");
  }

  private resolveMetadataPath(): string {
    return path.join(this.resolveShimDirectory(), POSIX_SHIM_METADATA_FILE_NAME);
  }

  private async hasManagedMetadata(): Promise<boolean> {
    try {
      const raw = await readFile(this.resolveMetadataPath(), "utf8");
      const parsed = JSON.parse(raw) as { managedBy?: unknown; commandName?: unknown; version?: unknown };
      return parsed.managedBy === "WithMate"
        && parsed.commandName === "withmate-memory"
        && parsed.version === 1;
    } catch {
      return false;
    }
  }

  private pathContainsDirectory(directoryPath: string): boolean {
    const normalizedTarget = path.resolve(directoryPath);
    return (this.deps.pathEnv ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .some((entry) => path.resolve(entry) === normalizedTarget);
  }

  private buildPosixShimScript(): string {
    return [
      "#!/bin/sh",
      POSIX_MANAGED_MARKER,
      "export ELECTRON_RUN_AS_NODE=1",
      `exec ${quotePosix(this.deps.appExecutablePath)} ${quotePosix(this.deps.bundledCliScriptPath)} "$@"`,
      "",
    ].join("\n");
  }
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
