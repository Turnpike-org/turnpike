import { visit } from "unist-util-visit";

/**
 * Rewrites cross-document markdown links for the rendered site.
 *
 * The markdown under /docs is the canonical copy and has to keep working when
 * GitHub renders it, which means its internal links must be real relative file
 * paths: `./07.reliability.md`. The site serves the same content at
 * `/docs/reliability`, so those links are rewritten here rather than in the
 * source — the alternative is links that work in one place and 404 in the
 * other, and the file on GitHub is the fallback a submission depends on.
 *
 * Anchors are preserved: `./04.facilitator-api.md#error-semantics` becomes
 * `/docs/facilitator-api#error-semantics`.
 */
const DOC_LINK = /^\.\/(\d+)\.([^/#?]+)\.md(#.*)?$/;

/**
 * @returns A unified transformer
 */
export default function rehypeDocsLinks() {
  const base = (process.env.SITE_BASE ?? "/").replace(/\/$/, "");

  return (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;

      const href = node.properties?.href;
      if (typeof href !== "string") return;

      const match = DOC_LINK.exec(href);
      if (!match) return;

      const [, , slug, anchor = ""] = match;
      node.properties.href = `${base}/docs/${slug}${anchor}`;
    });
  };
}
