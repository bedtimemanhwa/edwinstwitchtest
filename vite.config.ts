import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "src/web",
  publicDir: resolve(__dirname, "public"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "src/web/overlay.html"),
        dashboard: resolve(__dirname, "src/web/dashboard.html"),
        demo: resolve(__dirname, "src/web/demo.html"),
      },
    },
  },
});
