import { createContext, useContext } from "react";

import { PREVIEW_WHEEL_ZOOM_STEP_DEFAULT } from "../../src-shared/settings/provider-settings-state.js";

/** プレビューのホイールズーム刻みを伝えるコンテキスト。提供元がなければ共有設定の既定値を使う。 */
export const PreviewWheelZoomStepContext = createContext<number | null>(
  PREVIEW_WHEEL_ZOOM_STEP_DEFAULT,
);

/** 現在のプレビューに適用するホイールズーム設定を取り出す。 */
export function usePreviewWheelZoomStep(): number | null {
  return useContext(PreviewWheelZoomStepContext);
}
