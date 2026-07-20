import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ProcessRunOutputExporter, type RunOutputExportWriter } from "../src/main/run-output-exporter.js";

test("process exporter publishes exact bytes and handles an empty payload without leaving temporary files", async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const [name, content] of [
      ["payload.bin", Buffer.from([0, 1, 2, 255])],
      ["empty.bin", Buffer.alloc(0)],
    ] as const) {
      const destination = path.join(directory, name);
      const writer = await prepareWriter(destination, content);
      if (content.byteLength > 0) await writer.write(exactArrayBuffer(content));

      assert.deepEqual(await writer.finish(), { status: "published", cleanupPending: false });
      assert.deepEqual(await readFile(destination), content);
      await assertNoTemporaryFiles(directory);
    }
  });
});

test("process exporter never replaces an existing file or directory junction", async () => {
  await withTemporaryDirectory(async (directory) => {
    const existingDestination = path.join(directory, "existing.bin");
    const original = Buffer.from("original", "utf8");
    await writeFile(existingDestination, original);

    const existing = await exporter().prepare(grant(existingDestination), expected(Buffer.from("replacement")));
    assert.deepEqual(existing, {
      status: "not_published",
      code: "destination_exists",
      temporaryCleanup: "complete",
    });
    assert.deepEqual(await readFile(existingDestination), original);

    const junctionTarget = path.join(directory, "junction-target");
    const junctionDestination = path.join(directory, "junction-destination");
    await mkdir(junctionTarget);
    await symlink(junctionTarget, junctionDestination, process.platform === "win32" ? "junction" : "dir");
    const junction = await exporter().prepare(grant(junctionDestination), expected(Buffer.alloc(0)));
    assert.deepEqual(junction, {
      status: "not_published",
      code: "destination_exists",
      temporaryCleanup: "complete",
    });
    assert.equal((await lstat(junctionDestination)).isSymbolicLink(), true);
    await assertNoTemporaryFiles(directory);
  });
});

test("concurrent exporters use the publish point as an exclusive no-clobber race", async () => {
  await withTemporaryDirectory(async (directory) => {
    const destination = path.join(directory, "race.bin");
    const content = Buffer.from("one winner", "utf8");
    const [first, second] = await Promise.all([
      prepareWriter(destination, content),
      prepareWriter(destination, content),
    ]);
    await Promise.all([first.write(exactArrayBuffer(content)), second.write(exactArrayBuffer(content))]);

    const outcomes = await Promise.all([first.finish(), second.finish()]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "published").length, 1);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "not_published" && outcome.code === "destination_exists").length,
      1,
    );
    assert.deepEqual(await readFile(destination), content);
    await assertNoTemporaryFiles(directory);
  });
});

test("abort and integrity mismatch do not publish partial content and clean their temporary files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const partialDestination = path.join(directory, "partial.bin");
    const content = Buffer.from("complete content", "utf8");
    const partial = await prepareWriter(partialDestination, content);
    await partial.write(exactArrayBuffer(content.subarray(0, 3)));
    const aborted = await partial.abort();
    assert.equal(aborted.status, "not_published");
    if (aborted.status === "not_published") assert.equal(aborted.temporaryCleanup, "complete");
    await assert.rejects(lstat(partialDestination), { code: "ENOENT" });

    const invalidDestination = path.join(directory, "invalid.bin");
    const prepared = await exporter().prepare(grant(invalidDestination), {
      byteLength: content.byteLength,
      contentSha256: "0".repeat(64),
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") assert.fail("Exporter did not become ready.");
    await prepared.writer.write(exactArrayBuffer(content));
    assert.deepEqual(await prepared.writer.finish(), {
      status: "not_published",
      code: "integrity_mismatch",
      temporaryCleanup: "complete",
    });
    await assert.rejects(lstat(invalidDestination), { code: "ENOENT" });
    await assertNoTemporaryFiles(directory);
  });
});

test("abort force-terminates a non-cooperative export helper so the owning process exits", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await runAbortProbe(path.join(directory, "payload.bin"));

    assert.equal(result.timedOut, false, `abort probe exceeded its process deadline: ${result.stderr}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as Readonly<{ status?: unknown; elapsedMs?: unknown }>;
    assert.equal(output.status, "not_published");
    assert.equal(typeof output.elapsedMs, "number");
    assert.equal((output.elapsedMs as number) < 2_500, true);
  });
});

test("temporary pathname replacement cannot publish or delete an unverified inode", async () => {
  await withTemporaryDirectory(async (directory) => {
    const destination = path.join(directory, "payload.bin");
    const verifiedContent = Buffer.from("verified", "utf8");
    const replacementContent = Buffer.from("replacement", "utf8");
    const writer = await prepareWriter(destination, verifiedContent);
    const temporaryNames = (await readdir(directory)).filter((name) => name.startsWith(".withmate-output-"));
    assert.equal(temporaryNames.length, 1);
    const temporaryPath = path.join(directory, temporaryNames[0]!);
    await unlink(temporaryPath);
    await writeFile(temporaryPath, replacementContent);

    await writer.write(exactArrayBuffer(verifiedContent));
    const outcome = await writer.finish();

    assert.equal(outcome.status, "not_published");
    if (outcome.status === "not_published") assert.equal(outcome.code, "destination_invalid");
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.deepEqual(await readFile(temporaryPath), replacementContent);
    await unlink(temporaryPath);
  });
});

test("parent replacement after preparation cannot redirect publication", async () => {
  await withTemporaryDirectory(async (directory) => {
    const parent = path.join(directory, "parent");
    const movedParent = path.join(directory, "moved-parent");
    const destination = path.join(parent, "payload.bin");
    const content = Buffer.from("anchored", "utf8");
    await mkdir(parent);
    const writer = await prepareWriter(destination, content);

    try {
      await rename(parent, movedParent);
    } catch (error) {
      if (process.platform !== "win32" || !hasCode(error, "EPERM", "EBUSY", "EACCES")) throw error;
      const outcome = await writer.abort();
      assert.equal(outcome.status, "not_published");
      await assertNoTemporaryFiles(parent);
      return;
    }
    await mkdir(parent);
    await writer.write(exactArrayBuffer(content));
    const outcome = await writer.finish();
    assert.equal(outcome.status, "not_published");
    if (outcome.status === "not_published") assert.equal(outcome.code, "destination_invalid");
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(movedParent, "payload.bin")), { code: "ENOENT" });
    await assertNoTemporaryFiles(movedParent);
  });
});

test("the helper revalidates parent identity after the exclusive link publish point", async () => {
  const source = await readFile(new URL("../src/main/run-output-export-helper.ts", import.meta.url), "utf8");
  const linkIndex = source.indexOf("await link(temporaryName, destinationName);");
  const destinationIdentityIndex = source.indexOf(
    "await assertPathIdentity(destinationName, temporaryIdentity);",
    linkIndex,
  );
  const parentIdentityIndex = source.indexOf(
    "await assertParentIdentity(canonicalParent, expectedDevice, expectedInode);",
    destinationIdentityIndex,
  );

  assert.notEqual(linkIndex, -1);
  assert.equal(destinationIdentityIndex > linkIndex, true);
  assert.equal(parentIdentityIndex > destinationIdentityIndex, true);
});

function exporter(): ProcessRunOutputExporter {
  return new ProcessRunOutputExporter({
    executablePath: process.execPath,
    helperUrl: new URL("../src/main/run-output-export-helper.ts", import.meta.url),
  });
}

async function prepareWriter(destination: string, content: Uint8Array): Promise<RunOutputExportWriter> {
  const prepared = await exporter().prepare(grant(destination), expected(content));
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") assert.fail("Exporter did not become ready.");
  return prepared.writer;
}

function grant(destination: string) {
  return {
    kind: "explicit_absolute_path",
    authority: "cli_user_selection",
    absolutePath: destination,
  } as const;
}

function expected(content: Uint8Array) {
  return {
    byteLength: content.byteLength,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  } as const;
}

function exactArrayBuffer(content: Uint8Array): ArrayBuffer {
  return Uint8Array.from(content).buffer;
}

async function assertNoTemporaryFiles(directory: string): Promise<void> {
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".withmate-output-")),
    [],
  );
}

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-output-export-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runAbortProbe(destination: string): Promise<
  Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>
> {
  const probePath = fileURLToPath(new URL("./fixtures/run-output-export-abort-probe.ts", import.meta.url));
  const helperPath = fileURLToPath(new URL("./fixtures/run-output-export-noncooperative-helper.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", probePath, helperPath, destination], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.on("data", (value: string) => {
    stderr += value;
  });
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 3_000);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}
