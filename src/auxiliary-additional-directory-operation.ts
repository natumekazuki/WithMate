import { resolveAdditionalDirectoryPickerBase } from "./additional-directory-state.js";
import type { AuxiliarySession } from "./auxiliary-session-state.js";
import {
  addAuxiliarySessionAdditionalDirectory,
  removeAuxiliarySessionAdditionalDirectory,
} from "./auxiliary-session-state.js";

type UpdateAuxiliarySession = (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
) => Promise<void>;

export function resolveAuxiliaryAdditionalDirectoryPickerBase(input: {
  pickerBaseDirectory: string;
  workspacePath?: string | null;
  fallbackPath?: string | null;
}): string | null {
  return resolveAdditionalDirectoryPickerBase(input.pickerBaseDirectory, input.workspacePath, input.fallbackPath);
}

export async function runAddAuxiliaryAdditionalDirectoryOperation(input: {
  activeAuxiliarySession: AuxiliarySession | null;
  pickerBaseDirectory: string;
  workspacePath?: string | null;
  fallbackPath?: string | null;
  pickDirectory: (basePath: string | null) => Promise<string | null>;
  setPickerBaseDirectory: (directoryPath: string) => void;
  updateActiveAuxiliarySession: UpdateAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  if (!input.activeAuxiliarySession || input.activeAuxiliarySession.runState === "running") {
    return;
  }

  const selectedPath = await input.pickDirectory(resolveAuxiliaryAdditionalDirectoryPickerBase(input));
  if (!selectedPath) {
    return;
  }

  input.setPickerBaseDirectory(selectedPath);
  await input.updateActiveAuxiliarySession((current) => (
    addAuxiliarySessionAdditionalDirectory(current, selectedPath, input.createTimestampLabel())
  ));
}

export async function runAddAuxiliaryAdditionalDirectoryOperationWithApi(input: {
  api: {
    pickDirectory: (basePath: string | null) => Promise<string | null>;
  } | null | undefined;
  hasParentSession: boolean;
  activeAuxiliarySession: AuxiliarySession | null;
  pickerBaseDirectory: string;
  workspacePath?: string | null;
  fallbackPath?: string | null;
  setPickerBaseDirectory: (directoryPath: string) => void;
  updateActiveAuxiliarySession: UpdateAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  const api = input.api;
  if (!api || !input.hasParentSession) {
    return;
  }

  await runAddAuxiliaryAdditionalDirectoryOperation({
    activeAuxiliarySession: input.activeAuxiliarySession,
    pickerBaseDirectory: input.pickerBaseDirectory,
    workspacePath: input.workspacePath,
    fallbackPath: input.fallbackPath,
    pickDirectory: (basePath) => api.pickDirectory(basePath),
    setPickerBaseDirectory: input.setPickerBaseDirectory,
    updateActiveAuxiliarySession: input.updateActiveAuxiliarySession,
    createTimestampLabel: input.createTimestampLabel,
  });
}

export async function runRemoveAuxiliaryAdditionalDirectoryOperation(input: {
  directoryPath: string;
  updateActiveAuxiliarySession: UpdateAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    removeAuxiliarySessionAdditionalDirectory(current, input.directoryPath, input.createTimestampLabel())
  ));
}
