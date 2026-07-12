import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const rules = [
  {
    directory: "main",
    forbidden: ["node:sqlite", "../persistence-worker", "/persistence-worker/"],
  },
  {
    directory: "shared",
    forbidden: ["node:sqlite", "node:worker_threads", "electron", "../main", "../persistence-worker"],
  },
];

function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const violations = [];
for (const rule of rules) {
  const directory = path.join(sourceRoot, rule.directory);
  if (!fs.existsSync(directory)) {
    continue;
  }

  for (const file of listSourceFiles(directory)) {
    const source = fs.readFileSync(file, "utf8");
    for (const forbidden of rule.forbidden) {
      if (source.includes(forbidden)) {
        violations.push(`${path.relative(root, file)} imports forbidden boundary ${JSON.stringify(forbidden)}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("module boundaries: ok");
}
