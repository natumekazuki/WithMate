import type { WithMateWindowApi } from "./withmate-window.js";

declare global {
  interface Window {
    withmate?: WithMateWindowApi;
  }
}

export {};
