// @ts-check
import { defineConfig } from "astro/config";

// Project page on GitHub Pages: https://turnpike-org.github.io/turnpike/
// `base` is overridable so a custom domain only needs an env var, not a rebuild
// of every link in the markup.
export default defineConfig({
  site: process.env.SITE_URL ?? "https://turnpike-org.github.io",
  base: process.env.SITE_BASE ?? "/turnpike",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
