// @ts-check
import { defineConfig } from "astro/config";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";

import rehypeDocsLinks from "./plugins/rehype-docs-links.mjs";
import rehypeStaticMermaid from "./plugins/rehype-static-mermaid.mjs";

// Hosted on Vercel at a custom domain; `base` and `site` stay overridable so a
// move back to a project page is a config change rather than a rewrite of every
// link in the markup.
export default defineConfig({
  site: process.env.SITE_URL ?? "https://turnpike.0xo.in",
  base: process.env.SITE_BASE ?? "/",
  trailingSlash: "ignore",
  redirects: { "/docs": "/docs/overview" },
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  markdown: {
    // Shiki, with the same near-black ground as the rest of the site.
    shikiConfig: { theme: "github-dark-default", wrap: false },
    rehypePlugins: [
      rehypeStaticMermaid,
      rehypeDocsLinks,
      rehypeSlug,
      [
        rehypeAutolinkHeadings,
        {
          behavior: "append",
          properties: { className: ["heading-anchor"], ariaHidden: true, tabIndex: -1 },
          content: { type: "text", value: "#" },
        },
      ],
    ],
  },
});
