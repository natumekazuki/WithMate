import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { listIdentityBoundDirectory } from "../../src-electron/identity-bound-directory-listing.js";
import { SessionFileExplorerService } from "../../src-electron/session-file-explorer-service.js";

test("SessionFileExplorerService は preview link を最も具体的な認可 root へ解決する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-file-preview-link-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const nestedAdditionalPath = path.join(workspacePath, "packages", "nested");
  const outsidePath = path.join(tempDirectory, "outside.txt");
  const outsideSiblingPath = path.join(tempDirectory, "outside-sibling.txt");
  const sessionFolderPath = path.join(tempDirectory, "user-data", "session-files", "session-1");
  try {
    await mkdir(nestedAdditionalPath, { recursive: true });
    await mkdir(sessionFolderPath, { recursive: true });
    await writeFile(path.join(workspacePath, "README.md"), "workspace");
    await writeFile(path.join(workspacePath, "encoded file.md"), "encoded");
    await writeFile(path.join(nestedAdditionalPath, "index.ts"), "nested");
    await writeFile(path.join(sessionFolderPath, "artifact.txt"), "artifact");
    await writeFile(outsidePath, "outside");
    await writeFile(outsideSiblingPath, "outside sibling");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return {
          workspacePath,
          parentSessionId: "session-1",
          allowedAdditionalDirectories: [nestedAdditionalPath],
        };
      },
    });
    const roots = await service.listRoots("session-1");
    const additionalRootId = roots.find((root) => root.kind === "additional")?.id;

    assert.deepEqual(await service.resolvePreviewTarget("session-1", "README.md#heading"), {
      type: "file",
      resource: { sessionId: "session-1", rootId: "workspace", relativePath: "README.md" },
    });
    assert.deepEqual(await service.resolvePreviewTarget("session-1", "README.md:10:4"), {
      type: "file",
      resource: { sessionId: "session-1", rootId: "workspace", relativePath: "README.md" },
    });
    assert.deepEqual(await service.resolvePreviewTarget(
      "session-1",
      pathToFileURL(path.join(workspacePath, "encoded file.md")).href,
    ), {
      type: "file",
      resource: { sessionId: "session-1", rootId: "workspace", relativePath: "encoded file.md" },
    });
    assert.deepEqual(await service.resolvePreviewTarget(
      "session-1",
      pathToFileURL(path.join(nestedAdditionalPath, "index.ts")).href,
    ), {
      type: "file",
      resource: { sessionId: "session-1", rootId: additionalRootId, relativePath: "index.ts" },
    });
    assert.deepEqual(await service.resolvePreviewTarget("session-1", path.join(sessionFolderPath, "artifact.txt")), {
      type: "file",
      resource: { sessionId: "session-1", rootId: "session-folder", relativePath: "artifact.txt" },
    });
    assert.deepEqual(await service.resolvePreviewTarget("session-1", outsidePath), {
      type: "file",
      resource: { sessionId: "session-1", absolutePath: await realpath(outsidePath) },
    });
    assert.deepEqual(await service.resolvePreviewTarget(
      "session-1",
      "outside-sibling.txt",
      { sessionId: "session-1", absolutePath: await realpath(outsidePath) },
    ), {
      type: "file",
      resource: { sessionId: "session-1", absolutePath: await realpath(outsideSiblingPath) },
    });
    assert.equal((await service.resolvePreviewTarget("session-1", "missing.md")).type, "not-found");
    assert.deepEqual(await service.resolvePreviewTarget("session-1", "packages"), {
      type: "directory",
      targetPath: await realpath(path.join(workspacePath, "packages")),
    });
    assert.deepEqual(await service.resolvePreviewTarget("session-1", "https://example.com/file.md"), {
      type: "external-url",
      target: "https://example.com/file.md",
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は root 外 file も存在確認し missing を返す", async () => {
  const workspacePath = path.resolve("C:/workspace/project");
  const probedPaths: string[] = [];
  const service = new SessionFileExplorerService({
    userDataPath: path.resolve("C:/user-data"),
    async getSessionContext() {
      return {
        workspacePath,
        parentSessionId: "session-1",
        allowedAdditionalDirectories: [],
      };
    },
    async lstatPath(targetPath) {
      probedPaths.push(targetPath);
      throw Object.assign(new Error("unexpected filesystem probe"), { code: "ENOENT" });
    },
  });

  assert.deepEqual(await service.resolvePreviewTarget("session-1", "file://server/share/file.txt"), {
    type: "not-found",
    targetPath: "\\\\server\\share\\file.txt",
    message: "The local path was not found.",
  });
  assert.deepEqual(probedPaths, ["\\\\server\\share\\file.txt"]);
});

test("SessionFileExplorerService は regular file でも directory でもない path を Preview にしない", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-special-preview-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const specialPath = path.join(tempDirectory, "special-entry");
  let openCount = 0;
  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(specialPath, "placeholder");
    const specialRealPath = await realpath(specialPath);
    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return { workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] };
      },
      async statPath(targetPath) {
        if (path.resolve(targetPath) === path.resolve(specialRealPath)) {
          return {
            isDirectory: () => false,
            isFile: () => false,
          } as Stats;
        }
        return stat(targetPath);
      },
      async openResolvedPath(targetPath) {
        openCount += 1;
        return { status: "opened", targetType: "local-path", target: targetPath };
      },
    });

    assert.deepEqual(await service.resolvePreviewTarget("session-1", specialPath), {
      type: "not-previewable",
      targetPath: specialPath,
      message: "The local path is not a file or directory.",
    });
    assert.equal(openCount, 0);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は absolute preview resource を同じ実体確認で inspect / read する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-absolute-preview-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const outsidePath = path.join(tempDirectory, "outside.txt");
  const openedPaths: Array<{ targetPath: string; reveal: boolean }> = [];
  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(outsidePath, "outside preview");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return { workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] };
      },
      async openResolvedPath(targetPath, reveal) {
        openedPaths.push({ targetPath, reveal });
        return { status: "opened", targetType: "local-path", target: targetPath };
      },
    });
    const resource = { sessionId: "session-1", absolutePath: await realpath(outsidePath) };
    const descriptor = await service.inspectFile(resource);
    assert.equal(descriptor.name, "outside.txt");
    const chunk = await service.readFileChunk({
      ...resource,
      offset: 0,
      length: 1024,
      expectedRevision: descriptor.revision,
    });
    assert.equal(new TextDecoder().decode(chunk.data), "outside preview");
    await service.openFile({ ...resource, reveal: true });
    assert.deepEqual(openedPaths, [{ targetPath: resource.absolutePath, reveal: true }]);
    await assert.rejects(
      () => service.inspectFile({
        ...resource,
        rootId: "workspace",
        relativePath: "outside.txt",
      }),
      /Absolute file preview resource is invalid/,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は root 内 symlink file を absolute preview resource へ解決する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-preview-link-escape-"));
  const workspacePath = path.join(basePath, "workspace");
  const outsidePath = path.join(basePath, "outside");
  const junctionPath = path.join(workspacePath, "outside-link");
  const probedPaths: string[] = [];
  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(path.join(outsidePath, "secret.txt"), "secret");
    await symlink(outsidePath, junctionPath, process.platform === "win32" ? "junction" : "dir");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(basePath, "user-data"),
      async getSessionContext() {
        return {
          workspacePath,
          parentSessionId: "session-1",
          allowedAdditionalDirectories: [],
        };
      },
      async lstatPath(targetPath) {
        probedPaths.push(targetPath);
        return lstat(targetPath);
      },
    });

    assert.deepEqual(await service.resolvePreviewTarget("session-1", "outside-link/secret.txt"), {
      type: "file",
      resource: {
        sessionId: "session-1",
        absolutePath: await realpath(path.join(junctionPath, "secret.txt")),
      },
    });
    assert.equal((await service.resolvePreviewTarget("session-1", "outside-link")).type, "not-previewable");
    assert.equal(probedPaths.includes(path.join(junctionPath, "secret.txt")), true);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は roots を重複除去し directory を展開時に直下だけ読む", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-file-explorer-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const sessionFolderPath = path.join(tempDirectory, "user-data", "session-files", "session-1");
  const additionalPath = path.join(tempDirectory, "additional");
  try {
    await mkdir(path.join(workspacePath, "src", "nested"), { recursive: true });
    await mkdir(sessionFolderPath, { recursive: true });
    await mkdir(additionalPath, { recursive: true });
    await writeFile(path.join(workspacePath, ".hidden"), "hidden");
    await writeFile(path.join(workspacePath, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(workspacePath, "src", "nested", "deep.ts"), "deep\n");

    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return {
          workspacePath,
          parentSessionId: "session-1",
          allowedAdditionalDirectories: [sessionFolderPath, workspacePath, additionalPath, additionalPath],
        };
      },
    });

    const roots = await service.listRoots("session-1");
    assert.deepEqual(roots.map((root) => root.kind), ["workspace", "session-folder", "additional"]);
    assert.equal((await service.resolveRoot("session-1", "workspace"))?.absolutePath, path.resolve(workspacePath));
    assert.equal((await service.resolveRoot("session-1", roots[2]?.id ?? ""))?.absolutePath, path.resolve(additionalPath));
    assert.equal(await service.resolveRoot("session-1", "additional:stale"), null);
    const workspaceEntries = await service.listDirectory({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "",
    });
    assert.deepEqual(workspaceEntries.map((entry) => [entry.name, entry.kind]), [
      ["src", "directory"],
      [".hidden", "file"],
    ]);
    const srcEntries = await service.listDirectory({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "src",
    });
    assert.deepEqual(srcEntries.map((entry) => entry.name), ["nested", "index.ts"]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は未作成の Session Folder を初回展開時に空 root として作成する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-folder-root-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const sessionFolderPath = path.join(tempDirectory, "user-data", "session-files", "session-1");
  try {
    await mkdir(workspacePath, { recursive: true });
    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return { workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] };
      },
    });

    const entries = await service.listDirectory({
      sessionId: "session-1",
      rootId: "session-folder",
      relativePath: "",
    });

    assert.deepEqual(entries, []);
    assert.deepEqual(await readdir(sessionFolderPath), []);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は root 外参照を拒否し file を revision 固定 chunk で読む", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-file-explorer-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  try {
    await mkdir(workspacePath, { recursive: true });
    const largeBytes = new Uint8Array(2 * 1024 * 1024 + 17).fill(65);
    await writeFile(path.join(workspacePath, "large.txt"), largeBytes);
    await writeFile(path.join(workspacePath, "legacy.txt"), Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]));
    await writeFile(path.join(workspacePath, "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");

    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return { workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] };
      },
    });

    await assert.rejects(
      () => service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "../outside.txt" }),
      /不正な segment/,
    );
    const descriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "large.txt",
    });
    assert.equal(descriptor.kind, "text");
    assert.equal(descriptor.byteLength, largeBytes.byteLength);

    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < descriptor.byteLength) {
      const chunk = await service.readFileChunk({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "large.txt",
        offset,
        length: 1024 * 1024,
        expectedRevision: descriptor.revision,
      });
      chunks.push(new Uint8Array(chunk.data));
      offset = chunk.nextOffset;
    }
    assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [1024 * 1024, 1024 * 1024, 17]);

    const legacyDescriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "legacy.txt",
    });
    assert.equal(legacyDescriptor.suggestedEncoding, "shift_jis");
    const svgDescriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "diagram.svg",
    });
    assert.equal(svgDescriptor.kind, "svg");

    await writeFile(path.join(workspacePath, "large.txt"), "changed");
    await assert.rejects(
      () => service.readFileChunk({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "large.txt",
        offset: 0,
        length: 32,
        expectedRevision: descriptor.revision,
      }),
      /変更された/,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は chunk read 後に同じ handle の revision が変わった場合も拒否する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-file-read-race-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const targetPath = path.join(workspacePath, "changing.txt");
  let mutateAfterRead = false;
  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(targetPath, "original");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(tempDirectory, "user-data"),
      async getSessionContext() {
        return { workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] };
      },
      async openFile(filePath, flags) {
        const handle = await open(filePath, flags);
        return {
          stat: () => handle.stat(),
          async read(buffer, offset, length, position) {
            const result = await handle.read(buffer, offset, length, position);
            if (mutateAfterRead) {
              mutateAfterRead = false;
              await appendFile(targetPath, "!");
            }
            return result;
          },
          close: () => handle.close(),
        };
      },
    });
    const descriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "changing.txt",
    });

    mutateAfterRead = true;
    await assert.rejects(
      () => service.readFileChunk({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "changing.txt",
        offset: 0,
        length: descriptor.byteLength,
        expectedRevision: descriptor.revision,
      }),
      /読み込み中に file が変更された/,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は extension だけでなく先頭 byte から image / binary を分類する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-kind-"));
  const workspacePath = path.join(basePath, "workspace");
  const userDataPath = path.join(basePath, "user-data");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "image.bin"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  await writeFile(path.join(workspacePath, "control.data"), Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x41]));
  await writeFile(path.join(workspacePath, "control.md"), Uint8Array.from([0x00, 0x01, 0x02, 0x41]));
  const service = new SessionFileExplorerService({
    userDataPath,
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
  });
  try {
    assert.equal((await service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "image.bin" })).kind, "image");
    assert.equal((await service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "control.data" })).kind, "binary");
    assert.equal((await service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "control.md" })).kind, "binary");
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は BOM 付き UTF-16 text を binary にせず encoding selector へ渡す", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-utf16-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "little.txt"), Uint8Array.from([0xff, 0xfe, 0x41, 0x00]));
  await writeFile(path.join(workspacePath, "big.txt"), Uint8Array.from([0xfe, 0xff, 0x00, 0x41]));
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
  });
  try {
    const little = await service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "little.txt" });
    assert.equal(little.kind, "text");
    assert.equal(little.suggestedEncoding, "utf-16le");
    const big = await service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "big.txt" });
    assert.equal(big.kind, "text");
    assert.equal(big.suggestedEncoding, "utf-16be");
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は identity-bound directory metadata を投影する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-stat-bound-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await Promise.all(Array.from({ length: 96 }, (_, index) => (
    writeFile(path.join(workspacePath, `file-${index}.txt`), `${index}`)
  )));
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
  });
  try {
    const entries = await service.listDirectory({ sessionId: "session-1", rootId: "workspace", relativePath: "" });
    assert.equal(entries.length, 96);
    assert.ok(entries.every((entry) => entry.byteLength !== null && entry.modifiedAt !== null));
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は directory listing の process 全体同時数を固定上限に収める", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-admission-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceStats = await stat(workspacePath);
  let activeListings = 0;
  let maxActiveListings = 0;
  let listingCalls = 0;
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory() {
      listingCalls += 1;
      activeListings += 1;
      maxActiveListings = Math.max(maxActiveListings, activeListings);
      await new Promise((resolve) => setTimeout(resolve, 50));
      activeListings -= 1;
      return {
        device: workspaceStats.dev,
        inode: workspaceStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    await Promise.all(Array.from({ length: 10 }, () => service.listDirectory({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "",
    })));
    assert.equal(listingCalls, 10);
    assert.ok(maxActiveListings > 1);
    assert.ok(maxActiveListings <= 4);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は directory listing の待機数と認可 handle 数を固定上限に収める", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-queue-bound-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceStats = await stat(workspacePath);
  let activeHandles = 0;
  let maxActiveHandles = 0;
  let releaseListings!: () => void;
  const listingsReleased = new Promise<void>((resolve) => {
    releaseListings = resolve;
  });
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async openFile(targetPath, flags) {
      const handle = await open(targetPath, flags);
      activeHandles += 1;
      maxActiveHandles = Math.max(maxActiveHandles, activeHandles);
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        async close() {
          activeHandles -= 1;
          await handle.close();
        },
      };
    },
    async listDirectory() {
      await listingsReleased;
      return {
        device: workspaceStats.dev,
        inode: workspaceStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const requests = Array.from({ length: 40 }, () => service.listDirectory({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "",
    }));
    const settledRequests = Promise.allSettled(requests);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(maxActiveHandles <= 4);
    releaseListings();
    const results = await settledRequests;
    assert.ok(results.some((result) => result.status === "rejected"));
    assert.equal(activeHandles, 0);
    assert.ok(maxActiveHandles <= 4);
  } finally {
    releaseListings();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は別 Session の待機中 directory listing を supersede しない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-queue-owner-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceStats = await stat(workspacePath);
  let releaseListings!: () => void;
  const listingsReleased = new Promise<void>((resolve) => {
    releaseListings = resolve;
  });
  const createService = (sessionId: string) => new SessionFileExplorerService({
    userDataPath: path.join(basePath, `user-data-${sessionId}`),
    getSessionContext: async () => ({ workspacePath, parentSessionId: sessionId, allowedAdditionalDirectories: [] }),
    async listDirectory() {
      await listingsReleased;
      return {
        device: workspaceStats.dev,
        inode: workspaceStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  const victimService = createService("victim");
  const noisyService = createService("noisy");
  try {
    const activeRequests = Array.from({ length: 4 }, () => victimService.listDirectory({
      sessionId: "victim",
      rootId: "workspace",
      relativePath: "",
    }));
    let victimSettled = false;
    const victimRequest = victimService.listDirectory({
      sessionId: "victim",
      rootId: "workspace",
      relativePath: "",
    }).finally(() => {
      victimSettled = true;
    });
    const noisyRequests = Array.from({ length: 32 }, () => noisyService.listDirectory({
      sessionId: "noisy",
      rootId: "workspace",
      relativePath: "",
    }));
    const noisyResults = Promise.allSettled(noisyRequests);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(victimSettled, false);
    releaseListings();
    const [victimResult, noisySettled] = await Promise.all([
      victimRequest,
      noisyResults,
      ...activeRequests,
    ]);
    assert.deepEqual(victimResult, []);
    assert.ok(noisySettled.some((result) => result.status === "rejected"));
  } finally {
    releaseListings();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は directory worker timeout 後に認可 handle を close する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-timeout-close-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  let closeCalls = 0;
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async openFile(targetPath, flags) {
      const handle = await open(targetPath, flags);
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        async close() {
          closeCalls += 1;
          await handle.close();
        },
      };
    },
    listDirectory: (targetPath) => listIdentityBoundDirectory(targetPath, {
      hangAfterReady: true,
      timeoutMs: 100,
    }),
  });
  try {
    await assert.rejects(
      () => service.listDirectory({ sessionId: "session-1", rootId: "workspace", relativePath: "" }),
      /100ms 以内に完了しなかった/,
    );
    assert.equal(closeCalls, 1);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は認可 root 内だけを realpath 後に既定アプリへ渡す", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-open-root-"));
  const workspacePath = path.join(basePath, "workspace");
  const outsidePath = path.join(basePath, "outside");
  const openedPaths: string[] = [];
  await mkdir(workspacePath, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(path.join(workspacePath, "inside.txt"), "inside");
  await writeFile(path.join(outsidePath, "secret.txt"), "secret");
  await symlink(outsidePath, path.join(workspacePath, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async openResolvedPath(targetPath, reveal) {
      openedPaths.push(targetPath);
      return { status: reveal ? "revealed" : "opened", targetType: "local-path", target: targetPath, ...(reveal ? { message: "revealed" } : {}) };
    },
  });
  try {
    const result = await service.openFile({ sessionId: "session-1", rootId: "workspace", relativePath: "inside.txt" });
    assert.equal(result.status, "opened");
    assert.deepEqual(openedPaths, [await realpath(path.join(workspacePath, "inside.txt"))]);
    await assert.rejects(
      () => service.openFile({ sessionId: "session-1", rootId: "workspace", relativePath: "outside-link/secret.txt" }),
      /file root の外側/,
    );
    assert.equal(openedPaths.length, 1);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は認可した path と異なる実体の handle を read / open へ渡さない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-handle-auth-"));
  const workspacePath = path.join(basePath, "workspace");
  const outsidePath = path.join(basePath, "outside.txt");
  const insidePath = path.join(workspacePath, "inside.txt");
  let openResolvedPathCalls = 0;
  await mkdir(workspacePath, { recursive: true });
  await writeFile(insidePath, "inside");
  await writeFile(outsidePath, "outside");
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    openFile: (_targetPath, flags) => open(outsidePath, flags),
    async openResolvedPath() {
      openResolvedPathCalls += 1;
      return { status: "opened", targetType: "local-path", target: insidePath };
    },
  });
  const request = { sessionId: "session-1", rootId: "workspace", relativePath: "inside.txt" };
  try {
    await assert.rejects(() => service.inspectFile(request), /認可中に変更された/);
    await assert.rejects(() => service.openFile(request), /認可中に変更された/);
    assert.equal(openResolvedPathCalls, 0);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は認可した directory と異なる実体の一覧を返さない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-handle-auth-"));
  const workspacePath = path.join(basePath, "workspace");
  const insideDirectory = path.join(workspacePath, "inside");
  const outsideDirectory = path.join(basePath, "outside");
  await mkdir(insideDirectory, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(path.join(insideDirectory, "inside.txt"), "inside");
  await writeFile(path.join(outsideDirectory, "secret.txt"), "outside");
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    openFile: (_targetPath, flags) => open(outsideDirectory, flags),
  });
  try {
    await assert.rejects(
      () => service.listDirectory({ sessionId: "session-1", rootId: "workspace", relativePath: "inside" }),
      /認可中に変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は認可した directory identity と異なる worker 結果を返さない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-directory-worker-auth-"));
  const workspacePath = path.join(basePath, "workspace");
  const outsideDirectory = path.join(basePath, "outside");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  const outsideStats = await stat(outsideDirectory);
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory() {
      return {
        device: outsideStats.dev,
        inode: outsideStats.ino,
        entries: [{ name: "secret.txt", kind: "file", byteLength: 6, modifiedAt: outsideStats.mtime.toISOString() }],
        maxConcurrentStats: 1,
      };
    },
  });
  try {
    await assert.rejects(
      () => service.listDirectory({ sessionId: "session-1", rootId: "workspace", relativePath: "" }),
      /認可後に変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は同じ size と mtime の別 file へ置換された chunk read を拒否する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-identity-revision-"));
  const workspacePath = path.join(basePath, "workspace");
  const targetPath = path.join(workspacePath, "replaceable.txt");
  const archivedPath = path.join(workspacePath, "original.txt");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(targetPath, "same-size");
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
  });
  try {
    const descriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "replaceable.txt",
    });
    const originalStats = await stat(targetPath);
    await rename(targetPath, archivedPath);
    await writeFile(targetPath, "same-size");
    await utimes(targetPath, originalStats.atime, originalStats.mtime);

    await assert.rejects(
      () => service.readFileChunk({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "replaceable.txt",
        offset: 0,
        length: descriptor.byteLength,
        expectedRevision: descriptor.revision,
      }),
      /変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は同じ inode / size / mtime へ偽装した上書きを拒否する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-ctime-revision-"));
  const workspacePath = path.join(basePath, "workspace");
  const targetPath = path.join(workspacePath, "mutable.txt");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(targetPath, "original");
  const originalStats = await stat(targetPath);
  const ctimeChangedStats = Object.assign(
    Object.create(Object.getPrototypeOf(originalStats)) as Stats,
    originalStats,
    {
      ctimeMs: originalStats.ctimeMs + 1,
      ctime: new Date(originalStats.ctimeMs + 1),
    },
  );
  let exposeChangedCtime = false;
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async openFile(filePath, flags) {
      const handle = await open(filePath, flags);
      let statCalls = 0;
      return {
        async stat() {
          statCalls += 1;
          return exposeChangedCtime && statCalls > 1 ? ctimeChangedStats : originalStats;
        },
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  });
  try {
    const descriptor = await service.inspectFile({
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "mutable.txt",
    });
    assert.equal(ctimeChangedStats.dev, originalStats.dev);
    assert.equal(ctimeChangedStats.ino, originalStats.ino);
    assert.equal(ctimeChangedStats.size, originalStats.size);
    assert.equal(ctimeChangedStats.mtimeMs, originalStats.mtimeMs);
    assert.notEqual(ctimeChangedStats.ctimeMs, originalStats.ctimeMs);
    exposeChangedCtime = true;

    await assert.rejects(
      () => service.readFileChunk({
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "mutable.txt",
        offset: 0,
        length: descriptor.byteLength,
        expectedRevision: descriptor.revision,
      }),
      /変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は inspection read 中の file 変更を descriptor にしない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-inspection-race-"));
  const workspacePath = path.join(basePath, "workspace");
  const targetPath = path.join(workspacePath, "changing.txt");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(targetPath, "original");
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async openFile(filePath, flags) {
      const handle = await open(filePath, flags);
      return {
        stat: () => handle.stat(),
        async read(buffer, offset, length, position) {
          const result = await handle.read(buffer, offset, length, position);
          await writeFile(targetPath, "modified");
          return result;
        },
        close: () => handle.close(),
      };
    },
  });
  try {
    await assert.rejects(
      () => service.inspectFile({ sessionId: "session-1", rootId: "workspace", relativePath: "changing.txt" }),
      /inspection 中に file が変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は全 root を本文を読まずに検索し、ranking と root 外 link の境界を守る", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-"));
  const workspacePath = path.join(basePath, "workspace");
  const additionalPath = path.join(basePath, "additional");
  const outsidePath = path.join(basePath, "outside");
  const sessionFolderPath = path.join(basePath, "user-data", "session-files", "session-1");
  const linkedOutsidePath = path.join(workspacePath, "linked-outside");
  let fileReads = 0;
  try {
    await mkdir(path.join(workspacePath, "docs", "readme-folder"), { recursive: true });
    await mkdir(additionalPath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(path.join(workspacePath, "readme"), "exact");
    await writeFile(path.join(workspacePath, "README.md"), "prefix");
    await writeFile(path.join(workspacePath, "note-readme.txt"), "substring");
    await writeFile(path.join(workspacePath, "docs", "readme-reference.txt"), "prefix path");
    await writeFile(path.join(workspacePath, "docs", "readme-folder", "notes.txt"), "relative path");
    await writeFile(path.join(additionalPath, "readme"), "additional exact");
    await writeFile(path.join(outsidePath, "secret.txt"), "outside");
    await symlink(outsidePath, linkedOutsidePath, process.platform === "win32" ? "junction" : "dir");

    const service = new SessionFileExplorerService({
      userDataPath: path.join(basePath, "user-data"),
      async getSessionContext() {
        return {
          workspacePath,
          parentSessionId: "session-1",
          allowedAdditionalDirectories: [additionalPath],
        };
      },
      async openFile(filePath, flags) {
        const handle = await open(filePath, flags);
        return {
          stat: () => handle.stat(),
          async read(buffer, offset, length, position) {
            fileReads += 1;
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    });

    const roots = await service.listRoots("session-1");
    const additionalRoot = roots.find((root) => root.kind === "additional");
    assert.ok(additionalRoot);
    const result = await service.searchFiles({ sessionId: "session-1", query: "  READme " });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.groups.map((group) => group.root.id), ["workspace", additionalRoot.id]);
    assert.deepEqual(result.groups[0]?.entries.map((entry) => entry.relativePath), [
      "readme",
      "docs/readme-reference.txt",
      "README.md",
      "note-readme.txt",
      "docs/readme-folder/notes.txt",
    ]);
    assert.deepEqual(result.groups[1]?.entries.map((entry) => entry.relativePath), ["readme"]);
    assert.equal(result.exploredEntryCount > 0, true);
    assert.equal(fileReads, 0);
    assert.deepEqual(await service.searchFiles({ sessionId: "session-1", query: "secret" }), {
      status: "ok",
      groups: [],
      exploredEntryCount: result.exploredEntryCount,
      matchedFileCount: 0,
      returnedFileCount: 0,
    });
    await assert.rejects(() => stat(sessionFolderPath), { code: "ENOENT" });
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は探索中の identity mismatch で部分結果を返さない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-identity-"));
  const workspacePath = path.join(basePath, "workspace");
  const additionalPath = path.join(basePath, "additional");
  const outsidePath = path.join(basePath, "outside");
  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(additionalPath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    const outsideStats = await stat(outsidePath);
    const service = new SessionFileExplorerService({
      userDataPath: path.join(basePath, "user-data"),
      async getSessionContext() {
        return {
          workspacePath,
          parentSessionId: "session-1",
          allowedAdditionalDirectories: [additionalPath],
        };
      },
      async listDirectory(targetPath) {
        const targetStats = await stat(targetPath);
        if (path.resolve(targetPath) === path.resolve(additionalPath)) {
          return {
            device: outsideStats.dev,
            inode: outsideStats.ino,
            entries: [],
            maxConcurrentStats: 0,
          };
        }
        return {
          device: targetStats.dev,
          inode: targetStats.ino,
          entries: [{ name: "partial.txt", kind: "file", byteLength: 1, modifiedAt: null }],
          maxConcurrentStats: 0,
        };
      },
    });

    await assert.rejects(
      () => service.searchFiles({ sessionId: "session-1", query: "partial" }),
      /directory path が認可後に変更された/,
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は壊れた Session Folder の ENOTDIR を成功扱いで skip しない", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-session-folder-"));
  const workspacePath = path.join(basePath, "workspace");
  const userDataPath = path.join(basePath, "user-data");
  const sessionFolderPath = path.join(userDataPath, "session-files", "session-1");
  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(sessionFolderPath, { recursive: true });
    const service = new SessionFileExplorerService({
      userDataPath,
      getSessionContext: async () => ({
        workspacePath,
        parentSessionId: "session-1",
        allowedAdditionalDirectories: [],
      }),
      async openFile(targetPath, flags) {
        if (path.resolve(targetPath) === path.resolve(sessionFolderPath)) {
          const error = new Error("session folder directory open failed") as NodeJS.ErrnoException;
          error.code = "ENOTDIR";
          throw error;
        }
        return open(targetPath, flags);
      },
    });

    await assert.rejects(
      () => service.searchFiles({ sessionId: "session-1", query: "file" }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOTDIR"),
    );
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

function syntheticSearchFile(name: string) {
  return { name, kind: "file" as const, byteLength: 1, modifiedAt: null };
}

test("SessionFileExplorerService は調査件数上限と返却件数上限を typed result で返す", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-limit-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const entries = Array.from({ length: 4_001 }, (_, index) => (
    syntheticSearchFile(`target-${String(index).padStart(4, "0")}.txt`)
  ));
  let requestedMaxEntries: number | undefined;
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath, options) {
      requestedMaxEntries = options?.maxEntries;
      const targetStats = await stat(targetPath);
      return {
        device: targetStats.dev,
        inode: targetStats.ino,
        entries,
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const result = await service.searchFiles({ sessionId: "session-1", query: "target" });
    assert.equal(result.status, "limit-reached");
    assert.equal(result.limit, "exploration-and-results");
    assert.equal(result.exploredEntryCount, 4_000);
    assert.equal(result.matchedFileCount, 4_000);
    assert.equal(result.returnedFileCount, 50);
    assert.equal(result.groups[0]?.entries.length, 50);
    assert.equal(requestedMaxEntries, 4_000);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は返却上限まで遍歴した候補を ranking して返す", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-result-limit-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const entries = [
    ...Array.from({ length: 60 }, (_, index) => syntheticSearchFile(`a-z-${String(index).padStart(2, "0")}.txt`)),
    syntheticSearchFile("z"),
  ];
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath) {
      const targetStats = await stat(targetPath);
      return {
        device: targetStats.dev,
        inode: targetStats.ino,
        entries,
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const result = await service.searchFiles({ sessionId: "session-1", query: "z" });
    assert.equal(result.status, "limit-reached");
    assert.equal(result.limit, "results");
    assert.equal(result.exploredEntryCount, 61);
    assert.equal(result.matchedFileCount, 61);
    assert.equal(result.returnedFileCount, 50);
    assert.equal(result.groups[0]?.entries[0]?.name, "z");
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は search admission の active 2 / pending 16 と Session 単位 supersede を守る", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-admission-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  let activeListings = 0;
  let maxActiveListings = 0;
  let releaseListings!: () => void;
  let listingsReleased!: Promise<void>;
  const resetListingGate = () => {
    listingsReleased = new Promise<void>((resolve) => {
      releaseListings = resolve;
    });
  };
  resetListingGate();
  const createService = (sessionId: string) => new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: sessionId, allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath) {
      const targetStats = await stat(targetPath);
      activeListings += 1;
      maxActiveListings = Math.max(maxActiveListings, activeListings);
      try {
        await listingsReleased;
        return {
          device: targetStats.dev,
          inode: targetStats.ino,
          entries: [],
          maxConcurrentStats: 0,
        };
      } finally {
        activeListings -= 1;
      }
    },
  });
  try {
    const requests = Array.from({ length: 19 }, (_, index) => {
      const sessionId = `search-${index}`;
      return createService(sessionId).searchFiles({ sessionId, query: "file" });
    });
    const settledRequests = Promise.allSettled(requests);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(activeListings, 2);
    assert.ok(maxActiveListings <= 2);
    releaseListings();
    const results = await settledRequests;
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    resetListingGate();
    activeListings = 0;
    maxActiveListings = 0;
    const activeA = createService("active-a").searchFiles({ sessionId: "active-a", query: "file" });
    const activeB = createService("active-b").searchFiles({ sessionId: "active-b", query: "file" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(activeListings, 2);
    const supersededService = createService("superseded");
    const oldRequest = supersededService.searchFiles({ sessionId: "superseded", query: "old" });
    const newRequest = supersededService.searchFiles({ sessionId: "superseded", query: "new" });
    await assert.rejects(oldRequest, /superseded/);
    releaseListings();
    await Promise.all([activeA, activeB, newRequest]);
  } finally {
    releaseListings?.();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は新しい同一 Session の検索で in-flight scan を共有する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-shared-scan-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  let listingStarted!: () => void;
  let releaseListing!: () => void;
  const started = new Promise<void>((resolve) => {
    listingStarted = resolve;
  });
  const listingReleased = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  let listingCalls = 0;
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath, options) {
      const targetStats = await stat(targetPath);
      listingCalls += 1;
      const signal = options?.signal;
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      listingStarted();
      await listingReleased;
      return {
        device: targetStats.dev,
        inode: targetStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const oldRequest = service.searchFiles({ sessionId: "session-1", query: "old" });
    await started;
    const newRequest = service.searchFiles({ sessionId: "session-1", query: "new" });
    await assert.rejects(oldRequest, /superseded/);
    assert.equal(listingCalls, 1);
    releaseListing();
    const result = await newRequest;
    assert.equal(result.status, "ok");
    assert.equal(result.returnedFileCount, 0);
  } finally {
    releaseListing?.();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は明示的な cancel で active search と worker を止める", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-explicit-cancel-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  let listingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    listingStarted = resolve;
  });
  const service = new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath, options) {
      const targetStats = await stat(targetPath);
      const signal = options?.signal;
      assert.ok(signal);
      listingStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("directory listing was cancelled")), { once: true });
      });
      return {
        device: targetStats.dev,
        inode: targetStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const request = service.searchFiles({ sessionId: "session-1", query: "file" });
    await started;
    service.cancelSearch({ sessionId: "session-1" });
    await assert.rejects(request, /cancelled/);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("SessionFileExplorerService は pending 満杯でも active 同一 Session の scan を共有する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-file-search-shared-admission-"));
  const workspacePath = path.join(basePath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  let targetListingStarted!: () => void;
  let blockerListingStarted!: () => void;
  let releaseTarget!: () => void;
  let releaseBlockers!: () => void;
  const targetStarted = new Promise<void>((resolve) => {
    targetListingStarted = resolve;
  });
  const blockerStarted = new Promise<void>((resolve) => {
    blockerListingStarted = resolve;
  });
  const targetReleased = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  const blockersReleased = new Promise<void>((resolve) => {
    releaseBlockers = resolve;
  });
  let targetListingCalls = 0;
  const createService = (sessionId: string) => new SessionFileExplorerService({
    userDataPath: path.join(basePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: sessionId, allowedAdditionalDirectories: [] }),
    async listDirectory(targetPath, options) {
      const targetStats = await stat(targetPath);
      if (sessionId === "replacement-target") {
        targetListingCalls += 1;
        targetListingStarted();
        await targetReleased;
      } else if (sessionId === "replacement-blocker") {
        blockerListingStarted();
        await blockersReleased;
      }
      return {
        device: targetStats.dev,
        inode: targetStats.ino,
        entries: [],
        maxConcurrentStats: 0,
      };
    },
  });
  try {
    const targetService = createService("replacement-target");
    const oldRequest = targetService.searchFiles({ sessionId: "replacement-target", query: "old" });
    await targetStarted;
    const blockerRequest = createService("replacement-blocker").searchFiles({
      sessionId: "replacement-blocker",
      query: "block",
    });
    await blockerStarted;
    const queuedRequests = Array.from({ length: 16 }, (_, index) => {
      const sessionId = `replacement-queued-${index}`;
      return createService(sessionId).searchFiles({ sessionId, query: "queued" });
    });
    const replacementRequest = targetService.searchFiles({ sessionId: "replacement-target", query: "new" });
    await assert.rejects(oldRequest, /superseded/);
    assert.equal(targetListingCalls, 1);
    releaseTarget();
    const sharedResult = await replacementRequest;
    assert.equal(sharedResult.status, "ok");
    assert.equal(sharedResult.returnedFileCount, 0);
    releaseBlockers();
    await Promise.all([blockerRequest, ...queuedRequests]);
  } finally {
    releaseTarget?.();
    releaseBlockers?.();
    await rm(basePath, { recursive: true, force: true });
  }
});
