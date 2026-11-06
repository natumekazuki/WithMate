import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { SessionLifecycleResource } from "./session-lifecycle-operation.js";
import { renameDirectoryNoReplace } from "../platform/filesystem/rename-directory-no-replace.js";

export type PrepareSessionLifecycleFilesInput = {
  finalPath: string;
  resource?: SessionLifecycleResource;
  persistResource(resource: SessionLifecycleResource): Promise<void>;
};

export async function prepareSessionLifecycleFiles(input: PrepareSessionLifecycleFilesInput): Promise<string> {
  const finalPath = path.resolve(input.finalPath);
  let resource = input.resource;
  if (!resource) {
    await mkdir(path.dirname(finalPath), { recursive: true });
    const stagingPath = await mkdtemp(path.join(path.dirname(finalPath), `.withmate-create-${path.basename(finalPath)}-`));
    const captured = await captureSessionLifecycleResource(stagingPath);
    resource = { ...captured, path: finalPath, stagingPath };
    await input.persistResource(resource);
  }
  if (path.resolve(resource.path) !== finalPath) throw new Error("The reserved SessionFolder path no longer matches its creation operation.");
  try {
    await assertSessionLifecycleResource(resource);
    return finalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!resource.stagingPath) throw new Error("The SessionFolder creation has no recorded staging directory; recovery is pending.");
  await assertSessionLifecycleResource({ ...resource, path: resource.stagingPath });
  renameDirectoryNoReplace(resource.stagingPath, finalPath);
  await assertSessionLifecycleResource(resource);
  return finalPath;
}

export async function captureSessionLifecycleResource(directoryPath: string): Promise<SessionLifecycleResource> {
  const absolutePath = path.resolve(directoryPath);
  const stat = await lstat(absolutePath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The owned Session folder must be a real directory.");
  return { path: absolutePath, device: stat.dev.toString(), inode: stat.ino.toString(), cleaned: false };
}

export async function assertSessionLifecycleResource(resource: SessionLifecycleResource): Promise<void> {
  const current = await captureSessionLifecycleResource(resource.path);
  if (current.device !== resource.device || current.inode !== resource.inode) throw new Error("The owned Session folder identity changed; cleanup requires recovery.");
}

export async function cleanupSessionLifecycleResource(resource: SessionLifecycleResource): Promise<SessionLifecycleResource> {
  if (resource.cleaned) return resource;
  try {
    await assertSessionLifecycleResource(resource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...resource, cleaned: true };
    throw error;
  }
  await rm(resource.path, { recursive: true });
  return { ...resource, cleaned: true };
}
