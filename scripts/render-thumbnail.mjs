#!/usr/bin/env node
/**
 * Renders assets/scf-thumbnail.html to a 1920×1080 PNG.
 *
 * Served over a local HTTP server rather than opened as a file:// URL, because
 * Chrome refuses cross-directory font loads from file://, and the whole point
 * is that the thumbnail uses the same Geist files as the site.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = join(root, "assets", "scf-thumbnail.png");

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".woff2": "font/woff2",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(req.url.split("?")[0]));
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Must be async: spawnSync would block the event loop, and the server would
// never answer the very request Chrome is waiting on.
const status = await new Promise((resolve, reject) => {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--window-size=1920,1080",
      "--virtual-time-budget=6000",
      `--screenshot=${out}`,
      `http://127.0.0.1:${port}/assets/scf-thumbnail.html`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  chrome.on("error", reject);
  chrome.on("exit", resolve);
});

server.close();

if (status !== 0) {
  process.stderr.write(`chrome exited ${status}\n`);
  process.exit(1);
}

process.stdout.write(`wrote ${out}\n`);
