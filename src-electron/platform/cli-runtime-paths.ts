import path from "node:path";

import {
  BUNDLED_MEMORY_CLI_PACKAGED_RELATIVE_PATH,
  BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH,
} from "../../src-shared/cli/cli-artifacts.js";

export function resolveBundledMemoryCliScriptPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  currentDir: string;
}): string {
  return input.isPackaged
    ? path.resolve(input.resourcesPath, "..", BUNDLED_MEMORY_CLI_PACKAGED_RELATIVE_PATH)
    : path.resolve(input.currentDir, "../..", BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH);
}
