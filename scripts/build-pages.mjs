import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const dist = join(projectRoot, "dist");

const copyEntries = [
  "admin",
  "assets",
  "clearboat.html",
  "event.html",
  "_headers",
  "favicon.png",
  "fonts",
  "account-menu.js",
  "image-slot.js",
  "meta-pixel.js",
  "index.html",
  "photos",
  "rnb.html",
  "site-overrides.js",
  "uploads",
  "admin.html",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const entry of copyEntries) {
  const source = join(projectRoot, entry);
  if (!existsSync(source)) continue;
  cpSync(source, join(dist, entry), { recursive: true });
}

// Browser copy of the responsive image helper the pages import, so the
// functions and the pages build variant URLs from one source.
cpSync(join(projectRoot, "functions", "_lib", "responsive-image.js"), join(dist, "responsive-image.js"));

console.log(`Built static Pages output at ${dist}`);
