import { createContext, useContext } from "react";

import { PREVIEW_WHEEL_ZOOM_STEP_DEFAULT } from "../../src-shared/settings/provider-settings-state.js";

export const PreviewWheelZoomStepContext = createContext<number | null>(PREVIEW_WHEEL_ZOOM_STEP_DEFAULT);

export function usePreviewWheelZoomStep(): number | null {
  return useContext(PreviewWheelZoomStepContext);
}
