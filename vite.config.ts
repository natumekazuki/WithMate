import path from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        home: path.resolve(process.cwd(), "index.html"),
        session: path.resolve(process.cwd(), "session.html"),
        character: path.resolve(process.cwd(), "character.html"),
        diff: path.resolve(process.cwd(), "diff.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())],
    },
    port: 4173,
  },
});
