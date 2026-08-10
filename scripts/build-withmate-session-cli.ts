import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";

const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalCliEntryPath = path.join(repositoryRootPath, "scripts", "withmate-session.ts");
const defaultOutputDirectoryPath = path.join(repositoryRootPath, "resources", "cli", "withmate-session");

export const BUNDLED_SESSION_CLI_FILE_NAME = "withmate-session.mjs";

export async function buildWithMateSessionCli(
  outputDirectoryPath = defaultOutputDirectoryPath,
): Promise<string> {
  const resolvedOutputDirectoryPath = path.resolve(outputDirectoryPath);
  await mkdir(resolvedOutputDirectoryPath, { recursive: true });
  await build({
    configFile: false,
    logLevel: "error",
    ssr: { noExternal: true },
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
          banner: "// Generated from scripts/withmate-session.ts. Do not edit directly.",
          codeSplitting: false,
          entryFileNames: BUNDLED_SESSION_CLI_FILE_NAME,
        },
      },
    },
  });
  const outputPath = path.join(resolvedOutputDirectoryPath, BUNDLED_SESSION_CLI_FILE_NAME);
  const generatedSource = await readFile(outputPath, "utf8");
  await writeFile(outputPath, generatedSource.replace(/[ \t]+$/gm, ""), "utf8");
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWithMateSessionCli();
}
