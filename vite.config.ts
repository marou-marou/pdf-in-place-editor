import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the app from /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  // Pre-bundle up front so the dev server never reloads the page mid-session.
  optimizeDeps: {
    include: ["pdfjs-dist", "pdf-lib", "@pdf-lib/fontkit", "@pdf-lib/standard-fonts"],
  },
});
