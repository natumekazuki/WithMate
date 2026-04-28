import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { parseBenchmarkArgs, runDataLoadingBenchmark } from "../benchmark-data-loading.js";

describe("data loading benchmark", () => {
  it("synthetic V2 DB を生成して主要 read path を計測できる", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-data-loading-benchmark-test-"));
    try {
      const result = await runDataLoadingBenchmark({
        outputPath: join(dirPath, "withmate-v2.db"),
        sessions: 2,
        messagesPerSession: 4,
        auditLogsPerSession: 2,
        artifactEvery: 2,
        operationCount: 2,
        rawItemCount: 3,
      });

      assert.equal(result.generated.sessions, 2);
      assert.equal(result.generated.messages, 8);
      assert.equal(result.generated.messageArtifacts, 4);
      assert.equal(result.generated.auditLogs, 4);
      assert.equal(result.generated.auditOperations, 8);
      assert.equal(result.generated.rawItems, 12);
      assert.ok(result.generated.dbBytes > 0);
      assert.equal(result.sample.sessionSummaryCount, 2);
      assert.equal(result.sample.firstSessionMessageCount, 4);
      assert.equal(result.sample.middleSessionMessageCount, 4);
      assert.equal(result.sample.firstAuditPageCount, 2);
      assert.equal(result.sample.firstAuditDetailOperationCount, 2);
      assert.ok(result.timingsMs.generateDatabase >= 0);
      assert.ok(result.timingsMs.listSessionSummaries >= 0);
      assert.ok(result.timingsMs.auditDetailFirstEntry >= 0);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("CLI 引数を benchmark options に変換できる", () => {
    assert.deepEqual(parseBenchmarkArgs([
      "--profile",
      "small",
      "--out",
      "tmp/withmate-v2.db",
      "--overwrite",
      "--sessions",
      "3",
      "--messages",
      "5",
      "--audit-logs",
      "7",
      "--artifact-every",
      "2",
      "--operations",
      "4",
      "--raw-items",
      "6",
    ]), {
      sessions: 3,
      messagesPerSession: 5,
      auditLogsPerSession: 7,
      artifactEvery: 2,
      operationCount: 4,
      rawItemCount: 6,
      outputPath: "tmp/withmate-v2.db",
      keepDatabase: true,
      overwrite: true,
    });
  });
});
