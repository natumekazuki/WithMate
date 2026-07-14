import { spawnSync } from "node:child_process";

const candidates =
  process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

for (const [command, prefixArguments] of candidates) {
  const result = spawnSync(command, [...prefixArguments, "scripts/validate-sqlite-schema.py"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    continue;
  }

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
  break;
}

if (process.exitCode === undefined) {
  console.error("Python 3 was not found; set up Python before running the SQLite schema validator.");
  process.exitCode = 1;
}
