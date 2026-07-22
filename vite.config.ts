import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The Matrix Rust SDK is delivered as a ~48MB wasm module loaded via a
// top-level `await uniffiInitAsync()` in main.tsx. Modern Vite targets ESM that
// supports top-level await natively (target esnext), so no plugin is needed.
// `process.env` is shimmed because a few transitive helpers reference it.
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env": {},
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    target: "esnext",
    // The generated bindings + wasm are large; don't warn on chunk size.
    chunkSizeWarningLimit: 60_000,
  },
  // The generated uniffi bindings are enormous single files; let esbuild handle
  // them rather than pre-bundling.
  optimizeDeps: {
    exclude: ["uniffi-bindgen-react-native"],
  },
});
