import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { listSupportedProviderBinaryPackageSpecifiers } from "../src-electron/provider-binary-paths.js";

const repoRoot = process.cwd();
const stageRoot = path.join(repoRoot, "build", "provider-binaries");

async function stagePackage(packageSpecifier: string): Promise<void> {
  const packagePath = path.join(repoRoot, "node_modules", ...packageSpecifier.split("/"));
  const targetPath = path.join(stageRoot, ...packageSpecifier.split("/"));

  try {
    await cp(packagePath, targetPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  for (const packageSpecifier of listSupportedProviderBinaryPackageSpecifiers()) {
    await stagePackage(packageSpecifier);
  }

  console.log("provider binary stage 完了:", path.relative(repoRoot, stageRoot));
}

await main();
