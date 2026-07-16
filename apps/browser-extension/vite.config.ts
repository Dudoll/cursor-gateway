import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: "index.html",
        background: "src/background.ts",
        contentBridge: "src/contentBridge.ts"
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          if (chunk.name === "contentBridge") return "contentBridge.js";
          return "assets/[name]-[hash].js";
        }
      }
    }
  }
});
