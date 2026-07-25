import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";

const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalCliEntryPath = path.join(repositoryRootPath, "scripts", "withmate-memory.ts");
const defaultOutputDirectoryPath = path.join(
  repositoryRootPath,
  "resources",
  "skills",
  "withmate-memory",
  "bin",
);

export const BUNDLED_MEMORY_CLI_FILE_NAME = "withmate-memory.mjs";

export async function buildWithMateMemoryCli(
  outputDirectoryPath = defaultOutputDirectoryPath,
): Promise<string> {
  const resolvedOutputDirectoryPath = path.resolve(outputDirectoryPath);
  await mkdir(resolvedOutputDirectoryPath, { recursive: true });
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      ssr: canonicalCliEntryPath,
      outDir: resolvedOutputDirectoryPath,
      emptyOutDir: false,
      copyPublicDir: false,
      target: "node20",
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          banner: "// Generated from scripts/withmate-memory.ts. Do not edit directly.",
          codeSplitting: false,
          entryFileNames: BUNDLED_MEMORY_CLI_FILE_NAME,
        },
      },
    },
  });
  return path.join(resolvedOutputDirectoryPath, BUNDLED_MEMORY_CLI_FILE_NAME);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWithMateMemoryCli();
}
