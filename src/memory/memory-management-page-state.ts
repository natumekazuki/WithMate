import type {
  MemoryManagementDomain,
  MemoryManagementDomainPageInfo,
  MemoryManagementPageResult,
} from "./memory-management-state.js";

export type MemoryManagementPageState = {
  session: MemoryManagementDomainPageInfo;
  project: MemoryManagementDomainPageInfo;
  mate_profile: MemoryManagementDomainPageInfo;
};

const EMPTY_MEMORY_MANAGEMENT_PAGE_INFO: MemoryManagementDomainPageInfo = {
  nextCursor: null,
  hasMore: false,
  total: 0,
};

export const EMPTY_MEMORY_MANAGEMENT_PAGE_STATE: MemoryManagementPageState = {
  session: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
  project: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
  mate_profile: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
};

export function normalizeMemoryManagementPages(pages: MemoryManagementPageResult["pages"]): MemoryManagementPageState {
  return {
    ...EMPTY_MEMORY_MANAGEMENT_PAGE_STATE,
    session: pages.session,
    project: pages.project,
    mate_profile: pages.mate_profile ?? EMPTY_MEMORY_MANAGEMENT_PAGE_STATE.mate_profile,
  };
}

export function getMemoryManagementCursor(
  pages: MemoryManagementPageState,
  domain: MemoryManagementDomain,
): number | null {
  if (domain === "session") {
    return pages.session.nextCursor;
  }
  if (domain === "project") {
    return pages.project.nextCursor;
  }
  if (domain === "mate_profile") {
    return pages.mate_profile.nextCursor;
  }
  return null;
}
