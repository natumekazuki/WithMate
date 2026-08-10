import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import {
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_ADAPTER_HEADER,
  SESSION_RUNTIME_ADAPTER_SECRET_HEADER,
  SESSION_RUNTIME_API_SECRET_HEADER,
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../../src/session-runtime-exchange.js";
import { createSessionRuntimeHttpServer } from "../../src-electron/session-runtime-http-server.js";

const secrets = {
  apiSecret: "api-secret",
  cliSecret: "cli-secret",
  mcpSecret: "mcp-secret",
  runtimeInstanceId: "runtime-1",
};

test("Session runtime authenticates identity and adapter before invoking handler", async () => {
  const calls: string[] = [];
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation, _input, adapter) => {
      calls.push(`${adapter}:${operation}`);
      return createSessionRuntimeResult(operation, { ok: true });
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const unauthorized = await post(address.port, body, {});
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(calls, []);

    const nonce = "nonce-1";
    const authorized = await post(address.port, body, authHeaders("cli", nonce));
    assert.equal(authorized.status, 200);
    assert.deepEqual(calls, ["cli:turn.get"]);

    const wrongAdapter = await post(address.port, body, {
      ...authHeaders("mcp", nonce),
      [SESSION_RUNTIME_ADAPTER_SECRET_HEADER]: secrets.cliSecret,
    });
    assert.equal(wrongAdapter.status, 401);
    assert.deepEqual(calls, ["cli:turn.get"]);
  } finally {
    await server.stop();
  }
});

test("Session runtime rejects a declared body over 8 MiB before handler invocation", async () => {
  let invoked = false;
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation) => {
      invoked = true;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await post(address.port, "{}", {
      ...authHeaders("cli", "nonce-2"),
      "Content-Length": String(SESSION_RUNTIME_MAX_BODY_BYTES + 1),
    }, false);
    assert.equal(response.status, 413);
    assert.equal(invoked, false);
  } finally {
    await server.stop();
  }
});

test("Session runtime status proves the discovered runtime identity", async () => {
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/status?nonce=status-nonce`);
    assert.equal(response.status, 200);
    const result = await response.json() as { runtimeInstanceId: string; challenge: { hmacSha256: string } };
    assert.equal(result.runtimeInstanceId, secrets.runtimeInstanceId);
    assert.equal(
      result.challenge.hmacSha256,
      createSessionRuntimeChallenge(secrets.apiSecret, secrets.runtimeInstanceId, "status-nonce"),
    );
  } finally {
    await server.stop();
  }
});

function authHeaders(adapter: "cli" | "mcp", nonce: string): Record<string, string> {
  return {
    [SESSION_RUNTIME_API_SECRET_HEADER]: secrets.apiSecret,
    [SESSION_RUNTIME_ADAPTER_HEADER]: adapter,
    [SESSION_RUNTIME_ADAPTER_SECRET_HEADER]: adapter === "cli" ? secrets.cliSecret : secrets.mcpSecret,
    [SESSION_RUNTIME_INSTANCE_HEADER]: secrets.runtimeInstanceId,
    [SESSION_RUNTIME_NONCE_HEADER]: nonce,
    [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
      secrets.apiSecret,
      secrets.runtimeInstanceId,
      nonce,
    ),
  };
}

function post(
  port: number,
  body: string,
  headers: Record<string, string>,
  writeBody = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(writeBody ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (writeBody) {
      request.end(body);
    } else {
      request.end();
    }
  });
}
