import type { WithMateWindowApi } from "../src-shared/ipc/withmate-window-api.js";

declare global {
  /** デスクトップでは preload が renderer の Window に WithMate API を公開する。 */
  interface Window {
    withmate?: WithMateWindowApi;
  }
}

export {};
