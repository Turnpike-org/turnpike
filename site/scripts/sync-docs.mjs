#!/usr/bin/env node
/**
 * Copies the canonical markdown from the repository's /docs into the Astro
 * content directory before a build.
 *
 * The markdown lives at the repository root on purpose: if this site is ever
 * down, the GitHub-rendered files are the fallback link. The site is a view
 * over that source, never the other way round, so the copy is generated,
 * gitignored, and never edited in place.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "docs");
const target = join(here, "..", "src", "content", "docs");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const files = readdirSync(source).filter((name) => name.endsWith(".md"));
if (files.length === 0) {
  console.error(`No markdown found in ${source}`);
  process.exit(1);
}

for (const name of files) copyFileSync(join(source, name), join(target, name));
console.log(`synced ${files.length} docs from /docs`);
