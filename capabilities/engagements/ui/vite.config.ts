import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// This package builds TWO single-file bundles from separate entry HTML files:
//   INPUT=index.html   -> the chat host page (served on HOST_PORT)
//   INPUT=sandbox.html -> the sandbox proxy  (served on SANDBOX_PORT, a distinct origin)
// The two-origin split is REQUIRED: the sandbox self-test in src/sandbox.ts asserts it
// cannot reach window.top, which only holds when host and sandbox differ by origin.
const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set (expected index.html or sandbox.html)");
}

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: {
      input: INPUT,
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});
