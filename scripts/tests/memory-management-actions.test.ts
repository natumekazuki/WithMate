import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WithMateWindowApi } from "../../src/withmate-window-api.js";
import {
  type MemoryManagementSnapshot,
  type MemoryManagementPageRequest,
} from "../../src/memory/memory-management-state.js";
import { normalizeMemoryManagementPages } from "../../src/memory/memory-management-page-state.js";
import { type MemoryManagementViewFilters } from "../../src/memory/memory-management-view.js";
import type { MateEmbeddingSettings } from "../../src/mate/mate-embedding-settings.js";
import {
  handleChangeMemoryManagementViewFilters,
  handleDeleteCharacterMemoryEntry,
  handleDeleteMateProfileItem,
  handleDeleteProjectMemoryEntry,
  handleDeleteSessionMemory,
  handleLoadMoreMemoryManagement,
  handleReloadMemoryManagement,
  handleStartMateEmbeddingDownload,
  MEMORY_MANAGEMENT_PAGE_LIMIT,
} from "../../src/memory/memory-management-actions.js";
import { DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS } from "../../src/memory/memory-management-view.js";

type MemoryManagementRequestApi = Pick<WithMateWindowApi, "getMemoryManagementPage"> & Partial<
  Pick<
    WithMateWindowApi,
    | "deleteSessionMemory"
    | "deleteProjectMemoryEntry"
    | "deleteCharacterMemoryEntry"
    | "forgetMateProfileItem"
    | "startMateEmbeddingDownload"
    | "getMateEmbeddingSettings"
  >
>;

type FeedbackCapture = string[];
type MemoryManagementRequestIdState = {
  current: number;
};

function createRequestTracker() {
  const state: MemoryManagementRequestIdState = { current: 0 };
  return {
    begin: () => {
      state.current += 1;
      return state.current;
    },
    isLatest: (requestId: number) => requestId === state.current,
  };
}

function createSetState<T>(initial: T): {
  get: () => T;
  set: (value: T | ((current: T) => T)) => void;
} {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === "function" ? (next as (current: T) => T)(value) : next;
    },
  };
}

function createSnapshot(): MemoryManagementSnapshot {
  return {
    sessionMemories: [
      {
        sessionId: "session-1",
        taskTitle: "Task 1",
        character: "char-a",
        provider: "codex",
        workspaceLabel: "repo",
        workspacePath: "/repo",
        status: "running",
        runState: "running",
        updatedAt: "2026-04-01T10:00:00.000Z",
        memory: {
          sessionId: "session-1",
          workspacePath: "/repo",
          threadId: "thread-1",
          schemaVersion: 1,
          goal: "goal",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
      },
      {
        sessionId: "session-2",
        taskTitle: "Task 2",
        character: "char-b",
        provider: "codex",
        workspaceLabel: "repo",
        workspacePath: "/repo",
        status: "saved",
        runState: "idle",
        updatedAt: "2026-04-01T09:00:00.000Z",
        memory: {
          sessionId: "session-2",
          workspacePath: "/repo",
          threadId: "thread-2",
          schemaVersion: 1,
          goal: "goal",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
      },
    ],
    projectMemories: [
      {
        scope: {
          id: "project-scope-1",
          projectType: "directory",
          projectKey: "directory:/repo",
          workspacePath: "/repo",
          gitRoot: null,
          gitRemoteUrl: null,
          displayName: "repo",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        entries: [
          {
            id: "project-entry-1",
            projectScopeId: "project-scope-1",
            sourceSessionId: "session-1",
            category: "decision",
            title: "project-entry-1",
            detail: "detail",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    ],
    characterMemories: [
      {
        scope: {
          id: "character-scope-1",
          characterId: "char-a",
          displayName: "char-a",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        entries: [
          {
            id: "character-entry-1",
            characterScopeId: "character-scope-1",
            sourceSessionId: "session-1",
            category: "tone",
            title: "tone",
            detail: "detail",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    ],
    mateProfileItems: [
      {
        id: "mate-profile-item-1",
        sectionKey: "core",
        projectDigestId: null,
        category: "persona",
        claimKey: "name",
        claimValue: "Alice",
        renderedText: "Alice",
        normalizedClaim: "alice",
        confidence: 100,
        salienceScore: 100,
        state: "active",
        tags: ["tag"],
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ],
  };
}

function createPages() {
  return normalizeMemoryManagementPages({
    session: { nextCursor: 0, hasMore: false, total: 0 },
    project: { nextCursor: 0, hasMore: false, total: 0 },
    character: { nextCursor: 0, hasMore: false, total: 0 },
    mate_profile: { nextCursor: null, hasMore: false, total: 1 },
  });
}

function createApi(overrides: Partial<MemoryManagementRequestApi> = {}): MemoryManagementRequestApi {
  return {
    getMemoryManagementPage: async () => ({
      snapshot: createSnapshot(),
      pages: {
        session: { nextCursor: 0, hasMore: false, total: 0 },
        project: { nextCursor: 0, hasMore: false, total: 0 },
        character: { nextCursor: 0, hasMore: false, total: 0 },
        mate_profile: { nextCursor: null, hasMore: false, total: 0 },
      },
    }),
    ...overrides,
  };
}

const defaultFilters: MemoryManagementViewFilters = DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS;

describe("memory-management-actions", () => {
  it("reload は snapshot/pages を更新して feedback を返す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const snapshot = createSetState<MemoryManagementSnapshot | null>(null);
    const pages = createSetState(createPages());
    const loaded: boolean[] = [];
    const requestFilter = {
      ...defaultFilters,
      domain: "all" as const,
    };

    const requests: MemoryManagementPageRequest[] = [];
    const api = createApi({
      getMemoryManagementPage: async (input) => {
        requests.push(input);
        return {
          snapshot: createSnapshot(),
          pages: {
            session: { nextCursor: 20, hasMore: true, total: 20 },
            project: { nextCursor: 0, hasMore: false, total: 1 },
            character: { nextCursor: 0, hasMore: false, total: 1 },
            mate_profile: { nextCursor: null, hasMore: false, total: 1 },
          },
        };
      },
    });

    await handleReloadMemoryManagement({
      api: api as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: requestFilter,
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
    });

    assert.equal(requests[0]?.limit, MEMORY_MANAGEMENT_PAGE_LIMIT);
    assert.equal(requests[0]?.domain, "all");
    assert.equal(requests[0]?.cursor, 0);
    assert.deepEqual(snapshot.get()?.sessionMemories[0]?.sessionId, "session-1");
    assert.equal(pages.get().session.nextCursor, 20);
    assert.deepEqual(loaded, [false, true]);
    assert.deepEqual(feedback, ["Memory 管理ビューを更新したよ。"]);
  });

  it("reload 失敗時はエラーメッセージを返す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const snapshot = createSetState<MemoryManagementSnapshot | null>(createSnapshot());
    const pages = createSetState(createPages());
    const loaded: boolean[] = [];

    await handleReloadMemoryManagement({
      api: createApi({
        getMemoryManagementPage: async () => {
          throw new Error("load failed");
        },
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
    });

    assert.equal(feedback.at(-1), "load failed");
    assert.deepEqual(loaded, [false, true]);
    assert.equal(snapshot.get()?.sessionMemories.length, 2);
  });

  it("loadMore は cursor がある時だけ追加読み込みして merge する", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const initialPages = createPages();
    initialPages.session.nextCursor = 10;
    const snapshot = createSetState<MemoryManagementSnapshot | null>(createSnapshot());
    const pages = createSetState(initialPages);
    const loaded: boolean[] = [];

    await handleLoadMoreMemoryManagement({
      api: createApi({
        getMemoryManagementPage: async () => ({
          snapshot: {
            ...createSnapshot(),
            sessionMemories: [{
              ...createSnapshot().sessionMemories[0]!,
              sessionId: "session-3",
            }],
            projectMemories: [],
            characterMemories: [],
            mateProfileItems: [],
          },
          pages: {
            session: { nextCursor: null, hasMore: false, total: 1 },
            project: { nextCursor: 0, hasMore: false, total: 0 },
            character: { nextCursor: 0, hasMore: false, total: 0 },
            mate_profile: { nextCursor: null, hasMore: false, total: 0 },
          },
        }),
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: initialPages,
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
      domain: "session",
    });

    assert.equal(pages.get().session.nextCursor, null);
    assert.equal(snapshot.get()?.sessionMemories.at(-1)?.sessionId, "session-3");
    assert.deepEqual(feedback, ["Memory 管理ビューを追加読み込みしたよ。"]);
    assert.deepEqual(loaded, [false, true]);
  });

  it("loadMore は domain all では呼ばれない", async () => {
    const tracker = createRequestTracker();
    const snapshot = createSetState<MemoryManagementSnapshot | null>(createSnapshot());
    const pages = createSetState(createPages());
    const loaded: boolean[] = [];
    let requested = false;

    await handleLoadMoreMemoryManagement({
      api: {
        getMemoryManagementPage: () => {
          requested = true;
          throw new Error("should not be called");
        },
      } as unknown as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: createPages(),
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
      setMemoryManagementFeedback: () => assert.fail("feedback should not be set"),
      domain: "all",
    });

    assert.equal(requested, false);
  });

  it("filters 変更はフィルタを更新してページを再取得する", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const filters = { ...defaultFilters, sort: "updated-asc" as const };
    const snapshot = createSetState<MemoryManagementSnapshot | null>(createSnapshot());
    const pages = createSetState(createPages());
    const loaded: boolean[] = [];
    const requests: MemoryManagementPageRequest[] = [];

    await handleChangeMemoryManagementViewFilters({
      api: createApi({
        getMemoryManagementPage: async (input) => {
          requests.push(input);
          return {
            snapshot: createSnapshot(),
            pages: {
              session: { nextCursor: 5, hasMore: false, total: 0 },
              project: { nextCursor: 0, hasMore: false, total: 0 },
              character: { nextCursor: 0, hasMore: false, total: 0 },
              mate_profile: { nextCursor: null, hasMore: false, total: 0 },
            },
          };
        },
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      filters,
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
      setMemoryManagementFilters: (nextFilters) => {
        assert.deepEqual(nextFilters, filters);
      },
    });

    assert.equal(requests[0]?.sort, "updated-asc");
    assert.equal(requests[0]?.domain, "all");
    assert.deepEqual(loaded, [false, true]);
    assert.deepEqual(feedback, []);
  });

  it("deleteSessionMemory は API 呼び出し後に item を snapshot から消す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const busy: Array<string | null> = [];
    const snapshot = createSetState<MemoryManagementSnapshot | null>(createSnapshot());
    const pages = createSetState(createPages());
    const loaded: boolean[] = [];
    let deleted = "";

    await handleDeleteSessionMemory({
      api: createApi({
        deleteSessionMemory: async (sessionId) => {
          deleted = sessionId;
        },
        getMemoryManagementPage: async () => ({
          snapshot: {
            ...createSnapshot(),
            sessionMemories: createSnapshot().sessionMemories.slice(1),
            projectMemories: [],
            characterMemories: [],
            mateProfileItems: [],
          },
          pages: {
            session: { nextCursor: 0, hasMore: false, total: 1 },
            project: { nextCursor: 0, hasMore: false, total: 0 },
            character: { nextCursor: 0, hasMore: false, total: 0 },
            mate_profile: { nextCursor: null, hasMore: false, total: 0 },
          },
        }),
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: createPages(),
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: (value) => loaded.push(value),
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: snapshot.set,
      setMemoryManagementPages: pages.set,
      setMemoryManagementBusyTarget: (target) => busy.push(target),
      sessionId: "session-1",
    });

    assert.equal(deleted, "session-1");
    assert.deepEqual(busy, ["session:session-1", null]);
    assert.equal(snapshot.get()?.sessionMemories.length, 1);
    assert.equal(pages.get().session.total, 1);
    assert.deepEqual(feedback, ["Session Memory を削除したよ。"]);
    assert.deepEqual(loaded, [true]);
  });

  it("deleteProjectMemoryEntry は project entry を削除して feedback を返す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const busy: Array<string | null> = [];

    await handleDeleteProjectMemoryEntry({
      api: createApi({
        deleteProjectMemoryEntry: async (entryId) => {
          assert.equal(entryId, "project-entry-1");
        },
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: createPages(),
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: () => {},
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: createSetState<MemoryManagementSnapshot | null>(createSnapshot()).set,
      setMemoryManagementPages: createSetState(createPages()).set,
      setMemoryManagementBusyTarget: (target) => busy.push(target),
      entryId: "project-entry-1",
    });

    assert.deepEqual(busy, ["project:project-entry-1", null]);
    assert.deepEqual(feedback, ["Project Memory を削除したよ。"]);
  });

  it("deleteCharacterMemoryEntry は character entry を削除して feedback を返す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const busy: Array<string | null> = [];

    await handleDeleteCharacterMemoryEntry({
      api: createApi({
        deleteCharacterMemoryEntry: async (entryId) => {
          assert.equal(entryId, "character-entry-1");
        },
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: createPages(),
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: () => {},
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: createSetState<MemoryManagementSnapshot | null>(createSnapshot()).set,
      setMemoryManagementPages: createSetState(createPages()).set,
      setMemoryManagementBusyTarget: (target) => busy.push(target),
      entryId: "character-entry-1",
    });

    assert.deepEqual(busy, ["character:character-entry-1", null]);
    assert.deepEqual(feedback, ["Character Memory を削除したよ。"]);
  });

  it("deleteMateProfileItem は item を snapshot から削除して feedback を返す", async () => {
    const tracker = createRequestTracker();
    const feedback: FeedbackCapture = [];
    const busy: Array<string | null> = [];

    await handleDeleteMateProfileItem({
      api: createApi({
        forgetMateProfileItem: async (itemId) => {
          assert.equal(itemId, "mate-profile-item-1");
        },
      }) as WithMateWindowApi,
      usesMemoryManagementWindow: true,
      memoryManagementFilters: defaultFilters,
      memoryManagementPages: createPages(),
      beginMemoryManagementRequest: tracker.begin,
      isLatestMemoryManagementRequest: tracker.isLatest,
      setMemoryManagementLoaded: () => {},
      setMemoryManagementFeedback: (value) => feedback.push(value),
      setMemoryManagementSnapshot: createSetState<MemoryManagementSnapshot | null>(createSnapshot()).set,
      setMemoryManagementPages: createSetState(createPages()).set,
      setMemoryManagementBusyTarget: (target) => busy.push(target),
      itemId: "mate-profile-item-1",
    });

    assert.deepEqual(busy, ["mate_profile:mate-profile-item-1", null]);
    assert.deepEqual(feedback, ["Mate Profile Item を忘却したよ。"]);
  });

  it("startMateEmbeddingDownload は settings を更新して feedback を返す", async () => {
    const feedback: FeedbackCapture = [];
    const busy: boolean[] = [];
    const settings: MateEmbeddingSettings = {
      mateId: "current",
      enabled: false,
      backendType: "local_transformers_js",
      modelId: "model",
      sourceModelId: "source-model",
      dimension: 384,
      cachePolicy: "download_once_local_cache",
      cacheState: "ready",
      cacheDirPath: "/cache",
      cacheManifestSha256: "",
      modelRevision: "main",
      cacheSizeBytes: 0,
      cacheUpdatedAt: null,
      lastVerifiedAt: null,
      lastStatus: "available",
      lastErrorPreview: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await handleStartMateEmbeddingDownload({
      api: {
        startMateEmbeddingDownload: async () => {},
        getMateEmbeddingSettings: async () => settings,
      } as unknown as WithMateWindowApi,
      setMateEmbeddingBusy: (value) => busy.push(value),
      setMateEmbeddingFeedback: (value) => feedback.push(value),
      setMateEmbeddingSettings: (nextSettings) => {
        assert.equal(nextSettings, settings);
      },
    });

    assert.deepEqual(feedback, ["", "モデルの準備を開始したよ。"]);
    assert.deepEqual(busy, [true, false]);
  });

  it("startMateEmbeddingDownload は API 欠落時に feedback を返す", async () => {
    const feedback: FeedbackCapture = [];
    const busy: boolean[] = [];

    await handleStartMateEmbeddingDownload({
      api: null,
      setMateEmbeddingBusy: (value) => busy.push(value),
      setMateEmbeddingFeedback: (value) => feedback.push(value),
      setMateEmbeddingSettings: () => assert.fail("settings should not be set"),
    });

    assert.deepEqual(feedback, ["Mate Embedding API が利用できないよ。"]);
    assert.deepEqual(busy, []);
  });
});
