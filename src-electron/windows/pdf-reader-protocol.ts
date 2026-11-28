import { app, protocol } from "electron";
import { PDF_READER_SCHEME } from "../../src-shared/file-explorer/pdf-reader-contract.js";
import {
  servePdfReaderAsset,
  shouldBlockPdfReaderNavigation,
} from "./pdf-reader-assets.js";

/** PDF リーダーのスキームを登録し、各 WebContents でリーダーに関わる遷移を制限する。 */
export function registerPdfReaderScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PDF_READER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-frame-navigate", (details) => {
      if (
        shouldBlockPdfReaderNavigation({
          url: details.url,
          isMainFrame: details.isMainFrame,
          frameUrl: details.frame?.url,
          initiatorUrl: details.initiator?.url,
        })
      )
        details.preventDefault();
    });
  });
}

/** リーダーのスキームの要求を、同梱資材のディレクトリに限定した応答処理へ渡す。 */
export function registerPdfReaderProtocol(root: string): void {
  protocol.handle(PDF_READER_SCHEME, (request) =>
    servePdfReaderAsset(request, root),
  );
}
