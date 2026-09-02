import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import {
  BUNDLED_MEMORY_CLI_FILE_NAME,
  buildWithMateMemoryCli,
} from "../build-withmate-memory-cli.js";

const execFileAsync = promisify(execFile);

function unboundHelperEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "",
    [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: "",
    [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV]: "",
  };
}

async function initializeIsolatedMcpServer(helperPath: string, cwd: string): Promise<Record<string, unknown>> {
  const client = new Client({ name: "isolated-layout-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [helperPath, "mcp-server"],
    cwd,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await client.getServerVersion() as unknown as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("withmate-memory bundled helper", () => {
  const helperPath = path.resolve("resources", "cli", "withmate-memory.mjs");

  // @test-value v1
  // kind = "contract"
  // claim = "canonical sourceから再生成したCLI artifactはrepositoryに同梱するartifactと一致する"
  // oracle = { type = "adr", ref = "ADR-024 canonical CLI artifact path" }
  // failure_mode = "配布artifactがcanonical sourceから乖離し、runtimeと異なる契約を公開する"
  // scope = "bundled-memory-cli-artifact"
  // lifecycle = "permanent"
  // @end-test-value
  it("canonical CLI source から生成された current artifact である", async () => {
    const outputDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-cli-build-"));
    try {
      await buildWithMateMemoryCli(outputDirectoryPath);
      assert.equal(
        normalizeLineEndings(await readFile(path.join(outputDirectoryPath, BUNDLED_MEMORY_CLI_FILE_NAME), "utf8")),
        normalizeLineEndings(await readFile(helperPath, "utf8")),
      );
    } finally {
      await rm(outputDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "生成CLI artifactはrepository依存のない配布先でもschemaとMCP initializeを提供する"
  // oracle = { type = "adr", ref = "ADR-024 operator CLI boundary" }
  // failure_mode = "配布artifactがnode_modulesまたはrepository sourceへ暗黙依存して単体起動できない"
  // scope = "bundled-memory-cli-artifact"
  // lifecycle = "permanent"
  // @end-test-value
  it("依存のないisolated directoryでも生成CLIを起動できる", async () => {
    const outputDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-cli-isolated-"));
    try {
      const isolatedHelperPath = await buildWithMateMemoryCli(outputDirectoryPath);
      const source = await readFile(isolatedHelperPath, "utf8");
      assert.doesNotMatch(source, /from\s+["'](?:@modelcontextprotocol\/sdk|zod)["']/);
      const { stdout } = await execFileAsync(process.execPath, [isolatedHelperPath, "schema"], {
        cwd: outputDirectoryPath,
        env: process.env,
      });
      assert.equal(JSON.parse(stdout).commands.includes("mcp-server"), true);
      const initialized = await initializeIsolatedMcpServer(isolatedHelperPath, outputDirectoryPath);
      assert.equal(initialized.name, "withmate-character-context");
    } finally {
      await rm(outputDirectoryPath, { recursive: true, force: true });
    }
  });

// @test-value v1
// kind = "compatibility"
// claim = "生成済みCLIはlegacy discovery runtimeもidentity preflight後に利用できる"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "registry移行後に有効なlegacy runtimeを発見できない、またはchallenge前にoperationを送る"
// scope = "bundled-memory-cli"
// lifecycle = "characterization"
// review_when = "legacy pointer compatibility is removed"
// @end-test-value
it("runtime directory のlegacy discovery pathでidentity検証後にstatusできる", async () => {
    const tempRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-root-"));
    const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
    const runtimeDirectoryPath = path.join(tempRootPath, "withmate-memory", ownerSegment);
    const apiSecret = "test-secret";
    const operatorApiSecret = "test-operator-secret";
    const runtimeInstanceId = "runtime-from-discovery";
    const requestedPaths: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requestedPaths.push(`${request.method ?? "UNKNOWN"} ${url.pathname}${url.search}`);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const nonce = url.searchParams.get("nonce") ?? "";
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          runtimeInstanceId,
          challenge: {
            nonce,
            hmacSha256: createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url"),
          },
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/exchange") {
        const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
        response.writeEarlyHints({
          link: "</v1/exchange>; rel=preconnect",
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeInstanceId,
            typeof nonce === "string" ? nonce : "",
          ),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(payload.apiSecret, apiSecret);
        assert.equal(payload.adapterSecret, operatorApiSecret);
        assert.equal(payload.operation.path, "/v1/status");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          schemaVersion: "withmate-memory-v1",
          status: "ok",
          runtimeInstanceId,
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert(address && typeof address === "object");
      await mkdir(runtimeDirectoryPath, { recursive: true });
      await writeFile(
        path.join(runtimeDirectoryPath, WITHMATE_MEMORY_DISCOVERY_FILE_NAME),
        `${JSON.stringify({
          schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
          adapter: "cli",
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiSecret,
          adapterSecret: operatorApiSecret,
          runtimeInstanceId,
          publishedAt: "2026-08-10T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const { stdout } = await execFileAsync(process.execPath, [helperPath, "status"], {
        env: unboundHelperEnv({
          WITHMATE_MEMORY_RUNTIME_DIR: runtimeDirectoryPath,
          WITHMATE_MEMORY_DISCOVERY_FILE: "",
          WITHMATE_MEMORY_API_URL: "",
        }),
      }).catch((error: unknown) => {
        throw new Error(`Bundled helper requests: ${JSON.stringify(requestedPaths)}`, { cause: error });
      });

      assert.equal(JSON.parse(stdout).runtimeInstanceId, runtimeInstanceId);
    } finally {
      server.close();
      await rm(tempRootPath, { recursive: true, force: true });
    }
  });

// @test-value v1
// kind = "contract"
// claim = "生成済みCLIはruntime不在をcanonical discovery codeで返す"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "配布CLIだけがlegacy not-running codeを正本として返す"
// scope = "bundled-memory-cli"
// lifecycle = "permanent"
// @end-test-value
it("current CLI command namesを受け付け、未起動時はcanonical JSON errorを返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "get-entry",
      "--json",
      '{"schemaVersion":"withmate-memory-v1","entryId":"entry-1","target":{"owner":"project","scope":"project","project":{"type":"id","id":"project-a"}}}',
    ], {
      env: unboundHelperEnv({
        WITHMATE_MEMORY_DISCOVERY_FILE: path.join(tmpdir(), "withmate-memory-missing.json"),
      }),
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

// @test-value v1
// kind = "contract"
// claim = "生成済みCLIは到達不能な明示runtimeをcanonical unavailableへ写像する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "stale endpointをlegacy codeまたは別instance fallbackとして扱う"
// scope = "bundled-memory-cli"
// lifecycle = "permanent"
// @end-test-value
it("stale discovery endpointへ接続できない場合はcanonical unavailableを返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "status",
    ], {
      env: unboundHelperEnv({
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:9",
        WITHMATE_MEMORY_API_SECRET: "stale-secret",
        WITHMATE_MEMORY_OPERATOR_API_SECRET: "stale-operator-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "00000000-0000-4000-8000-000000000002",
      }),
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

// @test-value v1
// kind = "contract"
// claim = "生成済みCLI schemaはmulti-instance operator commandを列挙する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "配布artifactのcapabilityからinstancesが欠落する"
// scope = "bundled-memory-cli"
// lifecycle = "permanent"
// @end-test-value
it("schema は helper 単体で capability を返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "schema"], {
      env: process.env,
    });

    const schema = JSON.parse(stdout);
    assert.deepEqual(schema.commands, [
      "help",
      "instances",
      "status",
      "characters",
      "file-usage",
      "list-targets",
      "list-entries",
      "audit",
      "search",
      "get-entry",
      "get-file",
      "export-files",
      "list-tags",
      "append",
      "forget",
      "move-entry",
      "context-get",
      "affect-appraise",
      "affect-inspect",
      "affect-correct",
      "affect-reset",
      "character-memory-search",
      "character-memory-append-episode",
      "character-memory-correct",
      "character-memory-forget",
      "character-metrics",
      "mcp-server",
      "schema",
      "validate",
    ]);
    assert.deepEqual(schema.requestBodyInputs, ["--json", "--file", "@file", "--stdin"]);
    assert(schema.entryKinds.includes("decision"));
    assert(schema.forgetReasons.includes("user_request"));
  });

  // @test-value v1
  // kind = "contract"
  // claim = "standalone CLIは標準入力からrequest bodyを受け取りcanonical validatorへ渡す"
  // oracle = { type = "contract", ref = "withmate-memory CLI request input contract" }
  // failure_mode = "配布CLIで--stdin入力だけが欠落または別形式へ変換される"
  // scope = "bundled-memory-cli-input"
  // lifecycle = "permanent"
  // @end-test-value
  it("--stdin は standalone helper の process stdin から request body を読む", () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      targets: [
        { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      ],
      query: "release",
      kinds: ["decision"],
      limit: 20,
      cursor: "cursor-a",
    });
    const stdout = execFileSync(process.execPath, [
      helperPath,
      "validate",
      "--command",
      "search",
      "--stdin",
    ], {
      env: process.env,
      input: request,
      encoding: "utf8",
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.deepEqual(response.value.kinds, ["decision"]);
    assert.equal(response.value.limit, 20);
    assert.equal(response.value.cursor, "cursor-a");
  });

  // @test-value v1
  // kind = "contract"
  // claim = "standalone CLIはappend requestのdomain validation errorをcanonical codeとfieldで返す"
  // oracle = { type = "contract", ref = "withmate-memory CLI validation contract" }
  // failure_mode = "配布CLIのvalidatorがinvalid kindを受理するか非canonical errorへ変換する"
  // scope = "bundled-memory-cli-validation"
  // lifecycle = "permanent"
  // @end-test-value
  it("validate は helper 単体で request を検証する", async () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "investigation",
      title: "Invalid",
      body: "Invalid",
      preview: "Invalid",
      tags: [],
    });
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "validate", "--command", "append", "--json", request], {
      env: process.env,
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 3);
      return { stdout: execError.stdout ?? "" };
    });

    const error = JSON.parse(stdout).error;
    assert.equal(error.code, "MEMORY_INVALID_FIELD");
    assert.equal(error.field, "kind");
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "standalone CLI validatorはruntimeと同じunknown field、target、required field制約を拒否する"
  // oracle = { type = "contract", ref = "withmate-memory request validation contract" }
  // failure_mode = "CLIとruntimeのvalidationが分裂し、CLI経由だけ不正requestを受理する"
  // scope = "bundled-memory-cli-validation-parity"
  // lifecycle = "permanent"
  // @end-test-value
  it("validate は helper 側でも runtime validation と同じ失敗ケースを拒否する", async () => {
    const invalidCases = [
      {
        name: "unknown append field",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [],
          extra: true,
        },
        code: "MEMORY_UNKNOWN_FIELD",
        field: "request.extra",
      },
      {
        name: "invalid target shape",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target.project.id",
      },
      {
        name: "empty title",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: " ",
          body: "Body",
          preview: "Preview",
          tags: [],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "title",
      },
      {
        name: "invalid tag object",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [{ type: "Topic", value: "CLI", extra: true }],
        },
        code: "MEMORY_UNKNOWN_FIELD",
        field: "tags[0].extra",
      },
      {
        name: "forget requires target",
        command: "forget",
        request: {
          schemaVersion: "withmate-memory-v1",
          entryIds: ["entry-a"],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target",
      },
      {
        name: "get-entry requires target",
        command: "get-entry",
        request: {
          schemaVersion: "withmate-memory-v1",
          entryId: "entry-a",
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target",
      },
    ];

    for (const testCase of invalidCases) {
      const { stdout } = await execFileAsync(process.execPath, [
        helperPath,
        "validate",
        "--command",
        testCase.command,
        "--json",
        JSON.stringify(testCase.request),
      ], {
        env: process.env,
      }).catch((error: unknown) => {
        const execError = error as { code?: number; stdout?: string };
        assert.equal(execError.code, 3, testCase.name);
        return { stdout: execError.stdout ?? "" };
      });

      const response = JSON.parse(stdout);
      assert.equal(response.error.code, testCase.code, testCase.name);
      assert.equal(response.error.field, testCase.field, testCase.name);
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "standalone CLI validatorはappend requestをruntimeと同じcanonical representationへ正規化する"
  // oracle = { type = "contract", ref = "withmate-memory request normalization contract" }
  // failure_mode = "CLIとruntimeでproject、tag、supersedesの正規化結果が分裂する"
  // scope = "bundled-memory-cli-validation-parity"
  // lifecycle = "permanent"
  // @end-test-value
  it("validate は helper 側でも append request を正規化する", async () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: " project-a " } },
      kind: "decision",
      title: " Title ",
      body: " Body ",
      preview: " Preview ",
      tags: [{ type: "Topic", value: " Release " }, { type: "topic", value: "release" }],
      supersedes: [" entry-a ", "entry-a"],
    });
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "validate", "--command", "append", "--json", request], {
      env: process.env,
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.equal(response.value.target.project.id, "project-a");
    assert.equal(response.value.title, "Title");
    assert.deepEqual(response.value.tags, [{
      type: "Topic",
      value: "Release",
      canonicalType: "topic",
      canonicalValue: "release",
    }]);
    assert.deepEqual(response.value.supersedes, ["entry-a"]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "standalone CLI validatorはprotected object metadataを含むappend requestを保持して受理する"
  // oracle = { type = "contract", ref = "withmate-memory protected object contract" }
  // failure_mode = "CLI artifact移設によりprotected object付きappendだけが拒否または欠落する"
  // scope = "bundled-memory-cli-protected-object"
  // lifecycle = "permanent"
  // @end-test-value
  it("validate は helper 側でも protected object 付き append を受け付ける", async () => {
    const filePath = path.resolve("artifact.bin");
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "context",
      title: "Artifact",
      body: "Artifact context.",
      preview: "Artifact preview.",
      tags: [],
      files: [{
        path: filePath,
        role: "artifact",
        summary: "Generated artifact.",
      }],
    });
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "validate",
      "--command",
      "append",
      "--json",
      request,
    ], {
      env: process.env,
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.deepEqual(response.value.files, [{
      path: filePath,
      role: "artifact",
      summary: "Generated artifact.",
    }]);
  });

// @test-value v1
// kind = "compatibility"
// claim = "生成済みCLIのread shorthandはcanonical discovery failureでも入力構築を維持する"
// oracle = { type = "contract", ref = "withmate-memory CLI shorthand contract" }
// failure_mode = "bundle更新でread shorthandがusageまたはtransport errorへ退行する"
// scope = "bundled-memory-cli"
// lifecycle = "permanent"
// @end-test-value
it("read shorthandはhelperでもrequest bodyを組み立てcanonical unavailableを返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "search", "--project", path.resolve("."), "--query", "cli"], {
      env: unboundHelperEnv({
        WITHMATE_MEMORY_DISCOVERY_FILE: path.join(tmpdir(), "withmate-memory-missing.json"),
      }),
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "配布CLIのusage errorはPATHから呼ぶoperator command形式だけを案内する"
  // oracle = { type = "adr", ref = "ADR-024 operator CLI boundary" }
  // failure_mode = "移設前の内部artifact pathがusageへ露出し、利用者を廃止済み経路へ誘導する"
  // scope = "bundled-memory-cli-usage"
  // lifecycle = "permanent"
  // @end-test-value
  it("usage error は PATH CLI command 形式を案内する", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "nope"], {
      env: process.env,
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 1);
      return { stdout: execError.stdout ?? "" };
    });

    const error = JSON.parse(stdout).error;
    assert.equal(error.code, "WITHMATE_MEMORY_CLI_USAGE");
    assert.match(error.message, /^Usage: withmate-memory /);
    assert.doesNotMatch(error.message, /node bin\/withmate-memory\.mjs/);
  });
});

