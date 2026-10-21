import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://getacc.dev",
  output: "static",
  trailingSlash: "always",
  compressHTML: true,
  cacheDir: "./.astro/cache",
  vite: { cacheDir: ".astro/vite" },
  build: { format: "directory" },
});
