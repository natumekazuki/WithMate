import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { rebuild, type RebuildOptions } from "@electron/rebuild";
import { Arch, type Configuration } from "electron-builder";

type BeforePackHook = Exclude<NonNullable<Configuration["beforePack"]>, string>;

export const prepareNativePackaging: BeforePackHook = async (context) => {
  const { packager } = context;
  const useDefaultRebuild = await prepareNativeDependencies({
    appDir: packager.info.appDir,
    electronVersion: packager.config.electronVersion ?? undefined,
    platform: { nodeName: context.electronPlatformName },
    arch: Arch[context.arch],
  });
  // beforeBuild=false also disables dependency collection in electron-builder.
  // Only skip its rebuild after handling the Windows native dependencies here.
  Object.assign(packager.config, { npmRebuild: useDefaultRebuild });
  // electron-builder normalizes package.json's files into FileSet objects.
  // Extend their filters instead of creating an exclusion-only matcher, which
  // would implicitly include the entire repository.
  const exclusion = "!node_modules/node-pty/build/**";
  const fileSets = packager.config.files ?? [];
  for (const fileSet of Array.isArray(fileSets) ? fileSets : [fileSets]) {
    if (typeof fileSet === "string") continue;
    const filters = Array.isArray(fileSet.filter) ? fileSet.filter : [fileSet.filter ?? "**/*"];
    fileSet.filter = filters.filter((filter) => filter !== exclusion);
    if (!useDefaultRebuild) fileSet.filter.push(exclusion);
  }
};

type NativeDependencyContext = {
  appDir: string;
  electronVersion?: string;
  platform: { nodeName: string };
  arch: string;
};

export async function prepareNativeDependencies(
  context: NativeDependencyContext,
  rebuildDependencies: (options: RebuildOptions) => Promise<void> = rebuild,
): Promise<boolean> {
  if (context.platform.nodeName !== "win32") return true;

  const requireFromApp = createRequire(path.join(context.appDir, "package.json"));
  const ptyRoot = path.dirname(requireFromApp.resolve("node-pty/package.json"));
  const prebuildDirectory = path.join(ptyRoot, "prebuilds", `win32-${context.arch}`);
  const requiredFiles = [
    "conpty.node",
    "conpty_console_list.node",
    "pty.node",
    "winpty.dll",
    "winpty-agent.exe",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
  ];
  for (const file of requiredFiles) {
    const target = path.join(prebuildDirectory, file);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`node-pty Windows prebuild is missing or empty: ${target}`);
    }
  }

  const electronVersion = context.electronVersion ?? JSON.parse(
    await readFile(requireFromApp.resolve("electron/package.json"), "utf8"),
  ).version as string;
  console.log(`Using node-pty Windows prebuild: win32-${context.arch}`);
  await rebuildDependencies({
    buildPath: context.appDir,
    projectRootPath: context.appDir,
    electronVersion,
    platform: "win32",
    arch: context.arch,
    mode: "sequential",
    disablePreGypCopy: true,
    ignoreModules: ["node-pty"],
  });
  return false;
}
