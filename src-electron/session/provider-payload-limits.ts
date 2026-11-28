/** プロバイダー文字列から初期プレビューへ残す UTF-16 コード単位数の既定値。 */
export const PROVIDER_TEXT_PREVIEW_LIMIT = 64 * 1024;
/** ネイティブ項目の一覧を診断用の JSON にまとめる際の既定の文字数枠。 */
export const PROVIDER_RAW_ITEMS_JSON_LIMIT = 512 * 1024;
/** 一件のネイティブ項目を複製・短縮する際の既定の文字数枠。 */
export const PROVIDER_RAW_ITEM_CLONE_LIMIT = 128 * 1024;

/** 元の長さと省略の有無を含む、構造化された文字列プレビュー。 */
type TruncatedText = {
  text: string;
  truncated: true;
  originalLength: number;
};

/** プロバイダーの項目を診断に残す形。種別のほか、取得時刻や短縮済みデータを持てる。 */
export type BoundedProviderRawItem = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

/** 一件の複製を通じて残り容量と切り詰めを追跡し、循環の検出や秘匿化に使う状態。 */
type RawItemBudgetState = {
  remaining: number;
  textPreviewLimit?: number;
  truncated: boolean;
  seen: WeakSet<object>;
  sanitizeText?: (value: string, previewLimit: number) => string;
};

const RAW_ITEM_TRUNCATION_MARKER = {
  type: "withmate.value_truncated",
  truncated: true,
  reason: "provider raw item budget exceeded",
};
const RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE = 1024;

/** 元の長さと省略した長さを示す共通のプレビュー末尾を作る。 */
function buildTruncationSuffix(originalLength: number, limit: number): string {
  return `\n...[truncated ${originalLength - limit} chars; originalLength=${originalLength}]`;
}

/** 文字列だけを対象にし、上限内はそのまま、超過時は先頭と省略表示を返す。 */
export function toProviderTextPreview(
  value: string | null | undefined,
  limit = PROVIDER_TEXT_PREVIEW_LIMIT,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}${buildTruncationSuffix(value.length, limit)}`;
}

/** 必要に応じて秘匿化してから短縮し、元の長さを残す必要がある場合は構造化して返す。 */
function toTruncatedText(
  value: string,
  limit: number,
  sanitizeText?: RawItemBudgetState["sanitizeText"],
): string | TruncatedText {
  const projected = sanitizeText ? sanitizeText(value, limit) : value;
  const originalLength = value.length > limit ? value.length : projected.length;
  if (originalLength <= limit) {
    return projected;
  }

  return {
    text: `${projected.slice(0, limit)}${buildTruncationSuffix(originalLength, limit)}`,
    truncated: true,
    originalLength,
  };
}

/** 限定した値の JSON 上の長さを測る。値が JSON を生成しない場合は null 相当の長さを見積もる。 */
function measureBoundedJson(value: unknown): number {
  return JSON.stringify(value)?.length ?? 4;
}

/** 容量があれば消費する。足りなければ残りを 0 にして切り詰めを記録する。 */
function consumeRawItemBudget(
  state: RawItemBudgetState,
  length: number,
): boolean {
  if (length > state.remaining) {
    state.remaining = 0;
    state.truncated = true;
    return false;
  }

  state.remaining -= length;
  return true;
}

/** 文字列を残り容量に合わせて短縮・秘匿化し、JSON 化の膨張で収まらなければさらに短い表示または省略印を使う。 */
function cloneStringWithinRawItemBudget(
  value: string,
  state: RawItemBudgetState,
): unknown {
  if (state.remaining <= 0) {
    state.truncated = true;
    return RAW_ITEM_TRUNCATION_MARKER;
  }

  const previewLimit = Math.max(
    0,
    Math.min(
      state.textPreviewLimit ?? PROVIDER_TEXT_PREVIEW_LIMIT,
      state.remaining - 256,
    ),
  );
  let boundedValue =
    previewLimit > 0
      ? toTruncatedText(value, previewLimit, state.sanitizeText)
      : RAW_ITEM_TRUNCATION_MARKER;
  let length = measureBoundedJson(boundedValue);
  if (state.textPreviewLimit !== undefined && length > state.remaining) {
    // エスケープにより 1 コードユニットが JSON 上で最大 6 文字になることがある。
    // 有用なフィールドを落とす代わりに、元の文字列のプレビューを短くして試し直す。
    const escapedLimit = Math.floor((state.remaining - 256) / 6);
    if (escapedLimit > 0 && escapedLimit < previewLimit) {
      boundedValue = toTruncatedText(value, escapedLimit, state.sanitizeText);
      length = measureBoundedJson(boundedValue);
    }
  }
  if (typeof boundedValue !== "string") {
    state.truncated = true;
  }

  if (consumeRawItemBudget(state, length)) {
    return boundedValue;
  }

  return RAW_ITEM_TRUNCATION_MARKER;
}

/** プリミティブの JSON 上の長さを消費し、残り容量を超える値を省略印に置き換える。 */
function clonePrimitiveWithinRawItemBudget(
  value: unknown,
  state: RawItemBudgetState,
): unknown {
  const length = measureBoundedJson(value);
  if (consumeRawItemBudget(state, length)) {
    return value;
  }

  return RAW_ITEM_TRUNCATION_MARKER;
}

/** 配列を順番に複製し、循環参照を切り、容量を使い切った後の要素数を省略印に記録する。 */
function cloneArrayWithinRawItemBudget(
  value: unknown[],
  state: RawItemBudgetState,
): unknown[] {
  if (state.seen.has(value)) {
    state.truncated = true;
    return [RAW_ITEM_TRUNCATION_MARKER];
  }

  state.seen.add(value);
  const entries: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (state.remaining <= 0) {
      state.truncated = true;
      break;
    }

    entries.push(cloneValueWithinRawItemBudget(value[index], state));
    if (state.remaining <= 0) {
      break;
    }
  }

  state.seen.delete(value);
  if (entries.length < value.length) {
    state.truncated = true;
    entries.push({
      ...RAW_ITEM_TRUNCATION_MARKER,
      omittedItems: value.length - entries.length,
    });
  }

  return entries;
}

/** 自身の列挙可能なプロパティだけを複製し、キーにも容量上限と秘匿化を適用して循環参照を切る。 */
function cloneObjectWithinRawItemBudget(
  value: Record<string, unknown>,
  state: RawItemBudgetState,
): Record<string, unknown> {
  if (state.seen.has(value)) {
    state.truncated = true;
    return { ...RAW_ITEM_TRUNCATION_MARKER };
  }

  state.seen.add(value);
  const output: Record<string, unknown> = {};
  let omittedEntries = 0;

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }

    if (key.length >= state.remaining) {
      state.truncated = true;
      omittedEntries += 1;
      continue;
    }
    const projectedKey = state.sanitizeText
      ? state.sanitizeText(key, key.length)
      : key;
    const keyLength = measureBoundedJson(projectedKey);
    if (state.remaining <= keyLength) {
      state.truncated = true;
      omittedEntries += 1;
      continue;
    }

    consumeRawItemBudget(state, keyLength);
    output[projectedKey] = cloneValueWithinRawItemBudget(value[key], state);
    if (state.remaining <= 0) {
      state.truncated = true;
      break;
    }
  }

  state.seen.delete(value);
  if (omittedEntries > 0) {
    output.withmateTruncated = {
      ...RAW_ITEM_TRUNCATION_MARKER,
      omittedEntries,
    };
  }

  return output;
}

/** JSON に残せる値を種別ごとに複製する。診断プレビューでは空のコンテナも容量として数える。 */
function cloneValueWithinRawItemBudget(
  value: unknown,
  state: RawItemBudgetState,
): unknown {
  // 短縮したログプレビューではノードごとにも容量を消費させ、
  // 空のコンテナや入れ子の区切り記号が抜粋の容量を占有しないようにする。
  if (state.textPreviewLimit !== undefined && !consumeRawItemBudget(state, 8)) {
    return RAW_ITEM_TRUNCATION_MARKER;
  }
  if (typeof value === "string") {
    return cloneStringWithinRawItemBudget(value, state);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return clonePrimitiveWithinRawItemBudget(value, state);
  }

  if (Array.isArray(value)) {
    return cloneArrayWithinRawItemBudget(value, state);
  }

  if (value && typeof value === "object") {
    return cloneObjectWithinRawItemBudget(
      value as Record<string, unknown>,
      state,
    );
  }

  return undefined;
}

/** 一件を個別の容量枠内で複製し、どこかを短縮した場合は項目データに省略の印を加える。 */
function cloneRawItemWithinBudget(
  item: BoundedProviderRawItem,
  budget: number,
  sanitizeText?: RawItemBudgetState["sanitizeText"],
  textPreviewLimit?: number,
): BoundedProviderRawItem {
  const state: RawItemBudgetState = {
    remaining: Math.max(0, budget),
    textPreviewLimit,
    truncated: false,
    seen: new WeakSet<object>(),
    sanitizeText,
  };
  const boundedItem = cloneValueWithinRawItemBudget(
    item,
    state,
  ) as BoundedProviderRawItem;

  if (state.truncated) {
    return {
      type: boundedItem.type ?? item.type,
      timestamp: boundedItem.timestamp,
      data: {
        ...(boundedItem.data ?? {}),
        withmateTruncated: {
          ...RAW_ITEM_TRUNCATION_MARKER,
          maxLength: budget,
        },
      },
    };
  }

  return boundedItem;
}

/** シリアライズに必要な余裕を確保したうえで、ネイティブ項目の表示用コピーを容量制限付きで作る。 */
export function boundProviderRawItem(
  item: BoundedProviderRawItem,
  limit = PROVIDER_RAW_ITEM_CLONE_LIMIT,
  sanitizeText?: RawItemBudgetState["sanitizeText"],
  textPreviewLimit?: number,
): BoundedProviderRawItem {
  return cloneRawItemWithinBudget(
    item,
    Math.max(0, limit - RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE),
    sanitizeText,
    textPreviewLimit,
  );
}

/** 文字列以外は限定したコピーを JSON にしてから、同じ表示用の文字数制限を適用する。未定義値は表示しない。 */
export function stringifyBoundedProviderValue(
  value: unknown,
  limit = PROVIDER_TEXT_PREVIEW_LIMIT,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return toProviderTextPreview(value, limit);
  }

  const state: RawItemBudgetState = {
    remaining: Math.max(0, limit - RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE),
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const boundedValue = cloneValueWithinRawItemBudget(value, state);
  const serialized = JSON.stringify(boundedValue);
  return toProviderTextPreview(serialized, limit);
}

/** 項目を順番に取り込み、全体の上限を意識した診断用 JSON の配列を作る。 */
export function stringifyBoundedProviderRawItems(
  items: BoundedProviderRawItem[],
  limit = PROVIDER_RAW_ITEMS_JSON_LIMIT,
): string {
  const collector = new BoundedProviderRawItems(limit);
  for (const item of items) {
    collector.append(item);
  }
  return collector.stringify();
}

/** 限定済みの JSON 断片を保持し、既存項目を走査し直さず一覧を追加更新する。 */
export class BoundedProviderRawItems {
  private readonly serializedItems: string[] = [];
  private omittedItems = 0;
  private currentLength = 2;

  /** 空の JSON 配列から始め、最終のシリアライズに使う文字数枠を設定する。 */
  constructor(private readonly limit = PROVIDER_RAW_ITEMS_JSON_LIMIT) {}

  /** 一件を残り容量に合わせて短縮し、区切りを含めて入る場合だけ順番どおりに追加する。 */
  append(item: BoundedProviderRawItem): void {
    const commaLength = this.currentLength === 2 ? 0 : 1;
    const remainingItemBudget = Math.max(
      0,
      this.limit -
        this.currentLength -
        commaLength -
        RAW_ITEM_SERIALIZATION_OVERHEAD_RESERVE,
    );
    const serializedItem = JSON.stringify(
      cloneRawItemWithinBudget(item, remainingItemBudget),
    );
    const nextLength = this.currentLength + commaLength + serializedItem.length;
    if (nextLength <= this.limit) {
      this.serializedItems.push(serializedItem);
      this.currentLength = nextLength;
    } else {
      this.omittedItems += 1;
    }
  }

  /** 全断片を JSON 配列にまとめる。省略があれば、末尾の項目より省略件数の表示を優先する。 */
  stringify(): string {
    let retainedCount = this.serializedItems.length;
    let currentLength = this.currentLength;
    let omittedItems = this.omittedItems;
    /** 省略件数と設定した上限を記録する診断用の項目を組み立てる。 */
    const truncationMarker = () =>
      JSON.stringify({
        type: "withmate.raw_items_truncated",
        data: { omittedItems, maxLength: this.limit },
      });

    if (omittedItems === 0) {
      return `[${this.serializedItems.join(",")}]`;
    }

    let marker = truncationMarker();
    while (
      retainedCount > 0 &&
      currentLength + 1 + marker.length > this.limit
    ) {
      retainedCount -= 1;
      currentLength -=
        (retainedCount === 0 ? 0 : 1) +
        this.serializedItems[retainedCount].length;
      omittedItems += 1;
      marker = truncationMarker();
    }

    const retained = this.serializedItems.slice(0, retainedCount);
    retained.push(marker);
    return `[${retained.join(",")}]`;
  }
}
