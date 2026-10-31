import type { WithMateWindowApi } from "../src-shared/ipc/withmate-window-api.js";

declare global {
  interface Window {
    withmate?: WithMateWindowApi;
  }
}

export {};
