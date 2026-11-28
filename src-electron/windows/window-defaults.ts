/** Home と起動画面の初期サイズと、縮小できる最小サイズ。 */
export const HOME_WINDOW_DEFAULT_BOUNDS = {
  width: 1440,
  height: 960,
  minWidth: 900,
  minHeight: 680,
} as const;

/** 各 Session の会話ウィンドウを作る際の初期サイズと最小サイズ。 */
export const SESSION_WINDOW_DEFAULT_BOUNDS = {
  width: 1520,
  height: 940,
  minWidth: 1100,
  minHeight: 720,
} as const;

/** 差分を別ウィンドウに表示する際の初期サイズと最小サイズ。 */
export const DIFF_WINDOW_DEFAULT_BOUNDS = {
  width: 1680,
  height: 980,
  minWidth: 900,
  minHeight: 640,
} as const;

/** 独立したファイルプレビューの初期サイズと最小サイズ。 */
export const FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS = {
  width: 1360,
  height: 900,
  minWidth: 760,
  minHeight: 560,
} as const;

/** Character の新規作成・編集に使うウィンドウの初期サイズと最小サイズ。 */
export const CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS = {
  width: 1280,
  height: 920,
  minWidth: 820,
  minHeight: 680,
} as const;
