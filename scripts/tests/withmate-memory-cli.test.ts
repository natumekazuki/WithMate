import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  discoverWithMateMemoryApi,
  runWithMateMemoryCli,
  WITHMATE_MEMORY_CLI_EXIT_CODES,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../withmate-memory.js";
import {
  WITHMATE_MEMORY_BINDING_REFERENCE_ENV,
  WITHMATE_MEMORY_BINDING_REFERENCE_HEADER,
} from "../../src-electron/provider-memory-binding.js";

const TEST_API_SECRET = "test-api-secret";
const TEST_RUNTIME_INSTANCE_ID = "test-runtime";
const TEST_RUNTIME_ENV = {
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
  WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
};

function createOutputCapture(): { stream: { write(chunk: string): boolean }; text(): string; lines(): string[]; json(): any } {
  let output = "";
  return {
    stream: {
      write(chunk: string): boolean {
        output += chunk;
        return true;
      },
    },
    text() {
      return output;
    },
    lines() {
      return output.trim().split(/\r?\n/).filter(Boolean);
    },
    json() {
      return JSON.parse(output.trim());
    },
  };
}

function createStatusChallengeResponse(url: string): Response {
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  return new Response(JSON.stringify({
    ok: true,
    runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
    challenge: {
      nonce,
      hmacSha256: createHmac("sha256", TEST_API_SECRET).update(nonce, "utf8").digest("base64url"),
    },
  }), { status: 200 });
}

function createStdin(value: string): NodeJS.ReadStream {
  return Object.assign(Readable.from([value]), { isTTY: false }) as NodeJS.ReadStream;
}

function isStatusChallengeRequest(url: string): boolean {
  const parsed = new URL(url);
  return parsed.pathname === "/v1/status" && parsed.searchParams.has("nonce");
}

function assertUsageError(error: unknown, messagePattern: RegExp): true {
  assert.equal(typeof error, "object");
  assert.equal((error as { error?: { code?: unknown } }).error?.code, "WITHMATE_MEMORY_CLI_USAGE");
  assert.match(String((error as { error?: { message?: unknown } }).error?.message), messagePattern);
  return true;
}

async function withHttpServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  runner: (baseUrl: string) => T | Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address() as AddressInfo;
    return await runner(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe("withmate-memory CLI", () => {
  it("loopbackの環境変数URLをdiscovery結果として使う", async () => {
    assert.deepEqual(
      await discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:3456/" },
        readFile: async () => {
          throw new Error("should not read discovery file");
        },
      }),
      { baseUrl: "http://127.0.0.1:3456" },
    );
    assert.deepEqual(
      await discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://[::1]:3456/" },
      }),
      { baseUrl: "http://[::1]:3456" },
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://192.168.0.20:3456" },
        readFile: async () => {
          throw new Error("should not read discovery file");
        },
      }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1.evil.com:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ env: { WITHMATE_MEMORY_API_URL: "http://127.evil.com:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ env: { WITHMATE_MEMORY_API_URL: "http://127.999.0.1:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
  });

  it("discovery fileからloopback API URLを解決する", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-"));
    const discoveryFilePath = join(tempDirectory, "memory-v6-api.json");
    try {
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://localhost:4567",
        apiSecret: "discovery-secret",
        runtimeInstanceId: "runtime-from-discovery",
      }));

      assert.deepEqual(
        await discoverWithMateMemoryApi({ env: {}, discoveryFilePath }),
        { baseUrl: "http://localhost:4567", apiSecret: "discovery-secret", runtimeInstanceId: "runtime-from-discovery" },
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runtime directoryのdiscovery fileを既定で読む", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-runtime-"));
    try {
      await writeFile(join(tempDirectory, "memory-v6-api.json"), JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:4567",
      }));

      assert.deepEqual(
        await discoverWithMateMemoryApi({
          env: { WITHMATE_MEMORY_RUNTIME_DIR: tempDirectory },
        }),
        { baseUrl: "http://127.0.0.1:4567" },
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("明示された--api-urlが不正な場合はdiscovery fileへfallbackしない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-"));
    const discoveryFilePath = join(tempDirectory, "memory-v6-api.json");
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    try {
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:4567",
      }));

      const exitCode = await runWithMateMemoryCli(["status", "--api-url", "http://example.com", "--discovery-file", discoveryFilePath], {
        env: {},
        stdout: stdout.stream,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.equal(fetchCalls, 0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("WithMate未起動時はDB直読みに逃げずWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: {},
      stdout: stdout.stream,
      readFile: async () => {
        throw new Error("missing discovery file");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
  });

  it("stale discovery endpointへ接続できない場合もWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
  });

  it("stale discovery endpointが応答しない場合はtimeoutしてWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      requestTimeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
  });

  it("statusはGETで/v1/statusへ送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: HeadersInit | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), { ok: true });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:7777\/v1\/status\?nonce=/);
    assert.deepEqual({ method: requests[0].method, body: requests[0].body, headers: requests[0].headers }, {
      method: "GET",
      body: undefined,
      headers: undefined,
    });
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/status",
      method: "GET",
      body: undefined,
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("環境変数URLが不正な場合はdefault discovery fileへfallbackしない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-runtime-"));
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    try {
      await writeFile(join(tempDirectory, "memory-v6-api.json"), JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:4567",
        apiSecret: TEST_API_SECRET,
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
      }));

      const exitCode = await runWithMateMemoryCli(["status"], {
        env: {
          WITHMATE_MEMORY_RUNTIME_DIR: tempDirectory,
          WITHMATE_MEMORY_API_URL: "http://example.com",
        },
        stdout: stdout.stream,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.equal(fetchCalls, 0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("discovery/envのapiSecretを内部API headerとして送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
        WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
      },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/status",
      method: "GET",
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("searchはJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["search", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        assert.equal(String(url), "http://127.0.0.1:7777/v1/search");
        assert.equal(init?.method, "POST");
        assert.deepEqual(init?.headers, {
          "Content-Type": "application/json",
          "x-withmate-memory-api-secret": TEST_API_SECRET,
        });
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
    assert.deepEqual(stdout.json(), { schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] });
  });

  it("schemaはruntime接続なしでCLI capabilitiesを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["schema"], {
      env: {},
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(stdout.json().entryKinds, [
      "decision",
      "constraint",
      "convention",
      "context",
      "deferred",
      "preference",
      "relationship",
      "boundary",
      "note",
    ]);
    assert.deepEqual(stdout.json().forgetReasons, ["user_request", "incorrect", "outdated", "privacy", "other"]);
    assert.deepEqual(stdout.json().requestBodyInputs, ["--json", "--file", "@file", "--stdin"]);
    assert.deepEqual(stdout.json().targetSelectors.at(-1), {
      owner: "user",
      scope: "global",
      requiredFields: [],
    });
  });

  it("--helpはruntime接続なしでusage textを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["--help"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.match(stdout.text(), /Usage:\s+withmate-memory <command> \[options\]/);
    assert.match(stdout.text(), /search --project \. --query/);
    assert.match(stdout.text(), /validate --command <context\|search\|get-entry\|list-tags\|append\|forget>/);
  });

  it("command --helpもruntime接続なしでusage textを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["search", "--help"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.match(stdout.text(), /Commands:/);
    assert.match(stdout.text(), /--stdin/);
  });

  it("validateはrequest bodyをruntimeへ送らずに検証する", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "decision",
      title: "Decision",
      body: "Body",
      preview: "Preview",
      tags: [{ type: "topic", value: "cli" }],
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.equal(stdout.json().valid, true);
    assert.equal(stdout.json().command, "append");
    assert.equal(stdout.json().value.tags[0].canonicalValue, "cli");
  });

  it("validateはuser-global targetを受け付ける", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "user", scope: "global" }],
      query: "global preference",
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "search", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        throw new Error("validate should not call runtime");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(stdout.json().valid, true);
    assert.deepEqual(stdout.json().value.targets, [{ owner: "user", scope: "global" }]);
  });

  it("validateはinvalid requestをJSON errorで返す", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "investigation",
      title: "Decision",
      body: "Body",
      preview: "Preview",
      tags: [],
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_INVALID_FIELD");
    assert.equal(stdout.json().error.field, "kind");
  });

  it("--stdinは明示的に標準入力からrequest bodyを読む", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["search", "--stdin"], {
      env: TEST_RUNTIME_ENV,
      stdin: createStdin(JSON.stringify(requestBody)),
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
  });

  it("@fileは--fileの短縮形としてrequest bodyを読む", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-at-file-"));
    const requestPath = join(tempDirectory, "search.json");
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;
    try {
      await writeFile(requestPath, JSON.stringify(requestBody), "utf8");

      const exitCode = await runWithMateMemoryCli(["search", `@${requestPath}`], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.deepEqual(capturedBody, requestBody);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("search shorthandはprojectとqueryからrequest bodyを作る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-shorthand-"));
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli(["search", "--project", tempDirectory, "--query", "release workflow", "--limit", "3"], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(capturedBody.targets[0].project.path, tempDirectory);
      assert.equal(capturedBody.query, "release workflow");
      assert.equal(capturedBody.limit, 3);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("search shorthandは--tag / --tagsからtagsを作り、query未指定時はtag値をqueryに使う", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-tags-"));
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli([
        "search",
        "--project",
        tempDirectory,
        "--tag",
        "delivery-cleanup",
        "--tags",
        "topic:relaygraph,source:docs",
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.query, "delivery-cleanup relaygraph docs");
      assert.deepEqual(capturedBody.tags, [
        { type: "topic", value: "delivery-cleanup" },
        { type: "topic", value: "relaygraph" },
        { type: "source", value: "docs" },
      ]);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("project.pathの相対pathはCLI起動cwd基準の絶対pathへ正規化して送る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-cwd-"));
    const previousCwd = process.cwd();
    let capturedBody: any = null;
    try {
      process.chdir(tempDirectory);
      const exitCode = await runWithMateMemoryCli(["search", "--json", JSON.stringify({
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: "." } }],
        query: "cli",
      })], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          assert.equal(String(url), "http://127.0.0.1:7777/v1/search");
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.targets[0].project.path, process.cwd());
    } finally {
      process.chdir(previousCwd);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("contextはschemaVersionつきJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    let capturedBody: unknown = null;
    let capturedBindingReference: string | null = null;

    const exitCode = await runWithMateMemoryCli(["context"], {
      env: {
        ...TEST_RUNTIME_ENV,
        [WITHMATE_MEMORY_BINDING_REFERENCE_ENV]: "binding-ref-a",
      },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        assert.equal(String(url), "http://127.0.0.1:7777/v1/context");
        assert.equal(init?.method, "POST");
        capturedBindingReference = new Headers(init?.headers).get(WITHMATE_MEMORY_BINDING_REFERENCE_HEADER);
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          session: { id: "session-a" },
          permissions: [],
        }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
    assert.equal(capturedBindingReference, "binding-ref-a");
  });

  it("POST redirectは追従せずrequest bodyを転送しない", async () => {
    let destinationRequests = 0;

    await withHttpServer((request, response) => {
      destinationRequests += 1;
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, async (destinationUrl) => {
      await withHttpServer((request, response) => {
        request.resume();
        response.writeHead(307, { Location: `${destinationUrl}/leaked` });
        response.end();
      }, async (redirectUrl) => {
        const stdout = createOutputCapture();
        const exitCode = await runWithMateMemoryCli(["append", "--json", JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "redirect",
          body: "redirect body",
          preview: "redirect",
          tags: [],
        })], {
          env: {
            WITHMATE_MEMORY_API_URL: redirectUrl,
            WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
            WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
          },
          stdout: stdout.stream,
        });

        assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
        assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
      });
    });

    assert.equal(destinationRequests, 0);
  });

  it("runtime identityを検証できないport再利用先へmutation bodyやsecretを送らない", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "decision",
      title: "stale",
      body: "must not leak",
      preview: "stale",
      tags: [],
    };
    const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined; body: BodyInit | null | undefined }> = [];

    const exitCode = await runWithMateMemoryCli(["append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
        return new Response(JSON.stringify({
          ok: true,
          runtimeInstanceId: "other-runtime",
          challenge: {
            nonce: new URL(String(url)).searchParams.get("nonce"),
            hmacSha256: "not-the-expected-challenge",
          },
        }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:7777\/v1\/status\?nonce=/);
    assert.deepEqual({
      method: requests[0].method,
      headers: requests[0].headers,
      body: requests[0].body,
    }, {
      method: "GET",
      headers: undefined,
      body: undefined,
    });
  });

  it("API errorはレスポンスJSONをそのまま出し、apiErrorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["context"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          error: { code: "MEMORY_BINDING_REQUIRED", message: "binding required" },
        }), { status: 401 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_BINDING_REQUIRED");
  });

  it("APIが非JSONを返した場合もstdoutにはJSON errorだけを出す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      stderr: createOutputCapture().stream,
      fetch: async () => new Response("<html>not memory api</html>", { status: 200 }),
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.transportError);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_TRANSPORT_ERROR");
  });

  it("invalid JSONはusage errorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--json", "{"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
  });

  it("option value不足はusage errorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--json"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.match(stdout.json().error.message, /--json requires a value/);
  });

  it("unknown commandは現行CLI surfaceを含むusage errorを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["nope"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    const message = stdout.json().error.message;
    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.match(message, /schema\|validate/);
    assert.match(message, /@file/);
    assert.match(message, /--stdin/);
    assert.match(message, /--project/);
    assert.match(message, /--tag/);
  });
});
