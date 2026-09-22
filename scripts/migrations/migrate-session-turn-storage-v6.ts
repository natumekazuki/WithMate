import { createSessionTurnStorageV6DryRunReport, migrateSessionTurnStorageV6 } from "../../src-electron/storage/migrations/migrate-session-turn-storage-v6.js";

const args = process.argv.slice(2);
const index = args.indexOf("--v6");
const databaseFile = index >= 0 ? args[index + 1] : undefined;
if (!databaseFile || (!args.includes("--dry-run") && !args.includes("--write"))) {
  console.error("Usage: npx tsx scripts/migrations/migrate-session-turn-storage-v6.ts (--dry-run | --write) --v6 <path-to-withmate-v6.db>");
  process.exitCode = 1;
} else {
  const report = args.includes("--write")
    ? migrateSessionTurnStorageV6(databaseFile)
    : createSessionTurnStorageV6DryRunReport(databaseFile);
  console.log(JSON.stringify(report, null, 2));
}
