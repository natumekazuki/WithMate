import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHtmlPreviewResources } from "../../src-electron/files/html-preview-resources.js";
import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";
import { FileRootGitChangesService } from "../../src-electron/files/file-root-git-changes-service.js";

function explorerAt(workspacePath: string) {
  return new SessionFileExplorerService({
    userDataPath: path.join(workspacePath, "user-data"),
    getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
  });
}
const noGit = { readHtmlPreviewHistoryFile: async (): Promise<Uint8Array> => { throw new Error("Unexpected Git read"); } };
const request = (headers?: HeadersInit) => new Request("https://preview.invalid/", { headers });

// @test-value v2
// kind = "contract"
// claim = "HTML resource provider preserves directory-relative encoded asset paths, MIME, and byte ranges without modifying files"
// oracle = { type = "contract", ref = "user request: original local HTML with relative CSS/JS/resources; HTTP byte range semantics" }
// fault = "provider flattens nested paths, supplies script/style with incorrect MIME, or returns wrong media bytes"
// observable = "provider pathname, CSS/JS response bodies and MIME, range status/body/headers"
// observation_boundary = "public-boundary"
// scope = "HTML resource provider and real local filesystem"
// lifecycle = "permanent"
// impact = "nested stylesheet/script references and media seeking remain usable"
// distinction = "existing file explorer chunk tests do not exercise URL mapping, resource MIME, or HTTP ranges; this small filesystem test covers that boundary"
// @end-test-value
test("HTML resources preserve nested paths, MIME and ranges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-html-assets-"));
  try {
    await mkdir(path.join(directory, "日本語", "styles"), { recursive: true });
    await writeFile(path.join(directory, "日本語", "index.html"), "original");
    await writeFile(path.join(directory, "日本語", "styles", "main.css"), "@import './nested.css';");
    await writeFile(path.join(directory, "日本語", "styles", "nested.css"), "p { color: red }");
    await writeFile(path.join(directory, "日本語", "app.js"), "window.loaded=true");
    await writeFile(path.join(directory, "日本語", "clip.mp4"), "0123456789");
    const provider = await createHtmlPreviewResources(explorerAt(directory), noGit,
      { sessionId: "session-1", rootId: "workspace", relativePath: "日本語/index.html" });
    assert.equal(provider.pathname, `/${encodeURIComponent("日本語")}/index.html`);
    const cssUrl = new URL("styles/main.css", `https://preview.invalid${provider.pathname}`);
    const css = await provider.read(cssUrl.pathname, request());
    assert.equal(css.headers.get("Content-Type"), "text/css");
    assert.equal(await css.text(), "@import './nested.css';");
    assert.equal(await (await provider.read(new URL("nested.css", cssUrl).pathname, request())).text(), "p { color: red }");
    const script = await provider.read(new URL("app.js", cssUrl.origin + provider.pathname).pathname, request());
    assert.equal(script.headers.get("Content-Type"), "text/javascript");
    assert.equal(await script.text(), "window.loaded=true");
    const mediaPath = new URL("clip.mp4", cssUrl.origin + provider.pathname).pathname;
    const media = await provider.read(mediaPath, request({ Range: "bytes=2-5" }));
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(await media.text(), "2345");
    assert.equal(await (await provider.read(mediaPath, request({ Range: "bytes=-2" }))).text(), "89");
    assert.equal((await provider.read(mediaPath, request({ Range: "bytes=10-" }))).status, 416);
    assert.equal(await (await provider.read(provider.pathname, request())).text(), "original");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "HTML asset reads stay inside the authorized root or absolute source parent and reject escaping symlinks and replaced roots"
// oracle = { type = "contract", ref = "user request: retain Session/File Preview authorization and prevent arbitrary filesystem reads" }
// fault = "URL decoding or symlink/root replacement permits reading outside the source's pinned resource root"
// observable = "provider read rejection for traversal, outside junction, and root replacement; successful absolute-parent asset body"
// observation_boundary = "public-boundary"
// scope = "HTML resource provider plus identity-bound local file open"
// lifecycle = "permanent"
// impact = "untrusted HTML cannot read unrelated local files through resource requests"
// distinction = "existing explorer tests do not cover the provider URL decoder, canonical absolute parent scope, and root lifetime together; small filesystem fixture retains direct coverage"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("HTML resources reject traversal, escaping links and root replacement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-html-root-"));
  try {
    const workspace = path.join(directory, "workspace");
    const outside = path.join(directory, "outside");
    await mkdir(workspace); await mkdir(outside);
    await writeFile(path.join(workspace, "index.html"), "html");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await writeFile(path.join(outside, "index.html"), "outside html");
    await symlink(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    const explorer = explorerAt(workspace);
    const provider = await createHtmlPreviewResources(explorer, noGit,
      { sessionId: "session-1", rootId: "workspace", relativePath: "index.html" });
    for (const target of ["/../outside/secret.txt", "/%2e%2e/secret.txt", "/%2fsecret.txt", "/C%3a/secret.txt", "/escape/secret.txt"]) {
      await assert.rejects(provider.read(target, request()));
    }
    const absolute = await createHtmlPreviewResources(explorer, noGit,
      { sessionId: "session-1", absolutePath: path.join(outside, "index.html") });
    assert.equal(absolute.pathname, "/index.html");
    assert.equal(await (await absolute.read("/secret.txt", request())).text(), "secret");
    await assert.rejects(absolute.read("/../workspace/index.html", request()));
    await rename(workspace, path.join(directory, "old-workspace"));
    await mkdir(workspace);
    await writeFile(path.join(workspace, "index.html"), "replacement");
    await assert.rejects(provider.read("/index.html", request()), /root changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "Git HTML assets come from the selected commit and regular blobs only, even when working files differ or missing assets exist locally"
// oracle = { type = "contract", ref = "user request: Git preview must not silently use current resources" }
// fault = "provider reads working tree data, follows a committed symlink, or falls back for an absent historical asset"
// observable = "historical CSS response body and rejection for symlink/missing historical assets"
// observation_boundary = "public-boundary"
// scope = "resource provider and real Git history blob reader"
// lifecycle = "permanent"
// impact = "history preview remains reproducible and does not expose current files through commit links"
// distinction = "existing history tests cover file chunks but not asset URL mapping or regular-blob enforcement; one tiny repository exercises these real Git contracts"
// @end-test-value
test("Git HTML resources read selected-commit regular blobs only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-html-git-"));
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", directory, ...args], { windowsHide: true })).stdout.trim();
  try {
    await git("init", "--quiet");
    await writeFile(path.join(directory, "index.html"), "html");
    await writeFile(path.join(directory, "style.css"), "old css");
    await writeFile(path.join(directory, "link.txt"), "style.css");
    await git("add", ".");
    const linkBlob = await git("hash-object", "link.txt");
    await git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},link.css`);
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
    const commitId = await git("rev-parse", "HEAD");
    await writeFile(path.join(directory, "style.css"), "current css");
    await writeFile(path.join(directory, "new.css"), "current only");
    const history = new FileRootGitChangesService({
      resolveRootContext: async () => ({ rootPath: directory }),
      resolveHistoryRootContexts: async () => [{ rootId: "workspace", label: "Workspace", displayPath: directory, rootPath: directory }],
      resolveHistoryRootContext: async () => ({ rootPath: directory }),
    });
    const repositories = await history.listHistoryRepositories({ sessionId: "session-1" });
    assert.equal(repositories.status, "ok");
    if (repositories.status !== "ok") throw new Error("Expected Git history repository");
    const provider = await createHtmlPreviewResources(explorerAt(directory), history, {
      resourceKind: "git-commit-file", sessionId: "session-1", rootId: "workspace",
      repositoryId: repositories.repositories[0]!.repositoryId, commitId, relativePath: "index.html",
    });
    assert.equal(await (await provider.read("/style.css", request())).text(), "old css");
    await assert.rejects(provider.read("/new.css", request()), /not previewable/);
    await assert.rejects(provider.read("/link.css", request()), /symbolic links/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
