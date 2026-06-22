// Cloudflare Pages Function: GET/POST /admin/api/projects
//
// Staff-only Claude Design project upload. The ZIP is stored in R2 and a draft
// event record is stored in KV. Publishing the draft into the public homepage
// can build on this record.

import { apiBase, requireStaff, json } from "./_auth.js";
import JSZip from "jszip";

const MAX_BYTES = 50 * 1024 * 1024;
const DRAFT_PREFIX = "site-event:";

export async function onRequestGet(context) {
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const projects = await listProjects(kv);
  return json({ projects });
}

export async function onRequestPost(context) {
  const accessToken = await requireStaff(context.request, context.env);
  if (!accessToken) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const url = new URL(context.request.url);
  if (url.searchParams.get("action") === "publish") {
    const id = (url.searchParams.get("id") || "").trim();
    if (!isDraftId(id)) return json({ error: "invalid draft id" }, 400);
    const project = await getProject(kv, id);
    if (!project) return json({ error: "draft not found" }, 404);
    if (!project.otraGuideId || !project.otraGuideSlug) {
      return json({ error: "draft has not been created on Otra Guide yet", project }, 409);
    }
    try {
      const reconciled = await reconcileTickets(context, accessToken, project);
      await otraFetch(context, accessToken, `/events/update/${encodeURIComponent(project.otraGuideSlug)}/`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ published: true }),
      });
      const next = {
        ...reconciled,
        status: "published",
        publishedAt: new Date().toISOString(),
        syncError: "",
      };
      await putProject(kv, next);
      return json({ project: next });
    } catch (error) {
      const latest = (await getProject(kv, id)) || project;
      const failed = { ...latest, syncError: error.message };
      await putProject(kv, failed);
      return json({ error: error.message, project: failed }, 502);
    }
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

  const bytes = await file.arrayBuffer();
  if (url.searchParams.get("action") === "inspect") {
    const parsed = await parseClaudeDesignZip(bytes, "inspection", null);
    return json({
      title: parsed.title || titleFromFileName(file.name),
      description: parsed.description || "",
      rates: parsed.rates || [],
      practicalInfo: parsed.practicalInfo || [],
    });
  }

  const bucket = context.env.OVERRIDE_IMAGES;
  if (!bucket) return json({ error: "project store not configured" }, 503);

  const id = `draft-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const originalName = file.name || "claude-design.zip";
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

  let project = {
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
    teamId: cleanInteger(form.get("teamId")),
    teamName: String(form.get("teamName") || "").trim(),
    regionId: cleanInteger(form.get("regionId")),
    startDate: String(form.get("startDate") || ""),
    endDate: String(form.get("endDate") || ""),
    isPerennial: String(form.get("isPerennial") || "false") === "true",
    location: String(form.get("location") || "").trim(),
    ticketQuantities: parseQuantities(form.get("ticketQuantities"), parsed.rates.length),
    ticketTypeIds: [],
  };
  await putProject(kv, project);

  try {
    if (!project.regionId) throw new Error("region is required");
    if (!project.teamId) {
      if (!project.teamName) throw new Error("team is required");
      const team = await otraFetch(context, accessToken, "/teams/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: project.teamName, region: project.regionId }),
      });
      project = { ...project, teamId: team.id, teamName: team.name || project.teamName };
      await putProject(kv, project);
    } else {
      await otraFetch(context, accessToken, `/teams/${project.teamId}/`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region: project.regionId }),
      });
    }

    project = await createOtraGuideEvent(context, accessToken, bucket, project);
    await putProject(kv, project);
    project = await reconcileTickets(context, accessToken, project);
    project = { ...project, syncError: "" };
    await putProject(kv, project);
    return json({ project }, 201);
  } catch (error) {
    const latest = (await getProject(kv, id)) || project;
    const failed = { ...latest, syncError: error.message };
    await putProject(kv, failed);
    return json({ project: failed, warning: error.message }, 202);
  }
}

async function createOtraGuideEvent(context, accessToken, bucket, project) {
  if (project.otraGuideId) return project;
  if (!project.startDate || !project.endDate || !project.location) {
    throw new Error("start date, end date and location are required");
  }
  const form = new FormData();
  form.set("title", project.title);
  form.set("description", project.description || project.title);
  form.set("category", "339");
  form.set("team", String(project.teamId));
  form.set("start_date", project.startDate);
  form.set("end_date", project.endDate);
  form.set("location", project.location);
  form.set("published", "false");
  form.set("is_perennial", project.isPerennial ? "true" : "false");
  form.set("is_recurring", project.isPerennial ? "true" : "false");

  if (project.claudeDesign && project.claudeDesign.heroKey) {
    const hero = await bucket.get(project.claudeDesign.heroKey);
    if (hero) {
      form.set(
        "image",
        new File([await hero.arrayBuffer()], project.claudeDesign.heroName || "hero.jpg", {
          type: (hero.httpMetadata && hero.httpMetadata.contentType) || "image/jpeg",
        })
      );
    }
  }
  const event = await otraFetch(context, accessToken, "/events/create/", { method: "POST", body: form });
  return {
    ...project,
    otraGuideId: String(event.id),
    otraGuideSlug: event.slug,
  };
}

async function reconcileTickets(context, accessToken, project) {
  const rates = (project.claudeDesign && project.claudeDesign.rates) || [];
  const ids = [...(project.ticketTypeIds || [])];
  for (let index = 0; index < rates.length; index += 1) {
    const rate = rates[index];
    const payload = {
      name: rate.name,
      description: rate.description || "",
      price: rate.price,
      quantity: project.ticketQuantities[index] || 500,
      base_currency: ["USD", "EUR", "ANG"].includes(rate.currency) ? rate.currency : "USD",
    };
    const existingId = ids[index];
    const path = existingId
      ? `/ticket/create/tickets/${project.otraGuideId}/${existingId}/`
      : `/ticket/create/tickets/${project.otraGuideId}/`;
    const ticket = await otraFetch(context, accessToken, path, {
      method: existingId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    ids[index] = ticket.id;
    project = { ...project, ticketTypeIds: ids };
    await putProject(context.env.OVERRIDES, project);
  }
  return project;
}

async function otraFetch(context, accessToken, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("accept", "application/json");
  let response;
  try {
    response = await fetch(`${apiBase(context.env)}${path}`, { ...options, headers });
  } catch {
    throw new Error("could not reach Otra Guide");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail || data.error || Object.values(data).flat().join(" ");
    throw new Error(detail || `Otra Guide request failed (${response.status})`);
  }
  return data;
}

function putProject(kv, project) {
  return kv.put(`${DRAFT_PREFIX}${project.id}`, JSON.stringify(project));
}

function cleanInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseQuantities(value, count) {
  let raw = [];
  try {
    raw = JSON.parse(String(value || "[]"));
  } catch {
    raw = [];
  }
  return Array.from({ length: count }, (_, index) => {
    const quantity = Number.parseInt(raw[index], 10);
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 500;
  });
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
    otraGuideSlug: typeof raw.otraGuideSlug === "string" ? raw.otraGuideSlug : "",
    teamId: cleanInteger(raw.teamId),
    teamName: typeof raw.teamName === "string" ? raw.teamName : "",
    regionId: cleanInteger(raw.regionId),
    startDate: typeof raw.startDate === "string" ? raw.startDate : "",
    endDate: typeof raw.endDate === "string" ? raw.endDate : "",
    isPerennial: !!raw.isPerennial,
    location: typeof raw.location === "string" ? raw.location : "",
    ticketQuantities: Array.isArray(raw.ticketQuantities) ? raw.ticketQuantities : [],
    ticketTypeIds: Array.isArray(raw.ticketTypeIds) ? raw.ticketTypeIds : [],
    syncError: typeof raw.syncError === "string" ? raw.syncError : "",
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
  const assets = bucket ? await storeReferencedAssets(zip, html, baseDir, draftId, bucket) : new Map();
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

  const heroSource = attr(matchSection(html, /<img[^>]*class=["'][^"']*ev-hero-img[^"']*["'][^>]*>/i), "src");
  const heroImage = assetUrl(heroSource);
  const heroPath = normalizeAssetPath(heroSource, baseDir);
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
    heroKey: assets.get(`${heroPath}:key`) || "",
    heroName: safeFileName(heroPath.split("/").pop() || "hero.jpg"),
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
        out.set(`${normalized}:key`, key);
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
