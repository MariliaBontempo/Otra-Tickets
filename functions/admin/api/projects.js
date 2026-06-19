// Cloudflare Pages Function: GET/POST /admin/api/projects
//
// Staff-only Claude Design project upload. The ZIP is stored in R2 and a draft
// event record is stored in KV. Publishing the draft into the public homepage
// can build on this record.

import { requireStaff, json } from "./_auth.js";
import JSZip from "jszip";

const MAX_BYTES = 50 * 1024 * 1024;
const DRAFT_PREFIX = "site-event:";

export async function onRequestGet(context) {
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const projects = await listProjects(kv);
  return json({ projects });
}

export async function onRequestPost(context) {
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const bucket = context.env.OVERRIDE_IMAGES;
  if (!bucket) return json({ error: "project store not configured" }, 503);

  const url = new URL(context.request.url);
  if (url.searchParams.get("action") === "publish") {
    const id = (url.searchParams.get("id") || "").trim();
    const mode = (url.searchParams.get("mode") || "clone").trim();
    const otraGuideId = (url.searchParams.get("otraGuideId") || "").trim();
    if (!isDraftId(id)) return json({ error: "invalid draft id" }, 400);
    if (mode !== "clone" && mode !== "update") return json({ error: "invalid publish mode" }, 400);
    if (mode === "update" && !/^\d+$/.test(otraGuideId)) {
      return json({ error: "Otra Guide event ID is required for update" }, 400);
    }
    const project = await getProject(kv, id);
    if (!project) return json({ error: "draft not found" }, 404);
    if (mode === "clone") {
      const next = {
        ...project,
        status: "published",
        publishedAt: new Date().toISOString(),
        publishMode: "clone",
      };
      await kv.put(`${DRAFT_PREFIX}${id}`, JSON.stringify(next));
      return json({ project: next, mode, local: true });
    }
    return json(
      {
        error:
          mode === "update"
            ? "Otra Guide update endpoint is not configured yet"
            : "Otra Guide clone endpoint is not configured yet",
        mode,
        otraGuideId,
        project,
      },
      501
    );
  }

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "invalid form data" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "zip file is required" }, 400);
  if (!isZip(file)) return json({ error: "file must be a zip project" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "zip file must be 50MB or smaller" }, 400);

  const id = `draft-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const originalName = file.name || "claude-design.zip";
  const bytes = await file.arrayBuffer();
  const parsed = await parseClaudeDesignZip(bytes, id, bucket);
  const key = `claude-design/${id}.zip`;
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: "application/zip",
      cacheControl: "private, max-age=0",
    },
    customMetadata: {
      originalName,
      draftId: id,
    },
  });

  const project = {
    id,
    title: parsed.title || titleFromFileName(originalName),
    description: parsed.description || "",
    source: "claude-design",
    zipKey: key,
    originalName,
    status: "draft",
    createdAt: new Date().toISOString(),
    image: parsed.image || "",
    claudeDesign: parsed,
  };
  await kv.put(`${DRAFT_PREFIX}${id}`, JSON.stringify(project));
  return json({ project });
}

async function listProjects(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: DRAFT_PREFIX, cursor });
    for (const item of page.keys || []) {
      const project = await getProject(kv, item.name.slice(DRAFT_PREFIX.length));
      if (project) out.push(project);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getProject(kv, id) {
  const raw = await kv.get(`${DRAFT_PREFIX}${id}`, "json");
  return raw && typeof raw === "object" ? normalizeProject(raw, id) : null;
}

function normalizeProject(raw, id) {
  return {
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Claude Design Event",
    description: typeof raw.description === "string" ? raw.description : "",
    image: typeof raw.image === "string" ? raw.image : "",
    claudeDesign: raw.claudeDesign && typeof raw.claudeDesign === "object" ? raw.claudeDesign : null,
    source: raw.source === "claude-design" ? raw.source : "claude-design",
    zipKey: typeof raw.zipKey === "string" ? raw.zipKey : "",
    originalName: typeof raw.originalName === "string" ? raw.originalName : "",
    status: raw.status === "published" ? "published" : "draft",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : "",
    otraGuideId: raw.otraGuideId ? String(raw.otraGuideId) : "",
  };
}

async function parseClaudeDesignZip(bytes, draftId, bucket) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("could not read Claude Design zip");
  }

  const htmlEntry = Object.values(zip.files).find((entry) => !entry.dir && /\.html?$/i.test(entry.name));
  if (!htmlEntry) throw new Error("Claude Design zip must include an html file");

  const html = await htmlEntry.async("string");
  const baseDir = htmlEntry.name.includes("/") ? htmlEntry.name.replace(/\/[^/]*$/, "") : "";
  const assets = await storeReferencedAssets(zip, html, baseDir, draftId, bucket);
  const assetUrl = (value) => {
    const normalized = normalizeAssetPath(value, baseDir);
    return assets.get(normalized) || assets.get(value) || value || "";
  };

  const titleBlock = matchSection(html, /<section[^>]*class=["'][^"']*ev-titleblock[^"']*["'][\s\S]*?<\/section>/i);
  const story = matchSection(html, /<section[^>]*id=["']story["'][\s\S]*?<\/section>/i);
  const video = matchSection(html, /<section[^>]*class=["'][^"']*ev-video[^"']*["'][\s\S]*?<\/section>/i);
  const band = matchSection(html, /<section[^>]*class=["'][^"']*ev-band[^"']*["'][\s\S]*?<\/section>/i);
  const photoBand = matchSection(html, /<section[^>]*class=["'][^"']*ev-photoband[^"']*["'][\s\S]*?<\/section>/i);
  const info = sectionAfterEyebrow(html, "Practical Info");
  const rates = sectionAfterEyebrow(html, "Rates");

  const heroImage = assetUrl(attr(matchSection(html, /<img[^>]*class=["'][^"']*ev-hero-img[^"']*["'][^>]*>/i), "src"));
  const storyImage = assetUrl(attr(matchSection(story, /<img[^>]*class=["'][^"']*ev-story-img[^"']*["'][^>]*>/i), "src"));
  const videoImage = assetUrl(attr(matchSection(video, /<img[^>]*>/i), "src"));
  const bandImage = assetUrl(matchSection(band, /background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i));
  const photoBandImage = assetUrl(attr(matchSection(photoBand, /<img[^>]*>/i), "src"));
  const storyParagraphs = allMatches(story, /<p\b[^>]*>([\s\S]*?)<\/p>/gi)
    .map(cleanText)
    .filter(Boolean)
    .filter((text) => !/^the reef below\./i.test(text));
  const description = storyParagraphs.join("\n\n");
  const title = cleanText(matchSection(titleBlock, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i));
  const subtitle = cleanText(matchSection(titleBlock, /<div[^>]*class=["'][^"']*ev-sub[^"']*["'][^>]*>([\s\S]*?)<\/div>/i));
  const tag = cleanText(matchSection(titleBlock, /<p[^>]*class=["'][^"']*ev-tag[^"']*["'][^>]*>([\s\S]*?)<\/p>/i));

  return {
    title: [title, subtitle].filter(Boolean).join(" - "),
    displayTitle: title,
    subtitle,
    eyebrow: cleanText(matchSection(titleBlock, /<span[^>]*class=["'][^"']*ev-eyebrow[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)),
    tag,
    meta: allMatches(matchSection(titleBlock, /<div[^>]*class=["'][^"']*ev-hero-meta[^"']*["'][^>]*>([\s\S]*?)<\/div>/i), /<span[^>]*>([\s\S]*?)<\/span>/gi)
      .map(cleanText)
      .filter((text) => text && text !== "·"),
    description,
    image: heroImage,
    storyImage,
    pullQuote: cleanText(matchSection(story, /<p[^>]*class=["'][^"']*ev-pull[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)),
    storyEyebrow: cleanText(matchSection(story, /<span[^>]*class=["'][^"']*ev-eyebrow[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)),
    videoImage,
    bandImage,
    bandEyebrow: cleanText(matchSection(band, /<span[^>]*class=["'][^"']*ev-eyebrow[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)),
    bandTitle: cleanText(matchSection(band, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i)),
    appreciates: allMatches(band, /<div[^>]*class=["'][^"']*ev-like[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["']n["'][^>]*>[\s\S]*?<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>/gi)
      .map(cleanText)
      .filter(Boolean),
    photoBandImage,
    practicalTitle: cleanText(matchSection(info, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i)),
    practicalInfo: extractCells(info),
    ratesTitle: cleanText(matchSection(rates, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i)),
    rates: extractRates(rates),
    assets: Array.from(assets.values()),
  };
}

async function storeReferencedAssets(zip, html, baseDir, draftId, bucket) {
  const refs = new Set();
  for (const src of allMatches(html, /\b(?:src|poster)=["']([^"']+)["']/gi)) refs.add(src);
  for (const src of allMatches(html, /url\(["']?([^"')]+)["']?\)/gi)) refs.add(src);

  const out = new Map();
  await Promise.all(
    [...refs]
      .filter((src) => src && !/^(?:https?:|data:|#)/i.test(src))
      .map(async (src) => {
        const normalized = normalizeAssetPath(src, baseDir);
        const entry = zip.file(normalized);
        if (!entry) return;
        const ext = normalized.split(".").pop().toLowerCase();
        if (!["jpg", "jpeg", "png", "webp", "avif", "gif"].includes(ext)) return;
        const safeName = safeFileName(normalized.split("/").pop() || `asset.${ext}`);
        const key = `${draftId}/claude-design/${safeName}`;
        await bucket.put(key, await entry.async("arraybuffer"), {
          httpMetadata: {
            contentType: contentTypeFor(ext),
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: { draftId, sourcePath: normalized },
        });
        const url = `/override-images/${key}`;
        out.set(normalized, url);
        out.set(src, url);
      })
  );
  return out;
}

function extractCells(html) {
  return [...String(html || "").matchAll(/<div[^>]*class=["'][^"']*ev-info-cell[^"']*["'][^>]*>\s*<div[^>]*class=["']k["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=["']v["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)]
    .map((match) => {
      const key = cleanText(match[1]);
      const value = cleanText(match[2]);
      return key && value ? { key, value } : null;
    })
    .filter(Boolean);
}

function extractRates(html) {
  return allMatches(html, /<div[^>]*class=["'][^"']*ev-rate[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)
    .map((rate) => {
      const name = cleanText(matchSection(rate, /<div[^>]*class=["']rk["'][^>]*>([\s\S]*?)<\/div>/i));
      const priceText = cleanText(matchSection(rate, /<div[^>]*class=["']rp["'][^>]*>([\s\S]*?)<\/div>/i));
      const description = cleanText(matchSection(rate, /<div[^>]*class=["']rn["'][^>]*>([\s\S]*?)<\/div>/i));
      const price = Number((priceText.match(/[\d.]+/) || ["0"])[0]);
      const currency = priceText.includes("ƒ") ? "ANG" : priceText.includes("€") ? "EUR" : "USD";
      return name ? { name, price, currency, description } : null;
    })
    .filter(Boolean);
}

function sectionAfterEyebrow(html, label) {
  return allMatches(html, /<section\b[^>]*>[\s\S]*?<\/section>/gi).find((section) => {
    const eyebrow = cleanText(matchSection(section, /<span[^>]*class=["'][^"']*ev-eyebrow[^"']*["'][^>]*>([\s\S]*?)<\/span>/i));
    return eyebrow.toLowerCase() === String(label).toLowerCase();
  }) || "";
}

function normalizeAssetPath(src, baseDir) {
  const clean = decodeURIComponent(String(src || "").split("#")[0].split("?")[0]).replace(/^\.?\//, "");
  if (!baseDir || clean.startsWith(baseDir + "/")) return clean;
  return `${baseDir}/${clean}`.replace(/\/+/g, "/");
}

function safeFileName(name) {
  return String(name || "asset").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function contentTypeFor(ext) {
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
  }[ext] || "application/octet-stream";
}

function matchSection(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? match[1] || match[0] : "";
}

function allMatches(value, pattern) {
  return [...String(value || "").matchAll(pattern)].map((match) => match[1] || match[0]);
}

function attr(tag, name) {
  const match = String(tag || "").match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function cssUrl(value) {
  const match = String(value || "").match(/url\(["']?([^"')]+)["']?\)/i);
  return match ? match[1] : "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function isDraftId(id) {
  return /^draft-[a-zA-Z0-9-]+$/.test(id);
}

function titleFromFileName(name) {
  return String(name || "Claude Design Event")
    .replace(/\.zip$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Claude Design Event";
}

function isZip(file) {
  const name = (file.name || "").toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}
