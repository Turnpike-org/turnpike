import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

/**
 * Replaces ```mermaid fences with SVG rendered at build time.
 *
 * The diagrams are rendered once, offline, by `npm run diagrams` and committed
 * as SVG. Nothing about Mermaid ships to the browser — no 400KB parser, no
 * runtime layout pass, no flash of unstyled code block. The markdown keeps its
 * ```mermaid fence so that GitHub, which renders Mermaid natively, stays a
 * working fallback for the same file.
 *
 * Diagrams are matched by their first meaningful line, so a page can be
 * reordered or a diagram moved between pages without rewiring anything.
 */
const here = dirname(fileURLToPath(import.meta.url));
const diagramDir = join(here, "..", "src", "diagrams");

const DIAGRAMS = [
  { match: /^sequenceDiagram/m, file: "lifecycle.svg", label: "The payment lifecycle, from unpaid request to settled transaction" },
  { match: /^flowchart\s+TB/m, file: "system.svg", label: "Turnpike system architecture: payment plane, discovery plane, state, and Stellar" },
];

/**
 * Reads a rendered diagram and wraps it so it scrolls rather than overflowing.
 *
 * @param file - SVG filename inside src/diagrams
 * @param label - Accessible description of the diagram
 * @returns A hast element containing the inline SVG
 */
function svgFigure(file, label) {
  const svg = readFileSync(join(diagramDir, file), "utf8")
    // Strip the XML prolog; this is being inlined into HTML, not served as a file.
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!DOCTYPE[^>]*>/i, "");

  const tree = fromHtml(svg, { fragment: true, space: "svg" });
  const root = tree.children.find((node) => node.tagName === "svg");

  if (root) {
    // Let CSS drive the size: a fixed pixel width breaks on a phone.
    delete root.properties.width;
    delete root.properties.height;
    root.properties.role = "img";
    root.properties["aria-label"] = label;
    root.properties.preserveAspectRatio = "xMidYMid meet";
  }

  return {
    type: "element",
    tagName: "figure",
    properties: { className: ["diagram"] },
    children: [
      { type: "element", tagName: "div", properties: { className: ["diagram-scroll"] }, children: tree.children },
      { type: "element", tagName: "figcaption", properties: {}, children: [{ type: "text", value: label }] },
    ],
  };
}

/**
 * Rehype plugin swapping mermaid code blocks for pre-rendered SVG.
 *
 * @returns A unified transformer
 */
export default function rehypeStaticMermaid() {
  return (tree) => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "pre" || !parent || index === undefined) return;

      const code = node.children.find((child) => child.tagName === "code");
      if (!code) return;

      // Shiki labels the fence on the <pre> as data-language; older pipelines
      // put a language-* class on the <code>. Accept either.
      const classes = [...(code.properties?.className ?? []), ...(node.properties?.className ?? [])];
      const language = node.properties?.dataLanguage ?? code.properties?.dataLanguage;
      if (language !== "mermaid" && !classes.includes("language-mermaid")) return;

      // Highlighted code is a tree of token spans, so gather the text.
      const collect = (nodes) =>
        nodes
          .map((child) =>
            child.type === "text" ? child.value : child.children ? collect(child.children) : "",
          )
          .join("");
      const source = collect(code.children);
      const diagram = DIAGRAMS.find((candidate) => candidate.match.test(source));
      if (!diagram) {
        throw new Error(
          `A mermaid block has no pre-rendered SVG. Add it to plugins/rehype-static-mermaid.mjs and run 'npm run diagrams'.\n${source.slice(0, 120)}`,
        );
      }

      parent.children[index] = svgFigure(diagram.file, diagram.label);
    });
  };
}
