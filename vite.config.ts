import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "editor-vendor";
          if (id.includes("marked") || id.includes("sanitize-html")) return "markdown-vendor";
          if (id.includes("react")) return "react-vendor";
        },
      },
    },
  },
});
