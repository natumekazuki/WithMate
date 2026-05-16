import type { AppSettings } from "../provider-settings-state.js";
import { getProviderAppSettings } from "../provider-settings-state.js";
import type { HomeProviderInstructionTargetDraft } from "./provider-instruction-target-draft.js";
import {
  buildFallbackProviderInstructionTarget,
  isProviderInstructionFailPolicy,
  isProviderInstructionWriteMode,
} from "./provider-instruction-target-draft.js";
import {
  buildHomeProviderInstructionTargetUpsertInput,
  resolveInstructionRelativePathFromSelection,
} from "./settings-view-model.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export type HomeProviderInstructionTargetApi = Pick<
  WithMateWindowApi,
  "pickFile" | "upsertProviderInstructionTarget"
>;

type ProviderInstructionTargetActionContext = {
  providerInstructionTargets: readonly HomeProviderInstructionTargetDraft[];
  settingsDraft: AppSettings;
  setProviderInstructionTargets: (
    updater: (current: HomeProviderInstructionTargetDraft[]) => HomeProviderInstructionTargetDraft[],
  ) => void;
  setSettingsFeedback: (feedback: string) => void;
  api: HomeProviderInstructionTargetApi | null;
};

type UpsertHomeProviderInstructionTargetInput = {
  target: HomeProviderInstructionTargetDraft;
  setSettingsFeedback: (feedback: string) => void;
  api: HomeProviderInstructionTargetApi | null;
};

export async function upsertProviderInstructionTarget({
  target,
  setSettingsFeedback,
  api,
}: UpsertHomeProviderInstructionTargetInput): Promise<void> {
  if (!api) {
    return;
  }

  try {
    await api.upsertProviderInstructionTarget(buildHomeProviderInstructionTargetUpsertInput(target));
  } catch (error) {
    setSettingsFeedback(
      error instanceof Error
        ? error.message
        : "Provider Instruction Sync の保存に失敗したよ。",
    );
  }
}

export function updateProviderInstructionTarget({
  providerId,
  patch,
  providerInstructionTargets,
  settingsDraft,
  setProviderInstructionTargets,
  setSettingsFeedback,
  api,
}: ProviderInstructionTargetActionContext & {
  providerId: string;
  patch: Partial<HomeProviderInstructionTargetDraft>;
}): void {
  const current = providerInstructionTargets.find((next) => next.providerId === providerId);
  const fallback = buildFallbackProviderInstructionTarget(providerId);
  const rootDirectory = getProviderAppSettings(settingsDraft, providerId).skillRootPath.trim();
  const nextTarget = {
    ...(current ?? fallback),
    ...patch,
    rootDirectory,
    providerId,
  };
  setProviderInstructionTargets((previous) => {
    const index = previous.findIndex((candidate) => candidate.providerId === providerId);
    if (index === -1) {
      return [...previous, nextTarget];
    }

    const updated = [...previous];
    updated[index] = nextTarget;
    return updated;
  });
  void upsertProviderInstructionTarget({
    target: nextTarget,
    api,
    setSettingsFeedback,
  });
}

export function handleChangeProviderInstructionEnabled({
  providerId,
  enabled,
  ...context
}: ProviderInstructionTargetActionContext & {
  providerId: string;
  enabled: boolean;
}): void {
  updateProviderInstructionTarget({
    ...context,
    providerId,
    patch: { enabled },
  });
}

export function handleChangeProviderInstructionWriteMode({
  providerId,
  writeMode,
  ...context
}: ProviderInstructionTargetActionContext & {
  providerId: string;
  writeMode: string;
}): void {
  if (!isProviderInstructionWriteMode(writeMode)) {
    return;
  }

  updateProviderInstructionTarget({
    ...context,
    providerId,
    patch: { writeMode },
  });
}

export function handleChangeProviderInstructionFailPolicy({
  providerId,
  failPolicy,
  ...context
}: ProviderInstructionTargetActionContext & {
  providerId: string;
  failPolicy: string;
}): void {
  if (!isProviderInstructionFailPolicy(failPolicy)) {
    return;
  }

  updateProviderInstructionTarget({
    ...context,
    providerId,
    patch: { failPolicy },
  });
}

export function handleChangeProviderInstructionInstructionRelativePath({
  providerId,
  instructionRelativePath,
  ...context
}: ProviderInstructionTargetActionContext & {
  providerId: string;
  instructionRelativePath: string;
}): void {
  updateProviderInstructionTarget({
    ...context,
    providerId,
    patch: { instructionRelativePath },
  });
}

export async function handleBrowseProviderInstructionInstructionRelativePath({
  providerId,
  ...context
}: ProviderInstructionTargetActionContext & { providerId: string }): Promise<void> {
  const { api, settingsDraft, setSettingsFeedback } = context;
  if (!api) {
    return;
  }

  const currentSettings = getProviderAppSettings(settingsDraft, providerId);
  const rootDirectory = currentSettings.skillRootPath.trim();
  if (!rootDirectory.trim()) {
    setSettingsFeedback("Instruction Relative Path を選ぶ前に Root Directory を指定してね。");
    return;
  }

  const selectedPath = await api.pickFile(rootDirectory);
  if (!selectedPath) {
    return;
  }

  const relativePath = resolveInstructionRelativePathFromSelection(rootDirectory, selectedPath);
  if (relativePath === null) {
    setSettingsFeedback("Root Directory 配下の instruction file を選んでね。");
    return;
  }

  handleChangeProviderInstructionInstructionRelativePath({
    ...context,
    providerId,
    instructionRelativePath: relativePath,
  });
}
