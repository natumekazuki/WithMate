export const HOME_WINDOW_DEFAULT_BOUNDS = {
  width: 1440,
  height: 960,
  minWidth: 900,
  minHeight: 680,
} as const;

export const SESSION_WINDOW_DEFAULT_BOUNDS = {
  width: 1520,
  height: 940,
  minWidth: 900,
  minHeight: 680,
} as const;

export const DIFF_WINDOW_DEFAULT_BOUNDS = {
  width: 1680,
  height: 980,
  minWidth: 900,
  minHeight: 640,
} as const;

export const COMPANION_CHAT_WINDOW_DEFAULT_BOUNDS = {
  width: SESSION_WINDOW_DEFAULT_BOUNDS.width,
  height: SESSION_WINDOW_DEFAULT_BOUNDS.height,
  minWidth: SESSION_WINDOW_DEFAULT_BOUNDS.minWidth,
  minHeight: SESSION_WINDOW_DEFAULT_BOUNDS.minHeight,
} as const;

export const COMPANION_REVIEW_WINDOW_DEFAULT_BOUNDS = {
  width: 1680,
  height: 980,
  minWidth: 980,
  minHeight: 680,
} as const;
