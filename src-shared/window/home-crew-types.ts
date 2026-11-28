import type { AuxiliarySessionSummary } from "../auxiliary/auxiliary-session-state.js";
import type { HomeSessionSummary } from "../session/session-state.js";
import type { SessionMonitorContextMenuPoint } from "./withmate-window-types.js";

/** Crew一覧のMain。保存された個体、親・起点、現在のウィンドウ有無を含む。 */
export type HomeCrewMember = HomeSessionSummary & {
  incarnationId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  createdAt: string;
  isWindowOpen: boolean;
};

/** Crew一覧のページ。Mainの一覧、関連Auxiliaryの概要と次の開始位置を返す。 */
export type HomeCrewPageResult = {
  entries: HomeCrewMember[];
  auxiliarySessions: AuxiliarySessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** 対象のSession個体を指定し、一覧の指定座標でメニューを開く。 */
export type HomeCrewContextMenuRequest = {
  sessionId: string;
  incarnationId: string;
  point: SessionMonitorContextMenuPoint;
};
