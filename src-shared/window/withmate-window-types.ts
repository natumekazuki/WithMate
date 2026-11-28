import type { AppSettings } from "../settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../settings/model-catalog.js";
import type { HomeSessionSummary, Session } from "../session/session-state.js";
import type { AuxiliarySessionSummary } from "../auxiliary/auxiliary-session-state.js";

/** 開いている Window の変更通知に個別のセッション ID を含める件数上限。 */
export const OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX = 100;
/** 開いている Window のセッション ID を一度の照会で取得できる件数上限。 */
export const OPEN_SESSION_WINDOW_IDS_PAGE_MAX = 100;

/** 開いている Window の一覧を、直前のページの末尾 ID より後から取得する指定。 */
export type OpenSessionWindowIdsPageRequest = {
  cursor?: string | null;
  limit?: number | null;
};

/** 開いている Window のセッション ID と、続きを取得するためのページ情報。 */
export type OpenSessionWindowIdsPageResult = {
  sessionIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** セッションモニターの一覧を、Window ID 一覧と同じカーソル・件数の形式で要求する。 */
export type SessionMonitorPageRequest = OpenSessionWindowIdsPageRequest;

/** モニターに表示するセッション概要と補助セッションの概要、次ページの取得情報。 */
export type SessionMonitorPageResult = {
  entries: HomeSessionSummary[];
  auxiliarySessions: AuxiliarySessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** セッションモニターの操作対象として IPC で受け付けるエントリー種別。 */
export type SessionMonitorEntryKind = "agent";

/** 選択された補助セッションを、その親セッションと組にして通知する。 */
export type AuxiliarySessionSelectionPayload = {
  parentSessionId: string;
  auxiliarySessionId: string;
};

/** 選択通知の両 ID をトリムし、どちらかを取得できない場合は null を返す。 */
export function normalizeAuxiliarySessionSelectionPayload(
  value: unknown,
): AuxiliarySessionSelectionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.parentSessionId !== "string" ||
    typeof candidate.auxiliarySessionId !== "string" ||
    !candidate.parentSessionId.trim() ||
    !candidate.auxiliarySessionId.trim()
  ) {
    return null;
  }
  return {
    parentSessionId: candidate.parentSessionId.trim(),
    auxiliarySessionId: candidate.auxiliarySessionId.trim(),
  };
}

/** セッションモニターのネイティブメニューを開く Window 内の座標。 */
export type SessionMonitorContextMenuPoint = {
  x: number;
  y: number;
};

/** ネイティブメニューを要求する行の種別とセッション ID、および表示位置。 */
export type SessionMonitorContextMenuRequest = {
  kind: SessionMonitorEntryKind;
  sessionId: string;
  point: SessionMonitorContextMenuPoint;
};

/** セッション Window の終了、クリップボードへのコピー、選択なし、または失敗の結果。 */
export type SessionMonitorContextMenuResult =
  | { status: "closed" | "copied" | "dismissed" }
  | { status: "failed"; message: string };

/** 対象種別、空でない ID、非負の安全な整数座標を検証し、未知のキーも TypeError で拒否する。 */
export function parseSessionMonitorContextMenuRequest(
  value: unknown,
): SessionMonitorContextMenuRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Session Monitor context menu request is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Object.keys(candidate).every((key) =>
      ["kind", "sessionId", "point"].includes(key),
    )
  ) {
    throw new TypeError("Session Monitor context menu request is invalid.");
  }
  const point = candidate.point;
  if (
    candidate.kind !== "agent" ||
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    !point ||
    typeof point !== "object" ||
    Array.isArray(point)
  ) {
    throw new TypeError("Session Monitor context menu request is invalid.");
  }
  const pointCandidate = point as Record<string, unknown>;
  if (
    !Object.keys(pointCandidate).every((key) => ["x", "y"].includes(key)) ||
    !Number.isSafeInteger(pointCandidate.x) ||
    (pointCandidate.x as number) < 0 ||
    !Number.isSafeInteger(pointCandidate.y) ||
    (pointCandidate.y as number) < 0
  ) {
    throw new TypeError("Session Monitor context menu request is invalid.");
  }
  return {
    kind: candidate.kind as SessionMonitorEntryKind,
    sessionId: candidate.sessionId as string,
    point: {
      x: pointCandidate.x as number,
      y: pointCandidate.y as number,
    },
  };
}

/** カーソル未指定を先頭ページ、件数未指定を上限件数とし、不正な型や範囲を例外で拒否する。 */
export function parseOpenSessionWindowIdsPageRequest(value: unknown): {
  cursor: string | null;
  limit: number;
} {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "object" || Array.isArray(value))
  ) {
    throw new TypeError("Invalid open Session Window ID page request.");
  }
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { cursor?: unknown; limit?: unknown })
      : {};
  const rawCursor =
    candidate.cursor === undefined ||
    candidate.cursor === null ||
    candidate.cursor === ""
      ? null
      : candidate.cursor;
  const cursor = typeof rawCursor === "string" ? rawCursor.trim() : rawCursor;
  const limit =
    candidate.limit === undefined || candidate.limit === null
      ? OPEN_SESSION_WINDOW_IDS_PAGE_MAX
      : candidate.limit;
  if (
    (cursor !== null &&
      (typeof cursor !== "string" || !cursor || cursor.length > 256)) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > OPEN_SESSION_WINDOW_IDS_PAGE_MAX
  ) {
    throw new RangeError("Invalid open Session Window ID page request.");
  }
  return { cursor: typeof cursor === "string" ? cursor : null, limit };
}

/** 空白と重複を除いて ID を整列し、カーソルより後のページと、続きがあれば末尾 ID を返す。 */
export function buildOpenSessionWindowIdsPage(
  sessionIds: readonly string[],
  request?: OpenSessionWindowIdsPageRequest | null,
): OpenSessionWindowIdsPageResult {
  const { cursor, limit } = parseOpenSessionWindowIdsPageRequest(request);
  const uniqueSessionIds = Array.from(
    new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
  ).sort();
  const candidates =
    cursor === null
      ? uniqueSessionIds
      : uniqueSessionIds.filter((sessionId) => sessionId > cursor);
  const entries = candidates.slice(0, limit);
  const hasMore = entries.length < candidates.length;
  return {
    sessionIds: entries,
    nextCursor: hasMore ? (entries.at(-1) ?? null) : null,
    hasMore,
  };
}

/** IPC の一覧応答を検証して ID の空白と重複を除く。最終ページのカーソルは null にする。 */
export function normalizeOpenSessionWindowIdsPageResult(
  value: unknown,
): OpenSessionWindowIdsPageResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    sessionIds?: unknown;
    nextCursor?: unknown;
    hasMore?: unknown;
  };
  if (
    !Array.isArray(candidate.sessionIds) ||
    candidate.sessionIds.length > OPEN_SESSION_WINDOW_IDS_PAGE_MAX
  ) {
    return null;
  }
  const sessionIds = candidate.sessionIds.filter(
    (sessionId): sessionId is string =>
      typeof sessionId === "string" && sessionId.trim().length > 0,
  );
  if (
    sessionIds.length !== candidate.sessionIds.length ||
    typeof candidate.hasMore !== "boolean"
  ) {
    return null;
  }
  if (
    candidate.nextCursor !== null &&
    (typeof candidate.nextCursor !== "string" ||
      !candidate.nextCursor ||
      candidate.nextCursor.length > 256)
  ) {
    return null;
  }
  return {
    sessionIds: Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim())),
    ),
    nextCursor: candidate.hasMore
      ? (candidate.nextCursor as string | null)
      : null,
    hasMore: candidate.hasMore,
  };
}

/** 開閉状態を再照会する範囲を、変更された ID の集合または全件で通知する。 */
export type OpenSessionWindowIdsChangedPayload =
  { scope: "ids"; sessionIds: string[] } | { scope: "all" };

/** 補助セッションへ移動するときに指定する親セッションと移動先の ID。 */
export type AuxiliarySessionNavigationPayload = {
  parentSessionId: string;
  auxiliarySessionId: string;
};

/** 移動要求に両 ID だけがあることを確認し、空白を除いて返す。不正なら null。 */
export function normalizeAuxiliarySessionNavigationPayload(
  value: unknown,
): AuxiliarySessionNavigationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Object.keys(candidate).every((key) =>
      ["parentSessionId", "auxiliarySessionId"].includes(key),
    )
  ) {
    return null;
  }
  if (
    typeof candidate.parentSessionId !== "string" ||
    !candidate.parentSessionId.trim() ||
    typeof candidate.auxiliarySessionId !== "string" ||
    !candidate.auxiliarySessionId.trim()
  ) {
    return null;
  }
  return {
    parentSessionId: candidate.parentSessionId.trim(),
    auxiliarySessionId: candidate.auxiliarySessionId.trim(),
  };
}

/** ID 配列と範囲指定形式の通知を受け付け、ID が不正または上限超過なら全件の再照会に切り替える。 */
export function normalizeOpenSessionWindowIdsChangedPayload(
  value: unknown,
): OpenSessionWindowIdsChangedPayload | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX) {
      return { scope: "all" };
    }
    const sessionIds = value.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
    return sessionIds.length === value.length
      ? {
          scope: "ids",
          sessionIds: Array.from(new Set(sessionIds.map((id) => id.trim()))),
        }
      : { scope: "all" };
  }
  if (typeof value !== "object") {
    return null;
  }
  const payload = value as { scope?: unknown; sessionIds?: unknown };
  if (payload.scope === "all") {
    return { scope: "all" };
  }
  if (payload.scope !== "ids" || !Array.isArray(payload.sessionIds)) {
    return null;
  }
  if (payload.sessionIds.length > OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX) {
    return { scope: "all" };
  }
  const sessionIds = payload.sessionIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  return sessionIds.length === payload.sessionIds.length
    ? {
        scope: "ids",
        sessionIds: Array.from(new Set(sessionIds.map((id) => id.trim()))),
      }
    : { scope: "all" };
}

/** 貼り付けたバイト列をセッションへ保存し、衝突時は置換確認に使ったハッシュまたは別名保存を指定する。 */
export type SavePastedSessionFileRequest = {
  sessionId: string;
  fileName: string;
  data: ArrayBuffer;
  replaceExistingHash?: string;
  saveAsCopy?: boolean;
};

/** 異なる内容の同名ファイルがあるときに、確認表示と置換要求に使う名前・既存ハッシュ。 */
export type PastedSessionFileConflict = {
  status: "conflict";
  fileName: string;
  existingHash: string;
};

/** 新規または更新後の保存パス、同名衝突、同じ内容の既存ファイルの再利用を区別する。 */
export type SavePastedSessionFileResult =
  string | PastedSessionFileConflict | { status: "reused"; path: string };

/** ローカル相対パスの解決基準と、直接開く代わりにファイルの所在を表示する指定。 */
export type OpenPathOptions = {
  baseDirectory?: string | null;
  reveal?: boolean;
};

/** ローカルパスや外部 URL の起動結果。所在の表示、対象なし、操作失敗も区別する。 */
export type OpenPathResult =
  | {
      status: "opened";
      targetType: "external-url" | "local-path";
      target: string;
    }
  | {
      status: "revealed";
      targetType: "local-path";
      target: string;
      message: string;
    }
  | {
      status: "not-found" | "failed";
      targetType: "external-url" | "local-path" | "unknown";
      target: string;
      message: string;
    };

/** 画像選択ダイアログの用途として renderer と Main で共有する許容値。 */
export const IMAGE_FILE_PICKER_PURPOSES = [
  "general",
  "character-icon",
] as const;

/** 画像選択の一般用途とキャラクターアイコン用途を区別する指定。 */
export type ImageFilePickerPurpose =
  (typeof IMAGE_FILE_PICKER_PURPOSES)[number];

/** 用途の省略時は一般用途を使い、定義されていない用途は例外で拒否する。 */
export function parseImageFilePickerPurpose(
  value: unknown,
): ImageFilePickerPurpose {
  if (value === undefined || value === null) {
    return "general";
  }
  if (value === "general" || value === "character-icon") {
    return value;
  }
  throw new Error("Invalid image picker purpose.");
}

/** アプリデータベースのリセットで選択できる対象を、正規化後の順序で列挙する。 */
export const ALL_RESET_APP_DATABASE_TARGETS = [
  "sessions",
  "appSettings",
] as const;

/** データベースのリセットで個別に選べる、セッションまたはアプリ設定の区分。 */
export type ResetAppDatabaseTarget =
  (typeof ALL_RESET_APP_DATABASE_TARGETS)[number];

/** データベースのリセットを実行する対象の集合を指定する。 */
export type ResetAppDatabaseRequest = {
  targets: ResetAppDatabaseTarget[];
};

/** 対象の省略時は全区分とし、明示リストは重複を除き定義順に並べる。空リストは維持する。 */
export function normalizeResetAppDatabaseTargets(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): ResetAppDatabaseTarget[] {
  const selected = new Set<ResetAppDatabaseTarget>(
    targets ?? ALL_RESET_APP_DATABASE_TARGETS,
  );
  return ALL_RESET_APP_DATABASE_TARGETS.filter((target) =>
    selected.has(target),
  );
}

/** 重複や列挙順に関係なく、リセット対象に全区分が含まれるかを判定する。 */
export function areAllResetAppDatabaseTargetsSelected(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): boolean {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  return normalized.length === ALL_RESET_APP_DATABASE_TARGETS.length;
}

/** リセットされた区分と、画面を同期し直すための処理後のセッション・設定・モデル一覧。 */
export type ResetAppDatabaseResult = {
  resetTargets: ResetAppDatabaseTarget[];
  sessions: Session[];
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot;
};

/** 最終活動時刻でセッションを削除する際の、ローカル暦での基準日。 */
export type DeleteSessionsLastActiveBeforeRequest = {
  cutoffDate: string;
};

/** 削除基準日の現地時刻での開始を、比較用のミリ秒と伝達用の ISO 形式で保持する。 */
export type DeleteSessionsLastActiveBeforeCutoff = {
  cutoffDate: string;
  cutoffTimestampMs: number;
  cutoffIso: string;
};

/** 削除したセッションと補助セッション、実行中のため削除を見送ったセッションを区別する。 */
export type DeleteSessionsResult = {
  cutoffDate?: string;
  cutoffTimestampMs?: number;
  deletedSessionIds: string[];
  deletedAuxiliarySessionIds?: string[];
  skippedRunningSessionIds: string[];
};

/** YYYY-MM-DD で実在する日付だけを受け付け、現地時刻でその日が始まる時刻を返す。 */
export function resolveDeleteSessionsLastActiveBeforeCutoff(
  request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
): DeleteSessionsLastActiveBeforeCutoff {
  const cutoffDate =
    typeof request?.cutoffDate === "string" ? request.cutoffDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
    throw new Error("The deletion cutoff date must use YYYY-MM-DD format.");
  }

  const [yearText, monthText, dayText] = cutoffDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const cutoff = new Date(year, month - 1, day);
  if (
    Number.isNaN(cutoff.getTime()) ||
    cutoff.getFullYear() !== year ||
    cutoff.getMonth() !== month - 1 ||
    cutoff.getDate() !== day
  ) {
    throw new Error("The deletion cutoff date could not be parsed.");
  }

  return {
    cutoffDate,
    cutoffTimestampMs: cutoff.getTime(),
    cutoffIso: cutoff.toISOString(),
  };
}
