import path from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        home: path.resolve(process.cwd(), "index.html"),
        session: path.resolve(process.cwd(), "session.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        path.resolve("C:/Users/zgmfx/.codex/characters"),
      ],
    },
    port: 4173,
  },
});
