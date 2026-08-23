import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  GlossaryApplicationService,
  serializeGlossaryDocument,
  type ResolvedGlossaryCheckout,
} from "../../src-electron/glossary-application-service.js";
import { GlossarySessionProjectionService } from "../../src-electron/glossary-session-projection-service.js";
import type { GlossarySnapshot } from "../../src/glossary-contract.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{ root: string; target: ResolvedGlossaryCheckout }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-projection-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  const service = new GlossaryApplicationService();
  return { root, target: await service.resolvePrimaryCheckout(root) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GLOSSARY-CHECKOUT-AUTHORITY renderer projection", () => {
  it("binding generationがread中に変わった場合は旧scope responseを捨ててcurrent scopeを再読込する", async () => {
    const { root } = await createRepository();
    await mkdir(path.join(root, ".withmate"));
    await writeFile(path.join(root, ".withmate", "glossary.yaml"), serializeGlossaryDocument([
      { term: "Runtime", aliases: ["RT"], definition: "Current definition" },
    ]), "utf8");

    let generation = "generation-1";
    class GenerationChangingService extends GlossaryApplicationService {
      readCount = 0;

      override async read(target: ResolvedGlossaryCheckout): Promise<GlossarySnapshot> {
        this.readCount += 1;
        const snapshot = await super.read(target);
        if (this.readCount === 1) {
          generation = "generation-2";
        }
        return snapshot;
      }
    }
    const applicationService = new GenerationChangingService();
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService,
      getSession: (sessionId) => sessionId === session.id ? session : null,
      getBindingGeneration: () => generation,
    });

    const projection = await service.load(session.id);
    const current = await service.load(session.id);
    assert.equal(applicationService.readCount, 3);
    assert.equal(projection.scopeRevision, current.scopeRevision);
    assert.equal(projection.state.status, "valid");
    assert.equal(projection.checkout.pathLabel, path.basename(root));
    assert.equal(JSON.stringify(projection).includes(root), false);
    assert.ok(current.sequence > projection.sequence);
  });

  it("invalid化ではlast valid entryを返さず、searchもapplication serviceのvalidationを共有する", async () => {
    const { root } = await createRepository();
    await mkdir(path.join(root, ".withmate"));
    const glossaryPath = path.join(root, ".withmate", "glossary.yaml");
    await writeFile(glossaryPath, serializeGlossaryDocument([
      { term: "Runtime", aliases: [], definition: "Current definition" },
    ]), "utf8");
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService: new GlossaryApplicationService(),
      getSession: () => session,
      getBindingGeneration: () => null,
    });
    assert.equal((await service.load(session.id)).state.status, "valid");

    await writeFile(glossaryPath, "schemaVersion: [\n", "utf8");
    const invalid = await service.load(session.id);
    assert.equal(invalid.state.status, "invalid");
    assert.equal("entries" in invalid.state, false);
    const search = await service.search(session.id, { query: "runtime" });
    assert.equal(search.ok, false);
    if (!search.ok) {
      assert.equal(search.code, "GLOSSARY_INVALID_FILE");
    }
  });
});
