import { withWithMateApi } from "../renderer-withmate-api.js";

export async function openMateTalkWindow() {
  await withWithMateApi((api) => api.openMateTalkWindow());
}

