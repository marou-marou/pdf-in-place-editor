import { defineConfig } from "vite";

export default defineConfig({
  // Pre-bundle up front so the dev server never reloads the page mid-session.
  optimizeDeps: {
    include: ["pdfjs-dist", "pdf-lib", "@pdf-lib/fontkit", "@pdf-lib/standard-fonts"],
  },
});
