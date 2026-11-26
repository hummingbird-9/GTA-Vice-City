import { defineConfig } from "vite";

export default defineConfig({
  // Keep source HTML and modules in src/, but publish the built app at the
  // repository root so root-based hosts can serve it directly.
  root: "src",
  publicDir: "../public",
  base: "./",

  build: {
    outDir: "..",
    // The output directory is the repository itself. Never empty it.
    emptyOutDir: false,
  },

  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
