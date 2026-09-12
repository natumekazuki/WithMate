import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import type { ModelCatalogSnapshot, ModelReasoningEffort } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import { SessionCrudError } from "./session-crud-service.js";
import { isPathWithinDirectory, normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

export type LifecycleProviderTuple = {
  id: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  threadContinuity: "continue" | "reset";
};

export type LifecycleWorkspaceInput = { kind: "session_folder" } | { kind: "directory"; path: string };

export class SessionLifecycleResolver {
  constructor(private readonly deps: {
    currentModelCatalog(): ModelCatalogSnapshot | null;
    isProviderEnabled(providerId: string): boolean;
    isProviderSupported(providerId: string): boolean;
    listCharacters(): CharacterCatalogEntry[];
    createCharacterRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null;
    resolveSessionFilesDirectory(sessionId: string): string;
  }) {}

  provider(input: LifecycleProviderTuple, current?: Session): Pick<Session,
    "provider" | "catalogRevision" | "model" | "reasoningEffort" | "threadId"
  > {
    const catalog = this.deps.currentModelCatalog();
    if (!catalog || !this.deps.isProviderEnabled(input.id) || !this.deps.isProviderSupported(input.id)) {
      throw new SessionCrudError("RUNTIME_UNAVAILABLE", "The selected Provider is unavailable.", true);
    }
    if (catalog.revision !== input.catalogRevision) {
      throw new SessionCrudError("CATALOG_REVISION_STALE", "The model catalog has changed.", true, {
        requestedRevision: input.catalogRevision, currentRevision: catalog.revision,
      });
    }
    const model = catalog.providers.find((entry) => entry.id === input.id)?.models.find((entry) => entry.id === input.model);
    if (!model || !model.reasoningEfforts.includes(input.reasoningEffort)) {
      throw new SessionCrudError("INVALID_INPUT", "The Provider, model and reasoning tuple is unavailable.", false, { field: "provider" });
    }
    if (input.threadContinuity === "continue" && (!current || current.provider !== input.id)) {
      throw new SessionCrudError("INVALID_INPUT", "Thread continuity requires the same existing Provider.", false, { field: "provider.threadContinuity" });
    }
    return {
      provider: input.id, catalogRevision: input.catalogRevision, model: input.model,
      reasoningEffort: input.reasoningEffort,
      threadId: input.threadContinuity === "continue" ? current!.threadId : "",
    };
  }

  providerForGui(input: LifecycleProviderTuple, current: Session): ReturnType<SessionLifecycleResolver["provider"]> {
    const selectionUnchanged = input.id === current.provider
      && input.model === current.model && input.reasoningEffort === current.reasoningEffort;
    return this.provider(selectionUnchanged
      ? { ...input, catalogRevision: this.deps.currentModelCatalog()?.revision ?? input.catalogRevision }
      : input, current);
  }

  character(characterId: string, expectedDefinitionSha256?: string): Pick<Session,
    "characterId" | "character" | "characterIconPath" | "characterThemeColors" | "characterRuntimeSnapshot"
  > {
    const entry = this.deps.listCharacters().find((candidate) => candidate.id === characterId && candidate.state === "active");
    if (!entry) throw new SessionCrudError("INVALID_INPUT", "The selected Character is not active.", false, { field: "character" });
    const snapshot = this.deps.createCharacterRuntimeSnapshot(characterId);
    if (!snapshot || snapshot.characterId !== entry.id) {
      throw new SessionCrudError("RUNTIME_UNAVAILABLE", "The Character runtime snapshot is unavailable.", true);
    }
    if (expectedDefinitionSha256 !== undefined && snapshot.definitionSha256 !== expectedDefinitionSha256) {
      throw new SessionCrudError("CHARACTER_REVISION_CONFLICT", "The Character definition has changed.", true);
    }
    return {
      characterId: snapshot.characterId, character: snapshot.name, characterIconPath: snapshot.iconFilePath,
      characterThemeColors: { ...snapshot.theme }, characterRuntimeSnapshot: snapshot,
    };
  }

  async workspace(sessionId: string, input: LifecycleWorkspaceInput): Promise<Pick<Session, "workspacePath" | "workspaceLabel" | "branch">> {
    if (input.kind === "session_folder") {
      return { workspacePath: this.deps.resolveSessionFilesDirectory(sessionId), workspaceLabel: "SessionFolder", branch: "" };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(input.path);
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new SessionCrudError("INVALID_INPUT", "The workspace must reference an existing directory.", false, { field: "workspace.path" });
    }
    return { workspacePath: canonicalPath, workspaceLabel: path.basename(canonicalPath) || canonicalPath, branch: "" };
  }

  additionalDirectories(workspacePath: string, directoryPaths: readonly string[]): string[] {
    const requested = directoryPaths.map((directoryPath) => directoryPath.trim()).filter(Boolean);
    if (requested.some((directoryPath) => isPathWithinDirectory(directoryPath, workspacePath))) {
      throw new SessionCrudError("INVALID_INPUT", "Additional directories must be outside the workspace.", false, { field: "provider.allowedAdditionalDirectories" });
    }
    return normalizeAllowedAdditionalDirectories(workspacePath, requested);
  }
}
