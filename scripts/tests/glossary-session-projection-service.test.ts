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
import type { GlossaryProjectionState, GlossarySnapshot } from "../../src/glossary-contract.js";

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

  it("並行watch deliveryは新しいeventを優先し、遅れて完了した古いstateを破棄する", async () => {
    const { root, target } = await createRepository();
    let releaseFirstScope: (() => void) | null = null;
    const firstScope = new Promise<void>((resolve) => {
      releaseFirstScope = resolve;
    });
    let resolveCount = 0;
    let emit: ((state: GlossaryProjectionState) => void) | null = null;
    class DelayedProjectionService extends GlossaryApplicationService {
      override async resolvePrimaryCheckout(): Promise<ResolvedGlossaryCheckout> {
        resolveCount += 1;
        if (resolveCount === 2) {
          await firstScope;
        }
        return target;
      }

      override async describeCheckout() {
        return { repositoryName: "repository", branch: "main", pathLabel: "repository" };
      }

      override subscribe(
        _target: ResolvedGlossaryCheckout,
        listener: (state: GlossaryProjectionState) => void,
      ): () => void {
        emit = listener;
        return () => undefined;
      }
    }
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService: new DelayedProjectionService(),
      getSession: () => session,
      getBindingGeneration: () => "generation-1",
    });
    const projections: string[] = [];
    const dispose = await service.subscribe(session.id, (projection) => {
      projections.push(projection.state.status === "valid" ? projection.state.entries[0]?.term ?? "" : projection.state.status);
    });
    const firstState: GlossaryProjectionState = {
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "old",
      issues: [{ path: "$", code: "INVALID_YAML", message: "old invalid state" }],
    };
    const secondState: GlossaryProjectionState = {
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision: "new",
      entries: [{ term: "Current", aliases: [], definition: "current state" }],
    };

    emit?.(firstState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit?.(secondState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstScope?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(projections, ["Current"]);
    dispose();
  });

  it("並行scope re-armは古いattemptを破棄し、disposeで全watch handleを閉じる", async () => {
    const repositoryA = await createRepository();
    const repositoryB = await createRepository();
    const repositoryC = await createRepository();
    let session = {
      id: "session-1",
      provider: "codex",
      workspacePath: repositoryA.root,
      workspaceLabel: "repository-a",
      branch: "main",
    };
    let releaseSlowArm: (() => void) | null = null;
    const slowArm = new Promise<void>((resolve) => {
      releaseSlowArm = resolve;
    });
    let markSlowArmStarted: (() => void) | null = null;
    const slowArmStarted = new Promise<void>((resolve) => {
      markSlowArmStarted = resolve;
    });
    let repositoryBResolves = 0;
    type Subscription = {
      target: ResolvedGlossaryCheckout;
      listener: (state: GlossaryProjectionState) => void;
      closed: boolean;
    };
    const subscriptions: Subscription[] = [];
    class RearmingProjectionService extends GlossaryApplicationService {
      override async resolvePrimaryCheckout(workspacePath: string): Promise<ResolvedGlossaryCheckout> {
        if (workspacePath === repositoryB.root) {
          repositoryBResolves += 1;
          if (repositoryBResolves === 2) {
            markSlowArmStarted?.();
            await slowArm;
          }
          return repositoryB.target;
        }
        return workspacePath === repositoryC.root ? repositoryC.target : repositoryA.target;
      }

      override async describeCheckout(target: ResolvedGlossaryCheckout) {
        return {
          repositoryName: path.basename(target.rootPath),
          branch: "main",
          pathLabel: path.basename(target.rootPath),
        };
      }

      override subscribe(
        target: ResolvedGlossaryCheckout,
        listener: (state: GlossaryProjectionState) => void,
      ): () => void {
        const subscription = { target, listener, closed: false };
        subscriptions.push(subscription);
        return () => {
          subscription.closed = true;
        };
      }
    }
    const service = new GlossarySessionProjectionService({
      applicationService: new RearmingProjectionService(),
      getSession: () => session,
      getBindingGeneration: () => "generation-1",
    });
    const dispose = await service.subscribe(session.id, () => undefined);
    const staleState: GlossaryProjectionState = {
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "stale",
      issues: [{ path: "$", code: "INVALID_YAML", message: "stale state" }],
    };

    session = { ...session, workspacePath: repositoryB.root, workspaceLabel: "repository-b" };
    subscriptions[0].listener(staleState);
    await slowArmStarted;
    session = { ...session, workspacePath: repositoryC.root, workspaceLabel: "repository-c" };
    subscriptions[0].listener(staleState);
    for (let attempt = 0; attempt < 20 && subscriptions.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseSlowArm?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(subscriptions.map((subscription) => subscription.target.rootPath), [
      repositoryA.target.rootPath,
      repositoryC.target.rootPath,
    ]);
    dispose();
    assert.equal(subscriptions.every((subscription) => subscription.closed), true);
  });
});
