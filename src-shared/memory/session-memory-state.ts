import { currentIsoTimestamp } from "../time-state.js";
import type { Session } from "../session/session-state.js";

/** セッションのバックグラウンド状態で区別する、記憶生成と独話の処理種別。 */
export type SessionBackgroundActivityKind = "memory-generation" | "monologue";

/** バックグラウンド処理が進行中か、完了・失敗・取消で終わったかを表す。 */
export type SessionBackgroundActivityStatus =
  "running" | "completed" | "failed" | "canceled";

/** セッション内のバックグラウンド処理について、表示用の概要・状態・エラーを伝える。 */
export type SessionBackgroundActivityState = {
  sessionId: string;
  kind: SessionBackgroundActivityKind;
  status: SessionBackgroundActivityStatus;
  title: string;
  summary: string;
  details?: string;
  errorMessage: string;
  updatedAt: string;
};

/** セッションに結び付く目的、判断、未解決事項、次の行動および補足を保持する版付きの記録。 */
export type SessionMemory = {
  sessionId: string;
  workspacePath: string;
  threadId: string;
  schemaVersion: 1;
  goal: string;
  decisions: string[];
  openQuestions: string[];
  nextActions: string[];
  notes: string[];
  updatedAt: string;
};

/** セッションの記録で差し替える項目。未指定は維持し、目的の null は消去を指示する。 */
export type SessionMemoryDelta = {
  goal?: string | null;
  decisions?: string[];
  openQuestions?: string[];
  nextActions?: string[];
  notes?: string[];
};

/** プロジェクトの範囲を Git リポジトリと通常のディレクトリに区別する値。 */
export type ProjectScopeType = "git" | "directory";

/** プロジェクトの記録を判断、制約、慣習、背景、保留事項に分ける分類。 */
export type ProjectMemoryCategory =
  "decision" | "constraint" | "convention" | "context" | "deferred";

/** プロジェクト記憶の所属先を識別するキーと、作業場所・Git ルートなどの情報。 */
export type ProjectScope = {
  id: string;
  projectType: ProjectScopeType;
  projectKey: string;
  workspacePath: string;
  gitRoot: string | null;
  gitRemoteUrl: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

/** プロジェクトに残す一件の記録。参照元セッション、検索語、根拠と利用日時を保持する。 */
export type ProjectMemoryEntry = {
  id: string;
  projectScopeId: string;
  sourceSessionId: string | null;
  category: ProjectMemoryCategory;
  title: string;
  detail: string;
  keywords: string[];
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

/** 管理一覧でセッションの記録と、その処理状態・作業場所などの表示情報を対応付ける項目。 */
export type ManagedSessionMemoryItem = {
  sessionId: string;
  taskTitle: string;
  character: string;
  provider: string;
  workspaceLabel: string;
  workspacePath: string;
  status: Session["status"];
  runState: Session["runState"];
  updatedAt: string;
  memory: SessionMemory;
};

/** 同一のプロジェクト範囲に属する記録を管理一覧用にまとめた単位。 */
export type ManagedProjectMemoryGroup = {
  scope: ProjectScope;
  entries: ProjectMemoryEntry[];
};

/** 一覧の取得範囲をセッション、プロジェクト、または両方から選ぶ値。 */
export type MemoryPageDomain = "all" | "session" | "project";

/** 管理一覧の取得範囲、ページ位置、検索語、並び順と領域別の絞り込みを指定する。 */
export type MemoryPageRequest = {
  domain?: MemoryPageDomain;
  cursor?: number;
  limit?: number;
  searchText?: string;
  sort?: "updated-desc" | "updated-asc";
  sessionStatus?: "all" | "running" | "idle" | "saved";
  projectCategory?: "all" | ProjectMemoryCategory;
};

/** 初期の記録をセッションと会話スレッドへ結び付け、目的の初期値を決める入力。 */
type CreateDefaultSessionMemoryInput = {
  id: string;
  workspacePath: string;
  threadId: string;
  taskTitle: string;
};

/** 文字列だけを抽出し、空白を除いて空項目と重複を取り除く。最初の出現順を保つ。 */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

/** タスク名を初期の目的とし、判断などの記録項目を空にしたセッション記録を作る。 */
export function createDefaultSessionMemory(
  input: CreateDefaultSessionMemoryInput,
): SessionMemory {
  const goal = input.taskTitle.trim();
  return {
    sessionId: input.id,
    workspacePath: input.workspacePath,
    threadId: input.threadId,
    schemaVersion: 1,
    goal,
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: currentIsoTimestamp(),
  };
}

/** セッション ID のある記録を版 1 の形式へ整える。ID がない場合は null を返す。 */
export function normalizeSessionMemory(value: unknown): SessionMemory | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<SessionMemory>;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()) {
    return null;
  }

  return {
    sessionId: candidate.sessionId.trim(),
    workspacePath:
      typeof candidate.workspacePath === "string"
        ? candidate.workspacePath
        : "",
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    schemaVersion: 1,
    goal: typeof candidate.goal === "string" ? candidate.goal.trim() : "",
    decisions: normalizeStringList(candidate.decisions),
    openQuestions: normalizeStringList(candidate.openQuestions),
    nextActions: normalizeStringList(candidate.nextActions),
    notes: normalizeStringList(candidate.notes),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
  };
}

/** 差し替えに使える項目だけを整え、明示的な空リストと未指定を区別する。 */
export function normalizeSessionMemoryDelta(
  value: unknown,
): SessionMemoryDelta {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Partial<SessionMemoryDelta>;
  return {
    goal:
      typeof candidate.goal === "string"
        ? candidate.goal.trim()
        : candidate.goal === null
          ? null
          : undefined,
    decisions: Array.isArray(candidate.decisions)
      ? normalizeStringList(candidate.decisions)
      : undefined,
    openQuestions: Array.isArray(candidate.openQuestions)
      ? normalizeStringList(candidate.openQuestions)
      : undefined,
    nextActions: Array.isArray(candidate.nextActions)
      ? normalizeStringList(candidate.nextActions)
      : undefined,
    notes: Array.isArray(candidate.notes)
      ? normalizeStringList(candidate.notes)
      : undefined,
  };
}

/** 指定された項目だけを差し替えて更新時刻を付け直す。リストは追記せず置換する。 */
export function mergeSessionMemory(
  current: SessionMemory,
  delta: SessionMemoryDelta,
): SessionMemory {
  const normalizedDelta = normalizeSessionMemoryDelta(delta);
  return {
    ...current,
    goal:
      normalizedDelta.goal === undefined
        ? current.goal
        : (normalizedDelta.goal ?? ""),
    decisions: normalizedDelta.decisions ?? current.decisions,
    openQuestions: normalizedDelta.openQuestions ?? current.openQuestions,
    nextActions: normalizedDelta.nextActions ?? current.nextActions,
    notes: normalizedDelta.notes ?? current.notes,
    updatedAt: currentIsoTimestamp(),
  };
}

/** 保存された値が受け付けるプロジェクト記録の分類かを判定し、対象外なら null を返す。 */
function normalizeProjectMemoryCategory(
  value: unknown,
): ProjectMemoryCategory | null {
  return value === "decision" ||
    value === "constraint" ||
    value === "convention" ||
    value === "context" ||
    value === "deferred"
    ? value
    : null;
}

/** ID・範囲の種別・キーを必須として保存データを整え、不足時は null を返す。 */
export function normalizeProjectScope(value: unknown): ProjectScope | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectScope>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  const projectType =
    candidate.projectType === "git" || candidate.projectType === "directory"
      ? candidate.projectType
      : null;
  if (!projectType) {
    return null;
  }

  if (
    typeof candidate.projectKey !== "string" ||
    !candidate.projectKey.trim()
  ) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    projectType,
    projectKey: candidate.projectKey.trim(),
    workspacePath:
      typeof candidate.workspacePath === "string"
        ? candidate.workspacePath.trim()
        : "",
    gitRoot:
      typeof candidate.gitRoot === "string" && candidate.gitRoot.trim()
        ? candidate.gitRoot.trim()
        : null,
    gitRemoteUrl:
      typeof candidate.gitRemoteUrl === "string" &&
      candidate.gitRemoteUrl.trim()
        ? candidate.gitRemoteUrl.trim()
        : null,
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName.trim()
        : "",
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
  };
}

/** 所属先 ID と分類を検証してプロジェクト記録を整え、未記録の利用日時は null にする。 */
export function normalizeProjectMemoryEntry(
  value: unknown,
): ProjectMemoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectMemoryEntry>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  if (
    typeof candidate.projectScopeId !== "string" ||
    !candidate.projectScopeId.trim()
  ) {
    return null;
  }

  const category = normalizeProjectMemoryCategory(candidate.category);
  if (!category) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    projectScopeId: candidate.projectScopeId.trim(),
    sourceSessionId:
      typeof candidate.sourceSessionId === "string" &&
      candidate.sourceSessionId.trim()
        ? candidate.sourceSessionId.trim()
        : null,
    category,
    title: typeof candidate.title === "string" ? candidate.title.trim() : "",
    detail: typeof candidate.detail === "string" ? candidate.detail.trim() : "",
    keywords: normalizeStringList(candidate.keywords),
    evidence: normalizeStringList(candidate.evidence),
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
    lastUsedAt:
      typeof candidate.lastUsedAt === "string" && candidate.lastUsedAt.trim()
        ? candidate.lastUsedAt
        : null,
  };
}

/** プロジェクト範囲の配列を元のオブジェクトと参照を共有しない JSON 互換のコピーにする。 */
export function cloneProjectScopes(scopes: ProjectScope[]): ProjectScope[] {
  return JSON.parse(JSON.stringify(scopes)) as ProjectScope[];
}

/** プロジェクト記録の配列を、キーワードや根拠の配列も含めて複製する。 */
export function cloneProjectMemoryEntries(
  entries: ProjectMemoryEntry[],
): ProjectMemoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as ProjectMemoryEntry[];
}
