/** リポジトリに保存する用語集YAMLの形式の版。 */
export const GLOSSARY_SCHEMA_VERSION = 1 as const;
/** 用語集ランタイムの通信に含める版。YAML自体の版とは別に扱う。 */
export const GLOSSARY_RUNTIME_SCHEMA_VERSION = "withmate-glossary-v1" as const;
/** チェックアウトのルートを基準とする用語集ファイルの固定位置。 */
export const GLOSSARY_RELATIVE_PATH = ".withmate/glossary.yaml";

/** ファイル・登録件数・入力フィールド・一覧ページの処理上限。 */
export const GLOSSARY_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxEntries: 2_000,
  maxBatchEntries: 100,
  maxTermCodePoints: 200,
  maxAliasesPerEntry: 20,
  maxDefinitionCodePoints: 50_000,
  maxQueryCodePoints: 500,
  maxPageSize: 200,
} as const;

const GLOSSARY_LOOKUP_WHITESPACE_PATTERN = /\s+/gu;

/** 表示文字列は変えず、照合用にNFKC・小文字化と空白の圧縮を適用する。 */
export function normalizeGlossaryLookup(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(GLOSSARY_LOOKUP_WHITESPACE_PATTERN, " ")
    .trim();
}

/** 登録時に渡す代表語と定義。別名を使わない場合は指定を省略できる。 */
export type GlossaryEntryInput = {
  term: string;
  aliases?: readonly string[];
  definition: string;
};

/** 検証済みの用語データ。別名がなければ空の配列を持つ。 */
export type GlossaryEntry = {
  term: string;
  aliases: string[];
  definition: string;
};

/** YAML内の診断位置と、呼び出し側で分類・表示するコードと理由。 */
export type GlossaryValidationIssue = {
  path: string;
  code: string;
  message: string;
};

/** ファイルの不在、読み取った版の有効・無効、対応外スキーマを区別する検証結果。 */
export type GlossarySnapshot =
  | {
      status: "missing";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: null;
    }
  | {
      status: "valid";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      entries: GlossaryEntry[];
    }
  | {
      status: "invalid";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      issues: GlossaryValidationIssue[];
    }
  | {
      status: "unsupported";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      schemaVersion: number | string | null;
      issues: GlossaryValidationIssue[];
    };

/** 用語集の監視を継続できず、現行ファイルの版を提示できない表示状態。 */
export type GlossaryWatchErrorState = {
  status: "watch-error";
  relativePath: typeof GLOSSARY_RELATIVE_PATH;
  revision: null;
  message: string;
};

/** Gitのチェックアウトではないため用語集が適用されない状態。 */
export type GlossaryNotApplicableState = {
  status: "not-applicable";
  relativePath: typeof GLOSSARY_RELATIVE_PATH;
  revision: null;
  reason: "not-git";
};

/** ファイルの検証結果と、監視失敗やチェックアウト対象外を含む画面用状態。 */
export type GlossaryProjectionState =
  GlossarySnapshot | GlossaryWatchErrorState | GlossaryNotApplicableState;

/** どの用語集を表示中か見分けるためのリポジトリ名、ブランチ、パスラベル。 */
export type GlossaryCheckoutSummary = {
  repositoryName: string;
  branch: string;
  pathLabel: string;
};

/** Sessionの参照範囲と通知順に紐付けた、チェックアウトの用語集状態。 */
export type SessionGlossaryProjection = {
  sessionId: string;
  scopeRevision: string;
  sequence: number;
  checkout: GlossaryCheckoutSummary;
  state: GlossaryProjectionState;
};

/** 操作による変更を確認できたか、変更なしと確認できたか、結果不明かを表す。 */
export type GlossaryEffect = "applied" | "none" | "unknown";
/** 書き込んだ成功と、同等の状態に既に達していた成功を区別する。 */
export type GlossaryMutationOutcome = "applied" | "converged";

/** 入力・ファイル・対象の変化、実行権限、接続などの失敗を分類する公開コード。 */
export type GlossaryOperationErrorCode =
  | "GLOSSARY_INVALID_REQUEST"
  | "GLOSSARY_LIMIT_EXCEEDED"
  | "GLOSSARY_NOT_FOUND"
  | "GLOSSARY_CONFLICT"
  | "GLOSSARY_INVALID_FILE"
  | "GLOSSARY_UNSUPPORTED_SCHEMA"
  | "GLOSSARY_TARGET_INVALID"
  | "GLOSSARY_TARGET_CHANGED"
  | "GLOSSARY_EFFECT_UNKNOWN"
  | "GLOSSARY_IO_ERROR"
  | "GLOSSARY_SESSION_BINDING_REQUIRED"
  | "GLOSSARY_SESSION_BINDING_INVALID"
  | "GLOSSARY_SESSION_BINDING_FORBIDDEN"
  | "GLOSSARY_CHECKOUT_NOT_FOUND"
  | "GLOSSARY_RUNTIME_UNAVAILABLE"
  | "GLOSSARY_RUNTIME_INSTANCE_MISMATCH"
  | "GLOSSARY_RUNTIME_GENERATION_CHANGED"
  | "GLOSSARY_RUNTIME_AMBIGUOUS"
  | "GLOSSARY_RUNTIME_STALE"
  | "GLOSSARY_RUNTIME_REGISTRY_CAPACITY"
  | "GLOSSARY_RUNTIME_SELECTOR_INVALID"
  | "GLOSSARY_RUNTIME_CREDENTIAL_UNAVAILABLE"
  | "GLOSSARY_TRANSPORT_ERROR";

/** 実行に紐付く主対象、発見済みチェックアウトID、または明示リポジトリパスを選ぶ。 */
export type GlossaryCheckoutSelector =
  | { kind: "primary" }
  | { kind: "checkout"; checkoutId: string }
  | { kind: "repository"; path: string };

/** 公開できる対象情報。紐付いた主対象はチェックアウトID、明示対象はパスで参照する。 */
export type GlossaryCheckoutTarget = (
  | {
      checkoutId: string;
      selector: Extract<GlossaryCheckoutSelector, { kind: "checkout" }>;
      isPrimary: true;
    }
  | {
      selector: Extract<GlossaryCheckoutSelector, { kind: "repository" }>;
      isPrimary: false;
    }
) & {
  repositoryName: string;
  branch: string;
  pathLabel: string;
};

/** 操作固有のデータにランタイム通信の版を添える。 */
export type GlossaryRuntimeEnvelope<T> = T & {
  schemaVersion: typeof GLOSSARY_RUNTIME_SCHEMA_VERSION;
};

/** 診断内容と作用の確実性、再試行可否を呼び出し側へ返す共通エラー。 */
export type GlossaryOperationError = {
  ok: false;
  code: GlossaryOperationErrorCode;
  message: string;
  effect: GlossaryEffect;
  retryable: boolean;
  issues?: GlossaryValidationIssue[];
  details?: Record<string, unknown>;
};

/** 一覧または検索の一ページと総件数。用語集がなければ版はnull。 */
export type GlossaryListResult = {
  ok: true;
  revision: string | null;
  entries: GlossaryEntry[];
  total: number;
  offset: number;
  pageSize: number;
};

/** 一致した代表語または別名と、その版で読み取った項目を返す。 */
export type GlossaryGetResult = {
  ok: true;
  revision: string;
  matchedText: string;
  entry: GlossaryEntry;
};

/** 検証操作の成功。ファイル自体の有効性はスナップショットが表す。 */
export type GlossaryValidationResult = {
  ok: true;
  snapshot: GlossarySnapshot;
};

/** 書き込み操作の成功。変更の有無と処理後の版・項目を返す。 */
export type GlossaryMutationResult = {
  ok: true;
  outcome: GlossaryMutationOutcome;
  effect: Extract<GlossaryEffect, "applied" | "none">;
  revision: string | null;
  entries: GlossaryEntry[];
};

/** 操作固有の成功値、または作用や再試行可否を持つ共通の失敗。 */
export type GlossaryOperationResult<T> = T | GlossaryOperationError;

/** 利用者の明示依頼と、自発的な登録を別の作成モードとして扱う。 */
export type GlossaryCreateMode = "explicit" | "proactive";

/** 一項目の登録。自発作成の場合は解決済みの登録制限も渡す。 */
export type GlossaryCreateRequest = {
  mode: GlossaryCreateMode;
  entry: GlossaryEntryInput;
  proactiveCreateLimit?: number | null;
};

/** 複数項目を一回の作成として扱い、自発作成なら件数制限を適用する。 */
export type GlossaryCreateBatchRequest = {
  mode: GlossaryCreateMode;
  entries: readonly GlossaryEntryInput[];
  proactiveCreateLimit?: number | null;
};

/** 読み取った版を前提に代表語を指定し、項目を置き換える入力。 */
export type GlossaryUpdateRequest = {
  expectedRevision: string;
  targetTerm: string;
  entry: GlossaryEntryInput;
};

/** 読み取った版を前提に、削除する項目の代表語を指定する。 */
export type GlossaryDeleteRequest = {
  expectedRevision: string;
  targetTerm: string;
};

/** 一覧取得の開始位置と最大件数。省略時は取得側の既定値を使う。 */
export type GlossaryPageRequest = {
  offset?: number;
  pageSize?: number;
};

/** ページ指定に照合する検索文字列を加える。 */
export type GlossarySearchRequest = GlossaryPageRequest & {
  query: string;
};
