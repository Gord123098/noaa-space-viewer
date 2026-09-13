import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const isUserSite = repositoryName.endsWith(".github.io");

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repositoryName && !isUserSite ? `/${repositoryName}/` : "/",
  plugins: [react()],
  resolve: { alias: { "@": projectRoot } },
  build: { outDir: "dist-pages", emptyOutDir: true },
});
