import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        home: path.resolve(projectRoot, "index.html"),
        session: path.resolve(projectRoot, "session.html"),
        character: path.resolve(projectRoot, "character.html"),
        diff: path.resolve(projectRoot, "diff.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot)],
    },
    port: 4173,
  },
});
