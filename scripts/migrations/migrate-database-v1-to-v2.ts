import { createMigrationDryRunReport, createMigrationWriteReport } from "../../src-electron/storage/migrations/migrate-database-v1-to-v2.js";

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/migrations/migrate-database-v1-to-v2.ts --dry-run --v1 <path-to-withmate.db>\n"
      + "       npx tsx scripts/migrations/migrate-database-v1-to-v2.ts --write --v1 <path-to-withmate.db> --v2 <path-to-withmate-v2.db> [--overwrite]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const v1Index = args.findIndex((arg) => arg === "--v1" || arg === "--input");
const v2Index = args.indexOf("--v2");
const v1 = v1Index >= 0 ? args[v1Index + 1] : undefined;
const v2 = v2Index >= 0 ? args[v2Index + 1] : undefined;
const overwrite = args.includes("--overwrite");
if (args.includes("--dry-run") && v1) {
  console.log(JSON.stringify(createMigrationDryRunReport(v1), null, 2));
} else if (args.includes("--write") && v1 && v2) {
  console.log(JSON.stringify(createMigrationWriteReport({ v1DbPath: v1, v2DbPath: v2, overwrite }), null, 2));
} else {
  usage();
}
