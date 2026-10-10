import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { parseBenchmarkArgs, runDataLoadingBenchmark } from "../../scripts/benchmarks/benchmark-data-loading.js";

describe("data loading benchmark", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "synthetic V2 DB を生成して主要 read path を計測できる"
  // oracle = { type = "contract", ref = "scripts/benchmarks/benchmark-data-loading.ts" }
  // fault = "生成した通常会話・artifactの件数やpage/read結果が入力規模と一致しない"
  // observable = "generated件数・dbBytes・各read件数・計測時間"
  // observation_boundary = "public-boundary"
  // scope = "integration/data-loading-benchmark"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("synthetic V2 DB を生成して主要 read path を計測できる", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-data-loading-benchmark-test-"));
    try {
      const result = await runDataLoadingBenchmark({
        outputPath: join(dirPath, "withmate-v2.db"),
        sessions: 2,
        messagesPerSession: 4,
        artifactEvery: 2,
        operationCount: 2,
      });

      assert.equal(result.generated.sessions, 2);
      assert.equal(result.generated.messages, 8);
      assert.equal(result.generated.messageArtifacts, 4);
      assert.ok(result.generated.dbBytes > 0);
      assert.equal(result.sample.sessionSummaryCount, 2);
      assert.equal(result.sample.sessionSummaryPageCount, 2);
      assert.equal(result.sample.searchSessionSummaryPageCount, 2);
      assert.equal(result.sample.sessionCharacterUsageCount, 1);
      assert.equal(result.sample.firstSessionMessageCount, 4);
      assert.equal(result.sample.middleSessionMessageCount, 4);
      assert.ok(result.timingsMs.generateDatabase >= 0);
      assert.ok(result.timingsMs.listSessionSummaries >= 0);
      assert.ok(result.timingsMs.listSessionSummaryPage >= 0);
      assert.ok(result.timingsMs.searchSessionSummaryPage >= 0);
      assert.ok(result.timingsMs.listSessionCharacterUsage >= 0);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "CLI 引数を benchmark options に変換できる"
  // oracle = { type = "contract", ref = "scripts/benchmarks/benchmark-data-loading.ts" }
  // fault = "CLI指定を異なるsessions/messages/artifact/operation optionsへ変換する"
  // observable = "parseBenchmarkArgsの戻り値"
  // observation_boundary = "public-boundary"
  // scope = "integration/data-loading-benchmark"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
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
      "--artifact-every",
      "2",
      "--operations",
      "4",
    ]), {
      sessions: 3,
      messagesPerSession: 5,
      artifactEvery: 2,
      operationCount: 4,
      outputPath: "tmp/withmate-v2.db",
      keepDatabase: true,
      overwrite: true,
    });
  });
});
