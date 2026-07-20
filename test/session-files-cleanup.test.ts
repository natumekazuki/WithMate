import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWithMateSessionFilesRoot } from "../src/main/application-data-path.js";
import { LocalSessionFilesCleanup, SessionFilesCleanupError } from "../src/main/session-files-cleanup.js";

test("Session Files cleanup removes one nested Session directory and preserves its fixed root", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(1);
    const siblingSessionId = issuedSessionId(2);
    const target = path.join(root, sessionId);
    const sibling = path.join(root, siblingSessionId);
    await fs.mkdir(path.join(target, "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "nested", "payload.bin"), "payload");
    await fs.mkdir(sibling);
    const cleanup = new LocalSessionFilesCleanup(applicationDataRoot);

    await cleanup.deleteSessionFiles(sessionId);
    await cleanup.deleteSessionFiles(sessionId);

    assert.equal(await exists(target), false);
    assert.equal(await exists(root), true);
    assert.equal(await exists(sibling), true);
  });
});

test("Session Files cleanup succeeds idempotently when the fixed root is absent", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(3);

    await new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId);

    assert.equal(await exists(root), false);
  });
});

test("Session Files cleanup does not retain raw filesystem errors as diagnostic causes", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const deniedPath = path.join(applicationDataRoot, "private-owner");
    const deniedFileSystem: Pick<typeof fs, "lstat" | "realpath" | "stat"> = {
      lstat: (async () => {
        throw Object.assign(new Error(`Access denied: ${deniedPath}`), {
          code: "EACCES",
          path: deniedPath,
          syscall: "lstat",
        });
      }) as typeof fs.lstat,
      realpath: fs.realpath.bind(fs),
      stat: fs.stat.bind(fs),
    };

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, deniedFileSystem).deleteSessionFiles(issuedSessionId(20)),
      (error: unknown) =>
        error instanceof SessionFilesCleanupError &&
        error.code === "filesystem_failed" &&
        error.message === "Session Files cleanup failed." &&
        error.cause === undefined,
    );
  });
});

test("Session Files cleanup maps an anchored deletion failure and leaves work for exact retry", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(4);
    const target = path.join(root, sessionId);
    const payload = path.join(target, "pending.bin");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(payload, "pending");

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, fs, () => {
        throw new Error("injected deletion failure");
      }).deleteSessionFiles(sessionId),
      (error: unknown) =>
        error instanceof SessionFilesCleanupError &&
        error.code === "filesystem_failed" &&
        error.message === "Session Files cleanup failed." &&
        Object.isFrozen(error.cause) &&
        assert.deepEqual(error.cause, { kind: "filesystem_failed", code: "UNKNOWN" }) === undefined,
    );
    assert.equal(await exists(target), true);

    await new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId);
    assert.equal(await exists(target), false);
  });
});

test("Session Files cleanup never treats an old cleanup-looking sibling as its target", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(5);
    const collisionSessionId = `.deleting-${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
    const target = path.join(root, sessionId);
    const collisionSibling = path.join(root, collisionSessionId);
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(collisionSibling);
    await fs.writeFile(path.join(collisionSibling, "keep.txt"), "keep");

    await new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId);

    assert.equal(await exists(target), false);
    assert.equal(await fs.readFile(path.join(collisionSibling, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup unlinks symlinks and junctions without traversing them", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(6);
    const target = path.join(root, sessionId);
    const external = path.join(applicationDataRoot, "external");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "keep.txt"), "keep");
    await fs.symlink(external, path.join(target, "external-link"), process.platform === "win32" ? "junction" : "dir");

    await new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId);

    assert.equal(await exists(target), false);
    assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup removes a Session-directory junction without traversing its target", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const external = path.join(applicationDataRoot, "external-target");
    const sessionId = issuedSessionId(7);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "keep.txt"), "keep");
    await fs.symlink(external, path.join(root, sessionId), process.platform === "win32" ? "junction" : "dir");

    const cleanup = new LocalSessionFilesCleanup(applicationDataRoot);
    await cleanup.deleteSessionFiles(sessionId);
    await cleanup.deleteSessionFiles(sessionId);

    assert.equal(await exists(path.join(root, sessionId)), false);
    assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup rejects a symlinked application directory without touching its target", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const external = path.join(applicationDataRoot, "external-app");
    const sessionId = issuedSessionId(8);
    const externalSession = path.join(external, "session-files", sessionId);
    await fs.mkdir(externalSession, { recursive: true });
    await fs.writeFile(path.join(externalSession, "keep.txt"), "keep");
    await fs.symlink(
      external,
      path.join(applicationDataRoot, "WithMate"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId),
      (error: unknown) =>
        error instanceof SessionFilesCleanupError &&
        error.code === "unsafe_path" &&
        error.message === "Session Files cleanup path is unsafe.",
    );
    assert.equal(await fs.readFile(path.join(externalSession, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup rejects a symlinked Session Files root without touching its target", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const applicationDirectory = path.join(applicationDataRoot, "WithMate");
    const external = path.join(applicationDataRoot, "external-session-files");
    const sessionId = issuedSessionId(9);
    const externalSession = path.join(external, sessionId);
    await fs.mkdir(applicationDirectory, { recursive: true });
    await fs.mkdir(externalSession, { recursive: true });
    await fs.writeFile(path.join(externalSession, "keep.txt"), "keep");
    await fs.symlink(
      external,
      resolveWithMateSessionFilesRoot(applicationDataRoot),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "unsafe_path",
    );
    assert.equal(await fs.readFile(path.join(externalSession, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup rejects an ordinary fixed-root replacement before helper anchoring", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const applicationDirectory = path.dirname(root);
    const movedRoot = path.join(applicationDirectory, "session-files-original");
    const replacementRoot = path.join(applicationDirectory, "session-files-replacement");
    const sessionId = issuedSessionId(10);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "original.txt"), "original");
    await fs.mkdir(path.join(replacementRoot, sessionId), { recursive: true });
    await fs.writeFile(path.join(replacementRoot, sessionId, "keep.txt"), "keep");

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, fs, undefined, async () => {
        await fs.rename(root, movedRoot);
        await fs.rename(replacementRoot, root);
      }).deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "filesystem_failed",
    );

    assert.equal(await fs.readFile(path.join(movedRoot, sessionId, "original.txt"), "utf8"), "original");
    assert.equal(await fs.readFile(path.join(root, sessionId, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup rejects a same-identity root junction before helper anchoring", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const movedRoot = path.join(path.dirname(root), "session-files-moved-before-anchor");
    const sessionId = issuedSessionId(18);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "keep.txt"), "keep");

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, fs, undefined, async () => {
        await fs.rename(root, movedRoot);
        await fs.symlink(movedRoot, root, process.platform === "win32" ? "junction" : "dir");
      }).deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "filesystem_failed",
    );

    assert.equal(await fs.readFile(path.join(movedRoot, sessionId, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup rejects a same-identity application junction before helper anchoring", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const applicationDirectory = path.dirname(root);
    const movedApplicationDirectory = path.join(applicationDataRoot, "WithMate-moved-before-anchor");
    const sessionId = issuedSessionId(19);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "keep.txt"), "keep");

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, fs, undefined, async () => {
        await fs.rename(applicationDirectory, movedApplicationDirectory);
        await fs.symlink(
          movedApplicationDirectory,
          applicationDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      }).deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "filesystem_failed",
    );

    assert.equal(
      await fs.readFile(path.join(movedApplicationDirectory, "session-files", sessionId, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("Session Files cleanup anchors by root identity when canonical path spelling differs", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(17);
    const target = path.join(root, sessionId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "delete.txt"), "delete");
    const alternateCanonicalPathFileSystem: Pick<typeof fs, "lstat" | "realpath" | "stat"> = {
      lstat: fs.lstat.bind(fs),
      stat: fs.stat.bind(fs),
      realpath: (async (entryPath: Parameters<typeof fs.realpath>[0]) => {
        const canonicalPath = await fs.realpath(entryPath);
        return `${canonicalPath}${path.sep}`;
      }) as typeof fs.realpath,
    };

    await new LocalSessionFilesCleanup(applicationDataRoot, alternateCanonicalPathFileSystem).deleteSessionFiles(
      sessionId,
    );

    assert.equal(await exists(target), false);
  });
});

test("Session Files cleanup rejects an application-directory replacement before child-root anchoring", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const applicationDirectory = path.join(applicationDataRoot, "WithMate");
    const movedApplicationDirectory = path.join(applicationDataRoot, "WithMate-original");
    const replacementApplicationDirectory = path.join(applicationDataRoot, "WithMate-replacement");
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const replacementRoot = path.join(replacementApplicationDirectory, "session-files");
    const sessionId = issuedSessionId(14);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "original.txt"), "original");
    await fs.mkdir(path.join(replacementRoot, sessionId), { recursive: true });
    await fs.writeFile(path.join(replacementRoot, sessionId, "replacement.txt"), "replacement");
    let replaced = false;
    const replacingFileSystem: Pick<typeof fs, "lstat" | "realpath" | "stat"> = {
      realpath: fs.realpath.bind(fs),
      stat: fs.stat.bind(fs),
      lstat: (async (entryPath: Parameters<typeof fs.lstat>[0]) => {
        if (!replaced && path.resolve(String(entryPath)) === path.resolve(root)) {
          replaced = true;
          await fs.rename(applicationDirectory, movedApplicationDirectory);
          await fs.rename(replacementApplicationDirectory, applicationDirectory);
        }
        return fs.lstat(entryPath);
      }) as typeof fs.lstat,
    };

    await assert.rejects(
      new LocalSessionFilesCleanup(applicationDataRoot, replacingFileSystem).deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "unsafe_path",
    );

    assert.equal(
      await fs.readFile(path.join(movedApplicationDirectory, "session-files", sessionId, "original.txt"), "utf8"),
      "original",
    );
    assert.equal(
      await fs.readFile(path.join(applicationDirectory, "session-files", sessionId, "replacement.txt"), "utf8"),
      "replacement",
    );
  });
});

test("bound Session Files cleanup rejects missing application and root owners", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const applicationDirectory = path.join(applicationDataRoot, "WithMate");
    const movedApplicationDirectory = path.join(applicationDataRoot, "WithMate-moved");
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const sessionId = issuedSessionId(15);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "keep.txt"), "keep");
    const cleanup = await LocalSessionFilesCleanup.bindToApplicationDataRoot(applicationDataRoot);
    await fs.rename(applicationDirectory, movedApplicationDirectory);

    await assert.rejects(
      cleanup.deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "unsafe_path",
    );
    assert.equal(
      await fs.readFile(path.join(movedApplicationDirectory, "session-files", sessionId, "keep.txt"), "utf8"),
      "keep",
    );
  });

  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const movedRoot = path.join(path.dirname(root), "session-files-moved");
    const sessionId = issuedSessionId(16);
    await fs.mkdir(path.join(root, sessionId), { recursive: true });
    await fs.writeFile(path.join(root, sessionId, "keep.txt"), "keep");
    const cleanup = await LocalSessionFilesCleanup.bindToApplicationDataRoot(applicationDataRoot);
    await fs.rename(root, movedRoot);

    await assert.rejects(
      cleanup.deleteSessionFiles(sessionId),
      (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "unsafe_path",
    );
    assert.equal(await fs.readFile(path.join(movedRoot, sessionId, "keep.txt"), "utf8"), "keep");
  });
});

test("Session Files cleanup anchors deletion before a concurrent fixed-root replacement", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
    const applicationDirectory = path.dirname(root);
    const movedRoot = path.join(applicationDirectory, "session-files-moved");
    const external = path.join(applicationDataRoot, "external-session-files-race");
    const sessionId = issuedSessionId(11);
    const target = path.join(root, sessionId);
    const externalTarget = path.join(external, sessionId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "delete.txt"), "delete");
    await fs.mkdir(externalTarget, { recursive: true });
    await fs.writeFile(path.join(externalTarget, "keep.txt"), "keep");
    let rootWasReplaced = false;

    await new LocalSessionFilesCleanup(applicationDataRoot, fs, async () => {
      try {
        await fs.rename(root, movedRoot);
        await fs.symlink(external, root, process.platform === "win32" ? "junction" : "dir");
        rootWasReplaced = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && ["EBUSY", "EPERM", "EACCES"].includes(String(error.code)))) {
          throw error;
        }
      }
    }).deleteSessionFiles(sessionId);

    assert.equal(await fs.readFile(path.join(externalTarget, "keep.txt"), "utf8"), "keep");
    assert.equal(await exists(path.join(rootWasReplaced ? movedRoot : root, sessionId)), false);
  });
});

test("Session Files cleanup rejects path-like Session IDs before filesystem traversal", async () => {
  await withTempDirectory(async (applicationDataRoot) => {
    const cleanup = new LocalSessionFilesCleanup(applicationDataRoot);
    for (const sessionId of [
      "",
      ".",
      "..",
      "child/session",
      "child\\session",
      "/absolute",
      "C:\\absolute",
      "nul\0id",
      issuedSessionId(12).toUpperCase(),
      "session-1",
    ]) {
      await assert.rejects(
        cleanup.deleteSessionFiles(sessionId),
        (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "invalid_session_id",
      );
    }
    assert.equal(await exists(path.join(applicationDataRoot, "WithMate")), false);
  });
});

test(
  "Session Files cleanup rejects a Windows case alias without deleting the issued Session directory",
  { skip: process.platform !== "win32" },
  async () => {
    await withTempDirectory(async (applicationDataRoot) => {
      const root = resolveWithMateSessionFilesRoot(applicationDataRoot);
      const sessionId = issuedSessionId(13);
      const target = path.join(root, sessionId);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "keep.txt"), "keep");

      await assert.rejects(
        new LocalSessionFilesCleanup(applicationDataRoot).deleteSessionFiles(sessionId.toUpperCase()),
        (error: unknown) => error instanceof SessionFilesCleanupError && error.code === "invalid_session_id",
      );

      assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "keep");
    });
  },
);

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "withmate-session-files-cleanup-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function exists(entryPath: string): Promise<boolean> {
  try {
    await fs.lstat(entryPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function issuedSessionId(ordinal: number): string {
  return `session_${ordinal.toString(16).padStart(96, "0")}`;
}
