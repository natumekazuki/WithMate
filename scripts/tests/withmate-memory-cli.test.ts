import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  discoverWithMateMemoryApi,
  runWithMateMemoryCli,
  WITHMATE_MEMORY_CLI_EXIT_CODES,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../withmate-memory.js";

function createOutputCapture(): { stream: { write(chunk: string): boolean }; lines(): string[]; json(): any } {
  let output = "";
  return {
    stream: {
      write(chunk: string): boolean {
        output += chunk;
        return true;
      },
    },
    lines() {
      return output.trim().split(/\r?\n/).filter(Boolean);
    },
    json() {
      return JSON.parse(output.trim());
    },
  };
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
    assert.equal(
      await discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://192.168.0.20:3456" },
        readFile: async () => {
          throw new Error("missing");
        },
      }),
      null,
    );
    assert.equal(
      await discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1.evil.com:3456" },
      }),
      null,
    );
    assert.equal(
      await discoverWithMateMemoryApi({
        env: { WITHMATE_MEMORY_API_URL: "http://127.evil.com:3456" },
      }),
      null,
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
      }));

      assert.deepEqual(
        await discoverWithMateMemoryApi({ env: {}, discoveryFilePath }),
        { baseUrl: "http://localhost:4567", apiSecret: "discovery-secret" },
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
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:9" },
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
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
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
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), { ok: true });
    assert.deepEqual(requests, [{ url: "http://127.0.0.1:7777/v1/status", method: "GET", body: undefined }]);
  });

  it("discovery/envのapiSecretを内部API headerとして送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
        WITHMATE_MEMORY_API_SECRET: "env-secret",
      },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, headers: init?.headers });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      url: "http://127.0.0.1:7777/v1/status",
      method: "GET",
      headers: { "x-withmate-memory-api-secret": "env-secret" },
    }]);
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
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        assert.equal(String(url), "http://127.0.0.1:7777/v1/search");
        assert.equal(init?.method, "POST");
        assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
    assert.deepEqual(stdout.json(), { schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] });
  });

  it("contextはschemaVersionつきJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["context"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        assert.equal(String(url), "http://127.0.0.1:7777/v1/context");
        assert.equal(init?.method, "POST");
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
          env: { WITHMATE_MEMORY_API_URL: redirectUrl },
          stdout: stdout.stream,
        });

        assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
        assert.equal(stdout.json().error.code, "WITHMATE_NOT_RUNNING");
      });
    });

    assert.equal(destinationRequests, 0);
  });

  it("API errorはレスポンスJSONをそのまま出し、apiErrorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["context"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
      fetch: async () => new Response(JSON.stringify({
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        error: { code: "MEMORY_BINDING_REQUIRED", message: "binding required" },
      }), { status: 401 }),
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_BINDING_REQUIRED");
  });

  it("APIが非JSONを返した場合もstdoutにはJSON errorだけを出す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
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
});
