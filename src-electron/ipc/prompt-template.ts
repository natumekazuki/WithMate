import type {
  CreatePromptTemplateInput,
  UpdatePromptTemplateInput,
} from "../../src-shared/prompt-template.js";

import {
  WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
  WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
  WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL,
  WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

import type {
  IpcHandleRegistrar,
  MainIpcPromptTemplateDeps,
} from "./contracts.js";

export function registerPromptTemplateHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcPromptTemplateDeps,
): void {
  ipcMain.handle(WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL, () =>
    deps.listPromptTemplates(),
  );
  ipcMain.handle(
    WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
    (_event, input: CreatePromptTemplateInput) =>
      deps.createPromptTemplate(input),
  );
  ipcMain.handle(
    WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
    (_event, input: UpdatePromptTemplateInput) =>
      deps.updatePromptTemplate(input),
  );
  ipcMain.handle(
    WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
    (_event, id: string) => deps.deletePromptTemplate(id),
  );
}
