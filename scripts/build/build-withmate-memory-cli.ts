import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLED_GLOSSARY_CLI_FILE_NAME,
  BUNDLED_MEMORY_CLI_FILE_NAME,
  BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH,
} from "../../src-shared/cli/cli-artifacts.js";

const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const canonicalCliEntryPath = path.join(repositoryRootPath, "src-cli", "memory", "withmate-memory.ts");
const glossaryCliEntryPath = path.join(repositoryRootPath, "src-cli", "glossary", "withmate-glossary.ts");

const defaultOutputDirectoryPath = path.dirname(path.join(
  repositoryRootPath,
  BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH,
));

async function buildManagedCli(input: {
  entryPath: string;
  outputDirectoryPath: string;
  outputFileName: string;
}): Promise<string> {
  const { build } = await import("vite");
  const resolvedOutputDirectoryPath = path.resolve(input.outputDirectoryPath);
  await mkdir(resolvedOutputDirectoryPath, { recursive: true });
  await build({
    configFile: false,
    logLevel: "error",
    resolve: {
      preserveSymlinks: true,
    },
    ssr: {
      noExternal: true,
    },
    build: {
      ssr: input.entryPath,
      outDir: resolvedOutputDirectoryPath,
      emptyOutDir: false,
      copyPublicDir: false,
      target: "node20",
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          banner: `// Generated from ${path.relative(repositoryRootPath, input.entryPath).replace(/\\/g, "/")}. Do not edit directly.`,
          codeSplitting: false,
          entryFileNames: input.outputFileName,
        },
      },
    },
  });
  const outputPath = path.join(resolvedOutputDirectoryPath, input.outputFileName);
  const generatedSource = await readFile(outputPath, "utf8");
  await writeFile(outputPath, generatedSource.replace(/[ \t]+$/gm, ""), "utf8");
  return outputPath;
}

export async function buildWithMateMemoryCli(
  outputDirectoryPath = defaultOutputDirectoryPath,
): Promise<string> {
  return buildManagedCli({
    entryPath: canonicalCliEntryPath,
    outputDirectoryPath,
    outputFileName: BUNDLED_MEMORY_CLI_FILE_NAME,
  });
}

export async function buildWithMateGlossaryCli(
  outputDirectoryPath = path.join(repositoryRootPath, "resources", "skills", "withmate-glossary", "bin"),
): Promise<string> {
  return buildManagedCli({
    entryPath: glossaryCliEntryPath,
    outputDirectoryPath,
    outputFileName: BUNDLED_GLOSSARY_CLI_FILE_NAME,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Promise.all([buildWithMateMemoryCli(), buildWithMateGlossaryCli()]);
}
