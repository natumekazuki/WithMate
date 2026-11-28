import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  listSupportedProviderBinaryPackageSpecifiers,
  resolveProviderBinarySpec,
  type SupportedProviderBinary,
} from "../../src-electron/providers/provider-binary-paths.js";

const repoRoot = process.cwd();
const stageRoot = path.join(repoRoot, "build", "provider-binaries");

/** インストール済みの配布用パッケージをパッケージ名に対応する梱包先へコピーし、ENOENTだけをスキップする。 */
async function stagePackage(packageSpecifier: string): Promise<void> {
  const packagePath = path.join(
    repoRoot,
    "node_modules",
    ...packageSpecifier.split("/"),
  );
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

/** 実行環境向けの配布バイナリが準備できたか確認し、非対応または未配置なら梱包を止める。 */
function verifyCurrentPlatformBinary(provider: SupportedProviderBinary): void {
  const spec = resolveProviderBinarySpec(provider);
  if (!spec) {
    throw new Error(
      `${provider} の provider binary はこの platform/arch をサポートしていません: ${process.platform}/${process.arch}`,
    );
  }

  const stagedBinaryPath = path.join(
    stageRoot,
    ...spec.packageSpecifier.split("/"),
    ...spec.binaryRelativePath,
  );
  if (existsSync(stagedBinaryPath)) {
    return;
  }

  const sourceBinaryPath = path.join(
    repoRoot,
    "node_modules",
    ...spec.packageSpecifier.split("/"),
    ...spec.binaryRelativePath,
  );
  throw new Error(
    [
      `${provider} の provider binary が見つかりません。`,
      `expected: ${path.relative(repoRoot, stagedBinaryPath)}`,
      `source: ${path.relative(repoRoot, sourceBinaryPath)}`,
      "optional dependencies を含めて npm install し直してから installer を作成してください。",
    ].join("\n"),
  );
}

/** 梱包用ディレクトリを作り直してバイナリを配置し、対応する実行ファイルとライセンスを揃える。 */
async function main(): Promise<void> {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  for (const packageSpecifier of listSupportedProviderBinaryPackageSpecifiers()) {
    await stagePackage(packageSpecifier);
  }

  verifyCurrentPlatformBinary("codex");
  verifyCurrentPlatformBinary("copilot");
  verifyCurrentPlatformBinary("claude");
  verifyCurrentPlatformBinary("opencode");
  await cp(
    path.join(repoRoot, "resources", "provider-licenses", "opencode"),
    path.join(stageRoot, "@opencode", "licenses"),
    { recursive: true },
  );

  console.log(
    "provider binary stage 完了:",
    path.relative(repoRoot, stageRoot),
  );
}

await main();
