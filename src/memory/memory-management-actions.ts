import type { WithMateWindowApi } from "../withmate-window-api.js";
import { getMemoryManagementCursor, normalizeMemoryManagementPages, type MemoryManagementPageState } from "./memory-management-page-state.js";
import {
  buildMemoryManagementPageRequest,
  mergeMemoryManagementSnapshots,
  removeMateProfileItemFromSnapshot,
  removeProjectMemoryEntryFromSnapshot,
  removeSessionMemoryFromSnapshot,
  type MemoryManagementDomain,
  type MemoryManagementSnapshot,
} from "./memory-management-state.js";
import type { MemoryManagementViewFilters } from "./memory-management-view.js";
import { type MateEmbeddingSettings } from "../mate/mate-embedding-settings.js";

export const MEMORY_MANAGEMENT_PAGE_LIMIT = 50;

export type HomeMemoryManagementApi = Pick<
  WithMateWindowApi,
  | "getMemoryManagementPage"
  | "deleteSessionMemory"
  | "deleteProjectMemoryEntry"
  | "forgetMateProfileItem"
>;

export type SetMemoryManagementSnapshot = (
  snapshot: MemoryManagementSnapshot | null | ((current: MemoryManagementSnapshot | null) => MemoryManagementSnapshot),
) => void;

export type SetMemoryManagementPages = (
  pages: MemoryManagementPageState | ((current: MemoryManagementPageState) => MemoryManagementPageState),
) => void;

type MemoryManagementActionState = {
  filters: MemoryManagementViewFilters;
  pageLimit: number;
  beginRequest: () => number;
  isLatestRequest: (requestId: number) => boolean;
  setLoaded: (loaded: boolean) => void;
  setSnapshot: SetMemoryManagementSnapshot;
  setPages: SetMemoryManagementPages;
  setFeedback: (message: string) => void;
};

export type ReloadMemoryManagementInput = MemoryManagementActionState & {
  api: HomeMemoryManagementApi | null;
  enabled: boolean;
};

export async function reloadMemoryManagement(input: ReloadMemoryManagementInput): Promise<void> {
  if (!input.api || !input.enabled) {
    return;
  }

  const requestId = input.beginRequest();
  try {
    input.setLoaded(false);
    const page = await input.api.getMemoryManagementPage(buildMemoryManagementPageRequest(input.filters, {
      limit: input.pageLimit,
    }));
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setSnapshot(page.snapshot);
    input.setPages(normalizeMemoryManagementPages(page.pages));
    input.setFeedback("Memory 管理ビューを更新したよ。");
  } catch (error) {
    input.setFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
  } finally {
    input.setLoaded(true);
  }
}

export type LoadMoreMemoryManagementInput = MemoryManagementActionState & {
  api: HomeMemoryManagementApi | null;
  enabled: boolean;
  pages: MemoryManagementPageState;
  domain: MemoryManagementDomain;
};

export async function loadMoreMemoryManagement(input: LoadMoreMemoryManagementInput): Promise<void> {
  if (!input.api || !input.enabled || input.domain === "all") {
    return;
  }

  const cursor = getMemoryManagementCursor(input.pages, input.domain);
  if (cursor === null) {
    return;
  }

  const requestId = input.beginRequest();
  try {
    input.setLoaded(false);
    const page = await input.api.getMemoryManagementPage({
      ...buildMemoryManagementPageRequest(input.filters, {
        domain: input.domain,
        cursor,
        limit: input.pageLimit,
      }),
    });
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setSnapshot((current) => mergeMemoryManagementSnapshots(current, page.snapshot, input.domain));
    const normalizedPages = normalizeMemoryManagementPages(page.pages);
    const domain = input.domain as Exclude<MemoryManagementDomain, "all">;
    input.setPages((current) => ({
      ...current,
      [domain]: normalizedPages[domain],
    }));
    input.setFeedback("Memory 管理ビューを追加読み込みしたよ。");
  } catch (error) {
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setFeedback(error instanceof Error ? error.message : "Memory 一覧の追加読み込みに失敗したよ。");
  } finally {
    if (input.isLatestRequest(requestId)) {
      input.setLoaded(true);
    }
  }
}

export type ChangeMemoryManagementViewFiltersInput = MemoryManagementActionState & {
  api: HomeMemoryManagementApi | null;
  enabled: boolean;
  nextFilters: MemoryManagementViewFilters;
  setFilters: (filters: MemoryManagementViewFilters) => void;
};

export async function changeMemoryManagementViewFilters(input: ChangeMemoryManagementViewFiltersInput): Promise<void> {
  input.setFilters(input.nextFilters);
  if (!input.api || !input.enabled) {
    return;
  }

  const requestId = input.beginRequest();
  try {
    input.setLoaded(false);
    const page = await input.api.getMemoryManagementPage(buildMemoryManagementPageRequest(input.nextFilters, {
      limit: input.pageLimit,
    }));
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setSnapshot(page.snapshot);
    input.setPages(normalizeMemoryManagementPages(page.pages));
  } catch (error) {
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
  } finally {
    if (input.isLatestRequest(requestId)) {
      input.setLoaded(true);
    }
  }
}

type DeleteMemoryManagementItemKind = "session" | "project" | "mate_profile";

type DeleteMemoryManagementItemConfig = {
  busyPrefix: string;
  successFeedback: string;
  failureFeedback: string;
  deleteItem: (api: HomeMemoryManagementApi, itemId: string) => Promise<void>;
  removeFromSnapshot: (snapshot: MemoryManagementSnapshot, itemId: string) => MemoryManagementSnapshot;
};

const DELETE_ITEM_CONFIG: Record<DeleteMemoryManagementItemKind, DeleteMemoryManagementItemConfig> = {
  session: {
    busyPrefix: "session",
    successFeedback: "Session Memory を削除したよ。",
    failureFeedback: "Session Memory の削除に失敗したよ。",
    deleteItem: (api, itemId) => api.deleteSessionMemory(itemId),
    removeFromSnapshot: removeSessionMemoryFromSnapshot,
  },
  project: {
    busyPrefix: "project",
    successFeedback: "Project Memory を削除したよ。",
    failureFeedback: "Project Memory の削除に失敗したよ。",
    deleteItem: (api, itemId) => api.deleteProjectMemoryEntry(itemId),
    removeFromSnapshot: removeProjectMemoryEntryFromSnapshot,
  },
  mate_profile: {
    busyPrefix: "mate_profile",
    successFeedback: "Mate Profile Item を忘却したよ。",
    failureFeedback: "Mate Profile Item の忘却に失敗したよ。",
    deleteItem: (api, itemId) => api.forgetMateProfileItem(itemId),
    removeFromSnapshot: removeMateProfileItemFromSnapshot,
  },
};

export type DeleteMemoryManagementItemInput = MemoryManagementActionState & {
  api: HomeMemoryManagementApi | null;
  enabled: boolean;
  itemId: string;
  kind: DeleteMemoryManagementItemKind;
  setBusyTarget: (target: string | null) => void;
};

export async function deleteMemoryManagementItem(input: DeleteMemoryManagementItemInput): Promise<void> {
  if (!input.api || !input.enabled) {
    return;
  }

  const config = DELETE_ITEM_CONFIG[input.kind];
  try {
    input.setBusyTarget(`${config.busyPrefix}:${input.itemId}`);
    await config.deleteItem(input.api, input.itemId);
    const requestId = input.beginRequest();
    const page = await input.api.getMemoryManagementPage(buildMemoryManagementPageRequest(input.filters, {
      limit: input.pageLimit,
    }));
    if (!input.isLatestRequest(requestId)) {
      return;
    }
    input.setSnapshot(config.removeFromSnapshot(page.snapshot, input.itemId));
    input.setPages(normalizeMemoryManagementPages(page.pages));
    input.setFeedback(config.successFeedback);
  } catch (error) {
    input.setFeedback(error instanceof Error ? error.message : config.failureFeedback);
  } finally {
    input.setBusyTarget(null);
    input.setLoaded(true);
  }
}

export async function handleReloadMemoryManagement(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
}): Promise<void> {
  await reloadMemoryManagement({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.memoryManagementFilters,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
  });
}

export async function handleLoadMoreMemoryManagement(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  memoryManagementPages: MemoryManagementPageState;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  domain: MemoryManagementDomain;
}): Promise<void> {
  await loadMoreMemoryManagement({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.memoryManagementFilters,
    pages: input.memoryManagementPages,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
    domain: input.domain,
  });
}

export async function handleChangeMemoryManagementViewFilters(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  setMemoryManagementFilters: (filters: MemoryManagementViewFilters) => void;
  filters: MemoryManagementViewFilters;
}): Promise<void> {
  await changeMemoryManagementViewFilters({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.filters,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
    setFilters: input.setMemoryManagementFilters,
    nextFilters: input.filters,
  });
}

export async function handleDeleteSessionMemory(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  memoryManagementPages: MemoryManagementPageState;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  setMemoryManagementBusyTarget: (target: string | null) => void;
  sessionId: string;
}): Promise<void> {
  await deleteMemoryManagementItem({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.memoryManagementFilters,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
    setBusyTarget: input.setMemoryManagementBusyTarget,
    itemId: input.sessionId,
    kind: "session",
  });
}

export async function handleDeleteProjectMemoryEntry(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  memoryManagementPages: MemoryManagementPageState;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  setMemoryManagementBusyTarget: (target: string | null) => void;
  entryId: string;
}): Promise<void> {
  await deleteMemoryManagementItem({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.memoryManagementFilters,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
    setBusyTarget: input.setMemoryManagementBusyTarget,
    itemId: input.entryId,
    kind: "project",
  });
}

export async function handleDeleteMateProfileItem(input: {
  api: HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  memoryManagementPages: MemoryManagementPageState;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  setMemoryManagementBusyTarget: (target: string | null) => void;
  itemId: string;
}): Promise<void> {
  await deleteMemoryManagementItem({
    api: input.api,
    enabled: input.usesMemoryManagementWindow,
    filters: input.memoryManagementFilters,
    pageLimit: MEMORY_MANAGEMENT_PAGE_LIMIT,
    beginRequest: input.beginMemoryManagementRequest,
    isLatestRequest: input.isLatestMemoryManagementRequest,
    setLoaded: input.setMemoryManagementLoaded,
    setSnapshot: input.setMemoryManagementSnapshot,
    setPages: input.setMemoryManagementPages,
    setFeedback: input.setMemoryManagementFeedback,
    setBusyTarget: input.setMemoryManagementBusyTarget,
    itemId: input.itemId,
    kind: "mate_profile",
  });
}

export async function handleStartMateEmbeddingDownload(input: {
  api: Pick<WithMateWindowApi, "startMateEmbeddingDownload" | "getMateEmbeddingSettings"> | null;
  setMateEmbeddingSettings: (settings: MateEmbeddingSettings | null) => void;
  setMateEmbeddingFeedback: (feedback: string) => void;
  setMateEmbeddingBusy: (busy: boolean) => void;
}): Promise<void> {
  if (!input.api) {
    input.setMateEmbeddingFeedback("Mate Embedding API が利用できないよ。");
    return;
  }

  input.setMateEmbeddingBusy(true);
  input.setMateEmbeddingFeedback("");
  try {
    await input.api.startMateEmbeddingDownload();
    input.setMateEmbeddingSettings(await input.api.getMateEmbeddingSettings());
    input.setMateEmbeddingFeedback("モデルの準備を開始したよ。");
  } catch (error) {
    input.setMateEmbeddingFeedback(error instanceof Error ? error.message : "モデルの準備に失敗したよ。");
  } finally {
    input.setMateEmbeddingBusy(false);
  }
}
