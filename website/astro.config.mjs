import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://getacc.dev",
  output: "static",
  trailingSlash: "always",
  compressHTML: true,
  build: { format: "directory" },
});
