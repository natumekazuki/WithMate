import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("src-electron");
const allowed = path.resolve("src-electron/sqlite-connection.ts");
const violations: string[] = [];

function visit(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || path.resolve(entryPath) === allowed) {
      continue;
    }

    for (const [index, line] of readFileSync(entryPath, "utf8").split(/\r?\n/).entries()) {
      if (/^\s*import\b/.test(line) && line.includes("node:sqlite") && !/^\s*import\s+type\b/.test(line)) {
        violations.push(`${path.relative(process.cwd(), entryPath)}:${index + 1}`);
      }
    }
  }
}

visit(root);
if (violations.length > 0) {
  console.error("node:sqlite runtime imports must be limited to src-electron/sqlite-connection.ts:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
}
