import { createMigrationDryRunReport, createMigrationWriteReport } from "../../src-electron/storage/migrations/migrate-database-v4-to-v6.js";

function usage(): never {
  throw new Error(
    "Usage: npx tsx scripts/migrations/migrate-database-v4-to-v6.ts --dry-run --v4 <path-to-withmate-v4.db>\n"
      + "       npx tsx scripts/migrations/migrate-database-v4-to-v6.ts --write --v4 <path-to-withmate-v4.db> --v6 <path-to-withmate-v6.db> [--overwrite]",
  );
}

const args = process.argv.slice(2);
const v4Index = args.indexOf("--v4");
const v6Index = args.indexOf("--v6");
const v4 = v4Index >= 0 ? args[v4Index + 1] : undefined;
const v6 = v6Index >= 0 ? args[v6Index + 1] : undefined;
if (!v4 || (!args.includes("--dry-run") && !v6) || (!args.includes("--dry-run") && !args.includes("--write"))) {
  usage();
}
const report = args.includes("--dry-run")
  ? createMigrationDryRunReport(v4)
  : await createMigrationWriteReport({ sourceDatabaseFile: v4, targetDatabaseFile: v6 ?? "", overwrite: args.includes("--overwrite") });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
