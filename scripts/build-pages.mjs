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
  "events.html",
  "favicon.png",
  "fonts",
  "image-slot.js",
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

console.log(`Built static Pages output at ${dist}`);
