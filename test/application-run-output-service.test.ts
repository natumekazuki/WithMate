import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  ApplicationRunOutputService,
  type ApplicationRunOutputServiceOptions,
} from "../src/main/application-run-output-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type {
  RunOutputExporterPort,
  RunOutputExportWriter,
  RunOutputPublicationOutcome,
} from "../src/main/run-output-exporter.js";
import type {
  ApplicationRunOutputAccessValidator,
  ApplicationRunOutputChunk,
} from "../src/shared/application-run-output-model.js";

type Authorization = Readonly<{ principal: string }>;
type Reads = ApplicationRunOutputServiceOptions<Authorization>["reads"];
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Assert<TValue extends true> = TValue;
type _NonEofChunkRequiresNextOffset = Assert<
  Equal<Extract<ApplicationRunOutputChunk, Readonly<{ eof: false }>>["nextOffset"], number>
>;
type _EofChunkCannotCarryNextOffset = Assert<
  Equal<Extract<ApplicationRunOutputChunk, Readonly<{ eof: true }>>["nextOffset"], undefined>
>;

const authorization: Authorization = { principal: "owner" };

test("chunk public type couples EOF with next-offset presence", () => {
  const contract = null as _NonEofChunkRequiresNextOffset | _EofChunkCannotCarryNextOffset | null;
  assert.equal(contract, null);
});

test("output counts authorize the Run collection and fill every public category with a stable zero", async () => {
  const targets: unknown[] = [];
  const service = createService({
    access: allowAccess(targets),
    reads: reads({
      runOutputCounts: async () => ({
        sessionId: "session-1",
        runId: "run-1",
        workspaceKey: "workspace-1",
        totalCount: 4,
        partialCount: 1,
        byCategory: { operation: 3, diagnostic: 1 },
      }),
    }),
  });

  const response = await service.outputCounts(request());

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.value, {
      sessionId: "session-1",
      runId: "run-1",
      totalCount: 4,
      partialCount: 1,
      byCategory: {
        assistant_detail: 0,
        operation: 3,
        interaction: 0,
        telemetry: 0,
        diagnostic: 1,
        provider_metadata: 0,
      },
    });
    assert.equal(Object.hasOwn(response.value, "workspaceKey"), false);
  }
  assert.deepEqual(targets, [
    {
      operation: "output_counts",
      access: "read",
      context: { authorization },
      target: { kind: "run_outputs", sessionId: "session-1", runId: "run-1" },
    },
  ]);
});

test("authorization rejection prevents every Run output Repository call", async () => {
  const calls: string[] = [];
  const service = createService({
    access: {
      async authorize() {
        calls.push("authorize");
        return { allowed: false, error: { code: "forbidden", message: "denied", retryable: false } };
      },
    },
    reads: reads({
      sessionGet: async () => {
        calls.push("sessionGet");
        return sessionProjection();
      },
      runOutputCounts: async () => {
        calls.push("counts");
        return countsProjection();
      },
      runOutputsPage: async () => {
        calls.push("outputs");
        return pageProjection();
      },
    }),
  });

  const counts = await service.outputCounts(request());
  const outputs = await service.outputs(request());

  for (const response of [counts, outputs]) {
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") assert.equal(response.error.kind, "access");
  }
  assert.deepEqual(calls, ["authorize", "authorize"]);
});

test("Run output timeout and cancellation preserve pre-read versus started-read failure timing", async () => {
  let repositoryCalls = 0;
  const pendingAuthorization = createService({
    access: {
      async authorize() {
        return new Promise(() => undefined);
      },
    },
    reads: reads({
      sessionGet: async () => {
        repositoryCalls += 1;
        return sessionProjection();
      },
    }),
  });
  const beforeRead = await pendingAuthorization.outputCounts(request(), { timeoutMs: 5 });
  assert.equal(beforeRead.overallStatus, "failure");
  if (beforeRead.overallStatus === "failure") {
    assert.equal(beforeRead.error.code, "operation_timeout");
    assert.deepEqual(beforeRead.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(repositoryCalls, 0);

  let sessionReadAborted = false;
  const pendingSessionRead = createService({
    reads: reads({
      sessionGet: async (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              sessionReadAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
  });
  const duringSessionRead = await pendingSessionRead.outputCounts(request(), { timeoutMs: 5 });
  assert.equal(duringSessionRead.overallStatus, "failure");
  if (duringSessionRead.overallStatus === "failure") {
    assert.equal(duringSessionRead.error.code, "persistence_timeout");
    assert.deepEqual(duringSessionRead.persistence, { status: "failed", effect: "none" });
  }
  assert.equal(sessionReadAborted, true);

  const controller = new AbortController();
  let pageReadAborted = false;
  const pendingPageRead = createService({
    reads: reads({
      runOutputsPage: async (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              pageReadAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          controller.abort();
        }),
    }),
  });
  const duringPageRead = await pendingPageRead.outputs(request(), { signal: controller.signal });
  assert.equal(duringPageRead.overallStatus, "failure");
  if (duringPageRead.overallStatus === "failure") {
    assert.equal(duringPageRead.error.code, "persistence_canceled");
    assert.deepEqual(duringPageRead.persistence, { status: "failed", effect: "none" });
  }
  assert.equal(pageReadAborted, true);
});

test("output counts reject unknown categories, unsafe counts, and inconsistent totals", async () => {
  for (const projection of [
    { ...countsProjection(), byCategory: { future_category: 0 } },
    { ...countsProjection(), totalCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...countsProjection(), totalCount: 1, byCategory: { operation: 2 } },
    { ...countsProjection(), partialCount: 1 },
  ]) {
    const service = createService({
      reads: reads({ runOutputCounts: async () => projection as Awaited<ReturnType<Reads["runOutputCounts"]>> }),
    });
    assert.deepEqual(await service.outputCounts(request()), internalReadFailure());
  }
});

test("output pages project every valid payload tuple without exposing raw Repository fields", async () => {
  const targets: unknown[] = [];
  const forwarded: unknown[] = [];
  const rawItems = [
    outputItem("none", 1, { payloadState: "none", redactionState: "not_required" }),
    outputItem("pending-not-required", 2, {
      payloadState: "pending",
      payloadOriginalByteLength: 7,
      redactionState: "not_required",
    }),
    outputItem("pending-redacted", 3, {
      payloadState: "pending",
      payloadOriginalByteLength: 8,
      redactionState: "redacted",
    }),
    outputItem("stored-not-required", 4, {
      payloadState: "stored",
      payloadOriginalByteLength: 9,
      storedPayloadId: "stored-not-required",
      redactionState: "not_required",
    }),
    outputItem("stored-redacted", 5, {
      payloadState: "stored",
      payloadOriginalByteLength: 10,
      storedPayloadId: "stored-redacted",
      redactionState: "redacted",
    }),
    outputItem("size-not-required", 6, {
      payloadState: "omitted_size_limit",
      payloadOriginalByteLength: 11,
      redactionState: "not_required",
    }),
    outputItem("size-redacted", 7, {
      payloadState: "omitted_size_limit",
      payloadOriginalByteLength: 12,
      redactionState: "redacted",
    }),
    outputItem("redaction", 8, {
      payloadState: "omitted_redaction",
      payloadOriginalByteLength: 13,
      redactionState: "unknown",
    }),
    outputItem("persistence-not-required", 9, {
      payloadState: "omitted_persistence",
      payloadOriginalByteLength: 14,
      redactionState: "not_required",
    }),
    outputItem("persistence-redacted", 10, {
      payloadState: "omitted_persistence",
      payloadOriginalByteLength: 15,
      redactionState: "redacted",
    }),
  ];
  const service = createService({
    access: allowAccess(targets),
    reads: reads({
      runOutputsPage: async (input) => {
        forwarded.push(input);
        return pageProjection({ items: rawItems, nextCursor: "v1.next" });
      },
    }),
  });

  const response = await service.outputs({
    ...request(),
    category: "operation",
    cursor: "v1.current",
    limit: 10,
  });

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(
      response.value.items.map(({ availability }) => availability),
      [
        { kind: "none", redaction: "not_required" },
        { kind: "pending", originalByteLength: 7, redaction: "not_required" },
        { kind: "pending", originalByteLength: 8, redaction: "applied" },
        { kind: "stored", originalByteLength: 9, redaction: "not_required" },
        { kind: "stored", originalByteLength: 10, redaction: "applied" },
        { kind: "omitted", reason: "size_limit", originalByteLength: 11, redaction: "not_required" },
        { kind: "omitted", reason: "size_limit", originalByteLength: 12, redaction: "applied" },
        { kind: "omitted", reason: "redaction", originalByteLength: 13, redaction: "undetermined" },
        {
          kind: "omitted",
          reason: "persistence_failure",
          originalByteLength: 14,
          redaction: "not_required",
        },
        { kind: "omitted", reason: "persistence_failure", originalByteLength: 15, redaction: "applied" },
      ],
    );
    assert.equal(response.value.nextCursor, "v1.next");
    const serialized = JSON.stringify(response);
    for (const privateValue of ["storedPayloadId", "payloadState", "redactionState", "workspace-1"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }
  assert.deepEqual(targets, [
    {
      operation: "outputs",
      access: "read",
      context: { authorization },
      target: {
        kind: "run_outputs",
        sessionId: "session-1",
        runId: "run-1",
        category: "operation",
      },
    },
  ]);
  assert.deepEqual(forwarded, [
    {
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace-1",
      category: "operation",
      cursor: "v1.current",
      limit: 10,
    },
  ]);
});

test("output page omissions become bounded partial-success issues and preserve continuation", async () => {
  const service = createService({
    reads: reads({
      runOutputsPage: async () =>
        pageProjection({
          items: [
            { omitted: true, reason: "response_size_limit", ordinal: 1 },
            outputItem("second", 2, { payloadState: "none", redactionState: "not_required" }),
          ],
          nextCursor: "v1.next",
        }),
    }),
  });

  const response = await service.outputs(request());

  assert.equal(response.overallStatus, "partial_success");
  if (response.overallStatus === "partial_success") {
    assert.deepEqual(
      response.value.items.map(({ id }) => id),
      ["second"],
    );
    assert.equal(response.value.nextCursor, "v1.next");
    assert.deepEqual(response.issues, [
      {
        kind: "omission",
        code: "response_size_limit",
        message: "Run output was omitted because the response size limit was reached.",
        ordinal: 1,
      },
    ]);
  }
});

test("output page rejects invalid public requests and Repository projection scope or category mismatches", async () => {
  let authorizationCalls = 0;
  const invalidRequestService = createService({
    access: {
      async authorize() {
        authorizationCalls += 1;
        return { allowed: true };
      },
    },
  });
  for (const invalid of [
    { ...request(), category: "future" },
    { ...request(), cursor: "x".repeat(2_049) },
    { ...request(), limit: 0 },
    { ...request(), limit: 201 },
    { ...request(), extra: true },
  ]) {
    const response = await invalidRequestService.outputs(invalid as never);
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") assert.equal(response.error.kind, "request");
  }
  assert.equal(authorizationCalls, 0);

  const sessionMismatch = createService({
    reads: reads({ sessionGet: async () => sessionProjection("other-session") }),
  });
  assert.deepEqual(await sessionMismatch.outputs(request()), internalReadFailure());

  for (const page of [
    pageProjection({ workspaceKey: "other" }),
    pageProjection({
      items: [
        outputItem("wrong-category", 1, {
          category: "diagnostic",
          payloadState: "none",
          redactionState: "not_required",
        }),
      ],
    }),
    pageProjection({
      items: [
        outputItem("bad-tuple", 1, {
          payloadState: "stored",
          payloadOriginalByteLength: 1,
          redactionState: "unknown",
        }),
      ],
    }),
  ]) {
    const service = createService({ reads: reads({ runOutputsPage: async () => page }) });
    const response = await service.outputs({ ...request(), category: "operation" });
    assert.deepEqual(response, internalReadFailure());
  }
});

test("Run output Repository not_found remains a non-enumerating domain rejection", async () => {
  const service = createService({
    reads: reads({
      runOutputCounts: async () => {
        throw new PersistenceClientError({ code: "not_found", message: "not found", retryable: false, effect: "none" });
      },
    }),
  });
  const response = await service.outputCounts(request());
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.deepEqual(response.error, {
      kind: "domain",
      code: "not_found",
      message: "not found",
      retryable: false,
    });
    assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });
  }
});

test("preview maps every non-stored state to a typed unavailable reason without reading metadata or payload", async () => {
  const cases = [
    [{ payloadState: "none", redactionState: "not_required" }, "no_payload", false],
    [{ payloadState: "pending", payloadOriginalByteLength: 1, redactionState: "not_required" }, "pending", true],
    [
      { payloadState: "omitted_size_limit", payloadOriginalByteLength: 2, redactionState: "redacted" },
      "size_limit",
      false,
    ],
    [
      { payloadState: "omitted_redaction", payloadOriginalByteLength: 3, redactionState: "unknown" },
      "redaction",
      false,
    ],
    [
      { payloadState: "omitted_persistence", payloadOriginalByteLength: 4, redactionState: "not_required" },
      "persistence_failure",
      false,
    ],
  ] as const;
  for (const [payload, reason, retryable] of cases) {
    let metadataReads = 0;
    let payloadReads = 0;
    const service = createService({
      reads: reads({
        runOutputGet: async () => pointOutputProjection(payload),
        runOutputPayloadMetadata: async () => {
          metadataReads += 1;
          return metadataProjection();
        },
        payloadChunk: async () => {
          payloadReads += 1;
          return chunkProjection();
        },
      }),
    });
    const response = await service.outputPreview({ ...request(), outputItemId: "output-1" });
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") {
      assert.deepEqual(response.error, {
        kind: "domain",
        code: "payload_unavailable",
        message: "Run output payload is unavailable.",
        retryable,
        details: { reason },
      });
    }
    assert.equal(metadataReads, 0);
    assert.equal(payloadReads, 0);
  }
});

test("stored metadata absence is an internal persistence inconsistency, while unknown items stay not_found", async () => {
  const missingMetadata = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => {
        throw new PersistenceClientError({ code: "not_found", message: "missing", retryable: false, effect: "none" });
      },
    }),
  });
  assert.deepEqual(
    await missingMetadata.outputPreview({ ...request(), outputItemId: "output-1" }),
    internalReadFailure(),
  );

  const unknownItem = createService({
    reads: reads({
      runOutputGet: async () => {
        throw new PersistenceClientError({ code: "not_found", message: "not found", retryable: false, effect: "none" });
      },
    }),
  });
  const response = await unknownItem.outputPreview({ ...request(), outputItemId: "unknown" });
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.kind, "domain");
    assert.equal(response.error.code, "not_found");
  }
});

test("binary preview returns strict metadata without reading payload bytes", async () => {
  const targets: unknown[] = [];
  let payloadReads = 0;
  const service = createService({
    access: allowAccess(targets),
    reads: reads({
      runOutputPayloadMetadata: async () =>
        metadataProjection({
          payloadFormat: "binary",
          mediaType: "application/octet-stream",
          byteLength: 12,
          contentSha256: "a".repeat(64),
        }),
      payloadChunk: async () => {
        payloadReads += 1;
        return chunkProjection();
      },
    }),
  });
  const response = await service.outputPreview({ ...request(), outputItemId: "output-1" });
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.value, {
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      format: "binary",
      mediaType: "application/octet-stream",
      storedByteLength: 12,
      contentSha256: "a".repeat(64),
    });
    assert.equal(Object.hasOwn(response.value, "preview"), false);
  }
  assert.equal(payloadReads, 0);
  assert.deepEqual(targets[0], {
    operation: "output_preview",
    access: "read",
    context: { authorization },
    target: {
      kind: "run_output_payload",
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      maxBytes: 64 * 1_024,
    },
  });
});

test("text and JSON preview preserve source bytes, buffer an incomplete UTF-8 suffix, and reject invalid UTF-8", async () => {
  const utf8 = Buffer.from("A😀B", "utf8");
  const splitMultibyte = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ byteLength: utf8.byteLength }),
      payloadChunk: async () =>
        chunkProjection({ bytes: utf8.subarray(0, 3), totalBytes: utf8.byteLength, eof: false }),
    }),
  });
  const split = await splitMultibyte.outputPreview({ ...request(), outputItemId: "output-1", maxBytes: 3 });
  assert.equal(split.overallStatus, "success");
  if (split.overallStatus === "success" && split.value.format !== "binary") {
    assert.equal(split.value.preview, "A");
    assert.equal(split.value.previewByteLength, 1);
    assert.equal(split.value.storedByteLength, utf8.byteLength);
    assert.equal(split.value.truncated, true);
  }

  const workerClamped = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ byteLength: 5 }),
      payloadChunk: async () => chunkProjection({ bytes: Buffer.from("he"), totalBytes: 5, eof: false }),
    }),
  });
  const clampedPreview = await workerClamped.outputPreview({
    ...request(),
    outputItemId: "output-1",
    maxBytes: 64 * 1_024,
  });
  assert.equal(clampedPreview.overallStatus, "success");
  if (clampedPreview.overallStatus === "success" && clampedPreview.value.format !== "binary") {
    assert.equal(clampedPreview.value.preview, "he");
    assert.equal(clampedPreview.value.previewByteLength, 2);
    assert.equal(clampedPreview.value.truncated, true);
  }

  const jsonSource = '{\n  "text": "\\u305d\\u306eまま",\n  "number": 1.0\n}\n';
  const jsonBytes = Buffer.from(jsonSource, "utf8");
  const json = createService({
    reads: reads({
      runOutputPayloadMetadata: async () =>
        metadataProjection({ payloadFormat: "json", mediaType: "application/json", byteLength: jsonBytes.byteLength }),
      payloadChunk: async () => chunkProjection({ bytes: jsonBytes, totalBytes: jsonBytes.byteLength, eof: true }),
    }),
  });
  const jsonResponse = await json.outputPreview({ ...request(), outputItemId: "output-1" });
  assert.equal(jsonResponse.overallStatus, "success");
  if (jsonResponse.overallStatus === "success" && jsonResponse.value.format === "json") {
    assert.equal(jsonResponse.value.preview, jsonSource);
    assert.equal(jsonResponse.value.previewByteLength, jsonBytes.byteLength);
    assert.equal(jsonResponse.value.truncated, false);
  }

  const invalid = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ byteLength: 1 }),
      payloadChunk: async () => chunkProjection({ bytes: Uint8Array.of(0xff), totalBytes: 1, eof: true }),
    }),
  });
  assert.deepEqual(await invalid.outputPreview({ ...request(), outputItemId: "output-1" }), internalReadFailure());
});

test("text chunk advances by actual Worker bytes and rejects zero progress or inconsistent metadata", async () => {
  const bytes = Uint8Array.of(1, 2, 3);
  const clamped = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ byteLength: 10 }),
      payloadChunk: async () => chunkProjection({ bytes, offset: 2, totalBytes: 10, eof: false }),
    }),
  });
  const response = await clamped.outputChunk({
    ...request(),
    outputItemId: "output-1",
    offset: 2,
    maxBytes: 256 * 1_024,
  });
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.offset, 2);
    assert.equal(response.value.byteLength, 3);
    assert.equal(response.value.nextOffset, 5);
    assert.equal(response.value.eof, false);
    assert.deepEqual([...new Uint8Array(response.value.bytes)], [1, 2, 3]);
  }

  const atEof = createService({
    reads: reads({
      payloadChunk: async () => chunkProjection({ bytes: new Uint8Array(), offset: 5, totalBytes: 5, eof: true }),
    }),
  });
  const eofResponse = await atEof.outputChunk({ ...request(), outputItemId: "output-1", offset: 5 });
  assert.equal(eofResponse.overallStatus, "success");
  if (eofResponse.overallStatus === "success") {
    assert.equal(eofResponse.value.eof, true);
    assert.equal(Object.hasOwn(eofResponse.value, "nextOffset"), false);
  }

  for (const chunk of [
    chunkProjection({ bytes: new Uint8Array(), offset: 2, totalBytes: 10, eof: false }),
    chunkProjection({ bytes, offset: 2, totalBytes: 9, eof: false }),
    chunkProjection({ bytes, offset: 2, totalBytes: 10, eof: true }),
  ]) {
    const service = createService({
      reads: reads({
        runOutputPayloadMetadata: async () => metadataProjection({ byteLength: 10 }),
        payloadChunk: async () => chunk,
      }),
    });
    assert.deepEqual(
      await service.outputChunk({ ...request(), outputItemId: "output-1", offset: 2 }),
      internalReadFailure(),
    );
  }
});

test("binary chunk is a typed export-only error and never reads payload bytes", async () => {
  let payloadReads = 0;
  const service = createService({
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ payloadFormat: "binary" }),
      payloadChunk: async () => {
        payloadReads += 1;
        return chunkProjection();
      },
    }),
  });
  const response = await service.outputChunk({ ...request(), outputItemId: "output-1", offset: 0 });
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.deepEqual(response.error, {
      kind: "domain",
      code: "payload_format_unsupported",
      message: "Binary Run output payloads must be exported.",
      retryable: false,
      details: { format: "binary", supportedAction: "export" },
    });
  }
  assert.equal(payloadReads, 0);
});

test("preview and chunk validate ranges before authorization and authorization rejection performs no Repository read", async () => {
  let authorizationCalls = 0;
  const service = createService({
    access: {
      async authorize() {
        authorizationCalls += 1;
        return { allowed: true };
      },
    },
  });
  for (const invoke of [
    () => service.outputPreview({ ...request(), outputItemId: "output-1", maxBytes: 64 * 1_024 + 1 }),
    () => service.outputPreview({ ...request(), outputItemId: "output-1", maxBytes: 0 }),
    () => service.outputChunk({ ...request(), outputItemId: "output-1", offset: -1 }),
    () => service.outputChunk({ ...request(), outputItemId: "output-1", offset: 0, maxBytes: 256 * 1_024 + 1 }),
    () => service.outputChunk({ ...request(), outputItemId: "output-1" } as never),
  ]) {
    const response = await invoke();
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") assert.equal(response.error.kind, "request");
  }
  assert.equal(authorizationCalls, 0);

  const calls: string[] = [];
  const denied = createService({
    access: {
      async authorize() {
        calls.push("authorize");
        return { allowed: false, error: { code: "forbidden", message: "denied", retryable: false } };
      },
    },
    reads: reads({
      sessionGet: async () => {
        calls.push("session");
        return sessionProjection();
      },
      runOutputGet: async () => {
        calls.push("point");
        return pointOutputProjection();
      },
    }),
  });
  await denied.outputPreview({ ...request(), outputItemId: "output-1" });
  await denied.outputChunk({ ...request(), outputItemId: "output-1", offset: 0 });
  assert.deepEqual(calls, ["authorize", "authorize"]);
});

test("timeout during preview payload read aborts the Worker request and stays a started-read failure", async () => {
  let aborted = false;
  const service = createService({
    reads: reads({
      payloadChunk: async (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
  });
  const response = await service.outputPreview({ ...request(), outputItemId: "output-1" }, { timeoutMs: 5 });
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "persistence_timeout");
    assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
  }
  assert.equal(aborted, true);
});

test("export authorizes the explicit destination and streams actual chunks sequentially without exposing the path", async () => {
  const content = Buffer.from("abcdef", "utf8");
  const writes: Uint8Array[] = [];
  const offsets: number[] = [];
  const targets: unknown[] = [];
  const writer: RunOutputExportWriter = {
    async write(bytes) {
      writes.push(Uint8Array.from(new Uint8Array(bytes)));
    },
    async finish() {
      return { status: "published", cleanupPending: false };
    },
    async abort() {
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    },
  };
  const destinationGrant = grant();
  const exporter: RunOutputExporterPort = {
    async prepare(receivedGrant, expected) {
      assert.deepEqual(receivedGrant, destinationGrant);
      assert.deepEqual(expected, {
        byteLength: content.byteLength,
        contentSha256: createHash("sha256").update(content).digest("hex"),
      });
      return { status: "ready", writer };
    },
  };
  const service = createService({
    access: allowAccess(targets),
    exporter,
    reads: reads({
      runOutputPayloadMetadata: async () =>
        metadataProjection({
          payloadFormat: "binary",
          byteLength: content.byteLength,
          contentSha256: createHash("sha256").update(content).digest("hex"),
        }),
      payloadChunk: async (input) => {
        offsets.push(input.offset);
        const bytes = input.offset === 0 ? content.subarray(0, 2) : content.subarray(2);
        return chunkProjection({
          bytes,
          offset: input.offset,
          totalBytes: content.byteLength,
          eof: input.offset !== 0,
        });
      },
    }),
  });

  const response = await service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant });

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.publication, { status: "published" });
    assert.equal(response.value.format, "binary");
    assert.equal(JSON.stringify(response).includes(destinationGrant.absolutePath), false);
  }
  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(Buffer.concat(writes.map((bytes) => Buffer.from(bytes))), content);
  assert.deepEqual(targets[0], {
    operation: "output_export",
    access: "write",
    context: { authorization },
    target: {
      kind: "run_output_export",
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      destinationGrant,
    },
  });
});

test("export rejects invalid grants and authorization before every Repository and filesystem effect", async () => {
  let authorizationCalls = 0;
  let prepareCalls = 0;
  const exporter: RunOutputExporterPort = {
    async prepare() {
      prepareCalls += 1;
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    },
  };
  const invalid = createService({
    exporter,
    access: {
      async authorize() {
        authorizationCalls += 1;
        return { allowed: true };
      },
    },
  });
  const invalidResponse = await invalid.outputExport({
    ...request(),
    outputItemId: "output-1",
    destinationGrant: { ...grant(), absolutePath: "relative.bin" },
  });
  assert.equal(invalidResponse.overallStatus, "failure");
  assert.deepEqual(invalidResponse.publication, { status: "not_published", temporaryCleanup: "complete" });
  assert.equal(authorizationCalls, 0);
  assert.equal(prepareCalls, 0);

  const calls: string[] = [];
  const denied = createService({
    exporter,
    access: {
      async authorize() {
        calls.push("authorize");
        return { allowed: false, error: { code: "forbidden", message: "denied", retryable: false } };
      },
    },
    reads: reads({
      sessionGet: async () => {
        calls.push("repository");
        return sessionProjection();
      },
    }),
  });
  await denied.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });
  assert.deepEqual(calls, ["authorize"]);
  assert.equal(prepareCalls, 0);
});

test("export preserves no-clobber, integrity, publication-unknown, and post-publish cleanup timing", async () => {
  for (const [outcome, expected] of [
    [
      { status: "not_published", code: "destination_exists", temporaryCleanup: "complete" },
      { status: "failure", code: "destination_exists", publication: "not_published" },
    ],
    [
      { status: "not_published", code: "integrity_mismatch", temporaryCleanup: "complete" },
      { status: "failure", code: "payload_integrity_mismatch", publication: "not_published" },
    ],
    [{ status: "unknown" }, { status: "failure", code: "internal_error", publication: "unknown" }],
    [
      { status: "published", cleanupPending: true },
      { status: "partial_success", publication: "published" },
    ],
  ] as const) {
    let payloadReads = 0;
    const writer: RunOutputExportWriter = {
      async write() {},
      async finish() {
        return outcome as RunOutputPublicationOutcome;
      },
      async abort() {
        return outcome as RunOutputPublicationOutcome;
      },
    };
    const exporter: RunOutputExporterPort = {
      async prepare() {
        return outcome.status === "not_published" && outcome.code === "destination_exists"
          ? outcome
          : { status: "ready", writer };
      },
    };
    const service = createService({
      exporter,
      reads: reads({
        payloadChunk: async () => {
          payloadReads += 1;
          return chunkProjection();
        },
      }),
    });
    const response = await service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });
    assert.equal(response.overallStatus, expected.status);
    assert.equal(response.publication.status, expected.publication);
    assert.deepEqual(response.persistence, { status: "read", effect: "none" });
    if (response.overallStatus === "failure") assert.equal(response.error.code, expected.code);
    if (outcome.status === "not_published" && outcome.code === "destination_exists") {
      assert.equal(payloadReads, 0);
    }
  }
});

test("export aborts and reports cleanup state after chunk or writer failure", async () => {
  let aborts = 0;
  const writer: RunOutputExportWriter = {
    async write() {
      throw new Error("private path detail");
    },
    async finish() {
      assert.fail("finish must not run after write failure");
    },
    async abort() {
      aborts += 1;
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    },
  };
  const service = createService({
    exporter: {
      async prepare() {
        return { status: "ready", writer };
      },
    },
  });
  const response = await service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });
  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.publication, { status: "not_published", temporaryCleanup: "complete" });
  assert.equal(JSON.stringify(response).includes("private path detail"), false);
  assert.equal(aborts, 1);
});

test("export never reports a failed operation as published when abort returns an impossible outcome", async () => {
  const writer: RunOutputExportWriter = {
    async write() {
      throw new Error("write failed");
    },
    async finish() {
      assert.fail("finish must not run after write failure");
    },
    async abort() {
      return { status: "published", cleanupPending: false };
    },
  };
  const service = createService({
    exporter: {
      async prepare() {
        return { status: "ready", writer };
      },
    },
  });

  const response = await service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
});

test("export timeout interrupts a never-settling cleanup after an earlier writer failure", async () => {
  let aborts = 0;
  const writer: RunOutputExportWriter = {
    async write() {
      throw new Error("write failed");
    },
    async finish() {
      assert.fail("finish must not run after write failure");
    },
    async abort() {
      aborts += 1;
      await new Promise(() => undefined);
      assert.fail("abort must remain unsettled");
    },
  };
  const service = createService({
    exporter: {
      async prepare() {
        return { status: "ready", writer };
      },
    },
  });

  const response = await Promise.race([
    service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() }, { timeoutMs: 20 }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("export cleanup timeout did not settle")), 200),
    ),
  ]);

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") assert.equal(response.error.code, "operation_timeout");
  assert.deepEqual(response.persistence, { status: "read", effect: "none" });
  assert.deepEqual(response.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
  assert.equal(aborts, 1);
});

test("export applies writer backpressure before reading the next bounded chunk", async () => {
  const events: string[] = [];
  let releaseFirstWrite!: () => void;
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writer: RunOutputExportWriter = {
    async write(bytes) {
      events.push(`write:${Buffer.from(bytes).toString("utf8")}`);
      if (events.filter((event) => event.startsWith("write:")).length === 1) {
        markFirstWriteStarted();
        await firstWriteGate;
      }
    },
    async finish() {
      events.push("finish");
      return { status: "published", cleanupPending: false };
    },
    async abort() {
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    },
  };
  const service = createService({
    exporter: {
      async prepare() {
        return { status: "ready", writer };
      },
    },
    reads: reads({
      runOutputPayloadMetadata: async () => metadataProjection({ byteLength: 4 }),
      payloadChunk: async (input) => {
        events.push(`read:${input.offset}`);
        return input.offset === 0
          ? chunkProjection({ bytes: Buffer.from("ab"), totalBytes: 4, eof: false })
          : chunkProjection({ bytes: Buffer.from("cd"), offset: 2, totalBytes: 4, eof: true });
      },
    }),
  });

  const responsePromise = service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });
  await firstWriteStarted;
  assert.deepEqual(events, ["read:0", "write:ab"]);
  releaseFirstWrite();

  const response = await responsePromise;
  assert.equal(response.overallStatus, "success");
  assert.deepEqual(events, ["read:0", "write:ab", "read:2", "write:cd", "finish"]);
});

test("export publishes an empty stored payload without issuing a writer write", async () => {
  let writes = 0;
  const writer: RunOutputExportWriter = {
    async write() {
      writes += 1;
    },
    async finish() {
      return { status: "published", cleanupPending: false };
    },
    async abort() {
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    },
  };
  const service = createService({
    exporter: {
      async prepare(_grant, receivedExpected) {
        assert.deepEqual(receivedExpected, {
          byteLength: 0,
          contentSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        });
        return { status: "ready", writer };
      },
    },
    reads: reads({
      runOutputPayloadMetadata: async () =>
        metadataProjection({
          byteLength: 0,
          contentSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        }),
      payloadChunk: async () => chunkProjection({ bytes: Buffer.alloc(0), totalBytes: 0, eof: true }),
    }),
  });

  const response = await service.outputExport({ ...request(), outputItemId: "output-1", destinationGrant: grant() });
  assert.equal(response.overallStatus, "success");
  assert.equal(writes, 0);
});

test("export cancellation after filesystem preparation settles without waiting for adapter cleanup", async () => {
  const controller = new AbortController();
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });
  let aborts = 0;
  const writer: RunOutputExportWriter = {
    async write() {
      markWriteStarted();
      await new Promise(() => undefined);
    },
    async finish() {
      assert.fail("finish must not run after cancellation");
    },
    async abort() {
      aborts += 1;
      await new Promise(() => undefined);
      assert.fail("abort must remain unsettled");
    },
  };
  const service = createService({
    exporter: {
      async prepare() {
        return { status: "ready", writer };
      },
    },
  });

  const responsePromise = service.outputExport(
    { ...request(), outputItemId: "output-1", destinationGrant: grant() },
    { signal: controller.signal },
  );
  await writeStarted;
  controller.abort();
  const response = await Promise.race([
    responsePromise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("export cancellation did not settle")), 100),
    ),
  ]);

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") assert.equal(response.error.code, "operation_canceled");
  assert.deepEqual(response.persistence, { status: "read", effect: "none" });
  assert.deepEqual(response.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
  assert.equal(aborts, 1);
});

test("export deadline takes precedence when the lifecycle signal is also aborted", async (context) => {
  const controller = new AbortController();
  controller.abort();
  let nowCalls = 0;
  context.mock.method(Date, "now", () => (nowCalls++ === 0 ? 1_000 : 1_001));

  const service = createService();
  const response = await service.outputExport(
    { ...request(), outputItemId: "output-1", destinationGrant: grant() },
    { timeoutMs: 1, signal: controller.signal },
  );

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") assert.equal(response.error.code, "operation_timeout");
  assert.deepEqual(response.publication, { status: "not_published", temporaryCleanup: "complete" });
});

test("export prepare timeout or adapter rejection never claims the destination is unpublished", async () => {
  let prepareAborted = false;
  const timedOut = createService({
    exporter: {
      async prepare(_grant, _expected, signal) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              prepareAborted = true;
              reject(new Error("private adapter detail"));
            },
            { once: true },
          );
        });
        assert.fail("prepare must remain interrupted");
      },
    },
  });
  const timeoutResponse = await timedOut.outputExport(
    { ...request(), outputItemId: "output-1", destinationGrant: grant() },
    { timeoutMs: 5 },
  );
  assert.equal(timeoutResponse.overallStatus, "failure");
  if (timeoutResponse.overallStatus === "failure") assert.equal(timeoutResponse.error.code, "operation_timeout");
  assert.deepEqual(timeoutResponse.persistence, { status: "read", effect: "none" });
  assert.deepEqual(timeoutResponse.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
  assert.equal(prepareAborted, true);

  const rejected = createService({
    exporter: {
      async prepare() {
        throw new Error("private adapter detail");
      },
    },
  });
  const rejectionResponse = await rejected.outputExport({
    ...request(),
    outputItemId: "output-1",
    destinationGrant: grant(),
  });
  assert.equal(rejectionResponse.overallStatus, "failure");
  assert.deepEqual(rejectionResponse.persistence, { status: "read", effect: "none" });
  assert.deepEqual(rejectionResponse.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
  assert.equal(JSON.stringify(rejectionResponse).includes("private adapter detail"), false);
});

function createService(
  overrides: Partial<ApplicationRunOutputServiceOptions<Authorization>> = {},
): ApplicationRunOutputService<Authorization> {
  return new ApplicationRunOutputService({
    reads: overrides.reads ?? reads(),
    access: overrides.access ?? allowAccess(),
    snapshotAuthorization(value) {
      if (typeof value !== "object" || value === null || (value as Authorization).principal !== "owner") {
        throw new TypeError("invalid authorization");
      }
      return { principal: "owner" };
    },
    ...(overrides.exporter === undefined ? {} : { exporter: overrides.exporter }),
  });
}

function allowAccess(targets: unknown[] = []): ApplicationRunOutputAccessValidator<Authorization> {
  return {
    async authorize(input) {
      targets.push(input);
      return { allowed: true };
    },
  };
}

function reads(overrides: Partial<Reads> = {}): Reads {
  return {
    sessionGet: overrides.sessionGet ?? (async () => sessionProjection()),
    runOutputCounts: overrides.runOutputCounts ?? (async () => countsProjection()),
    runOutputsPage: overrides.runOutputsPage ?? (async () => pageProjection()),
    runOutputGet: overrides.runOutputGet ?? (async () => pointOutputProjection()),
    runOutputPayloadMetadata: overrides.runOutputPayloadMetadata ?? (async () => metadataProjection()),
    payloadChunk: overrides.payloadChunk ?? (async () => chunkProjection()),
  };
}

function request() {
  return { context: { authorization }, sessionId: "session-1", runId: "run-1" } as const;
}

function grant() {
  return {
    kind: "explicit_absolute_path",
    authority: "cli_user_selection",
    absolutePath: path.resolve("output.bin"),
  } as const;
}

function sessionProjection(sessionId = "session-1") {
  return {
    session: {
      id: sessionId,
      workspaceKey: "workspace-1",
      title: "Session",
      providerId: "codex",
      workspacePath: "C:\\workspace",
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: 2,
      allowedAdditionalDirectoriesState: "inline" as const,
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 1,
      lifecycleStatus: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    },
    execution: { state: "not_started" as const },
  };
}

function countsProjection() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    totalCount: 0,
    partialCount: 0,
    byCategory: {},
  };
}

function pageProjection(
  overrides: Readonly<{
    workspaceKey?: string;
    items?: readonly unknown[];
    nextCursor?: string;
  }> = {},
): Awaited<ReturnType<Reads["runOutputsPage"]>> {
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: overrides.workspaceKey ?? "workspace-1",
    items: overrides.items ?? [],
    ...(overrides.nextCursor === undefined ? {} : { nextCursor: overrides.nextCursor }),
  } as Awaited<ReturnType<Reads["runOutputsPage"]>>;
}

function pointOutputProjection(
  payload: Readonly<Record<string, unknown>> = {
    payloadState: "stored",
    payloadOriginalByteLength: 5,
    storedPayloadId: "output-1",
    redactionState: "not_required",
  },
): Awaited<ReturnType<Reads["runOutputGet"]>> {
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    item: outputItem("output-1", 1, payload),
  } as Awaited<ReturnType<Reads["runOutputGet"]>>;
}

function metadataProjection(
  overrides: Partial<Awaited<ReturnType<Reads["runOutputPayloadMetadata"]>>> = {},
): Awaited<ReturnType<Reads["runOutputPayloadMetadata"]>> {
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    outputItemId: "output-1",
    payloadFormat: "text",
    mediaType: "text/plain",
    byteLength: 5,
    contentSha256: "0".repeat(64),
    createdAt: 1,
    ...overrides,
  };
}

function chunkProjection(
  overrides: Readonly<{ bytes?: Uint8Array; offset?: number; totalBytes?: number; eof?: boolean }> = {},
): Awaited<ReturnType<Reads["payloadChunk"]>> {
  const bytes = overrides.bytes ?? Buffer.from("hello");
  const arrayBuffer = Uint8Array.from(bytes).buffer;
  return {
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    offset: overrides.offset ?? 0,
    totalBytes: overrides.totalBytes ?? 5,
    eof: overrides.eof ?? true,
    bytes: arrayBuffer,
  };
}

function outputItem(
  id: string,
  ordinal: number,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id,
    runId: "run-1",
    ordinal,
    category: "operation",
    kind: "command",
    summary: "summary",
    completionState: "complete",
    createdAt: ordinal,
    ...payload,
  };
}

function internalReadFailure() {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "failed", effect: "none" },
  } as const;
}
