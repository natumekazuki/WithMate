/** 現在のウィンドウのクエリ文字列を取り出し、ブラウザー外でも空文字列で扱えるようにする。 */
function getLocationSearch(): string {
  const browserWindow = (
    globalThis as typeof globalThis & {
      window?: { location?: { search?: string } };
    }
  ).window;
  if (!browserWindow?.location?.search) {
    return "";
  }

  return browserWindow.location.search;
}

/** ウィンドウの URL が指定する Session ID を返し、指定がなければ null とする。 */
export function getSessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("sessionId");
}

/** 親 Session とは別に URL が指定した Auxiliary ID を返す。省略時は null。 */
export function getAuxiliarySessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("auxiliarySessionId");
}

/** 差分ウィンドウへ URL で渡されたトークンを取得し、未指定なら null を返す。 */
export function getDiffTokenFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("token");
}
