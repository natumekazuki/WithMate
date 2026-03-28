import type { WithMateWindowApi } from "./withmate-window-api.js";

declare global {
  interface Window {
    withmate?: WithMateWindowApi;
  }
}

export {};
