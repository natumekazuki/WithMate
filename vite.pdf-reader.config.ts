import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.resolve(projectRoot, "dist/pdf-reader");

export default defineConfig({
  root: path.resolve(projectRoot, "src/pdf-reader"),
  base: "./",
  publicDir: false,
  plugins: [{
    name: "bundled-pdf-reader-resources",
    async closeBundle() {
      for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
        await cp(path.resolve(projectRoot, "node_modules/pdfjs-dist", directory), path.join(outputRoot, directory), { recursive: true });
      }
      await cp(path.resolve(projectRoot, "node_modules/pdfjs-dist/web/images"), path.join(outputRoot, "images"), { recursive: true });
    },
  }],
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
  },
});
