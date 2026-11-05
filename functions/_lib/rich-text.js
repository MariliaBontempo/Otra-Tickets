import { heroMetaTextReplacements } from "./hero-meta-text.js";
// Rich text for page edits made with the pencil editor (font size, colour,
// bold, italic, underline). A text field keeps its plain `value` (what the
// homepage card, schedule line, audit log and older code read) and may add
// `html` with the formatting. Only this small markup is ever stored:
//   <strong> <em> <u> <br>
//   <span data-otra-size="75" data-otra-color="#1c9ebd">
// Sizes are percents of the element's own font size, never px, so they follow
// the template's responsive clamp() sizes (see site-overrides.js for the CSS
// and the phone cap on sizes above 100%).

// site-overrides.js holds the same parser for the browser; keep the two in
// step (server/test/rich-text.test.mjs checks they agree).

export const RICH_TEXT_SIZES = [50, 70, 75, 80, 90, 100, 110, 125, 150, 200];
export const RICH_TEXT_MAX_HTML = 40000;
const MAX_DEPTH = 6;
const DROP_WITH_CONTENT = /<(script|style|template|iframe|object|embed|noscript|textarea|title|svg|math|select|button)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)|(<)/g;
const FORMAT_TAGS = { strong: "strong", b: "strong", em: "em", i: "em", u: "u" };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    const key = name.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    if (key === "nbsp") return " ";
    const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

function attrValue(attrs, name) {
  const match = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i").exec(attrs || "");
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
}

export function richTextSize(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d{2,3}$/.test(text)) return 0;
  const size = Number(text);
  return RICH_TEXT_SIZES.includes(size) ? size : 0;
}

export function richTextColor(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return "#" + short[1] + short[1] + short[2] + short[2] + short[3] + short[3];
  return /^#[0-9a-f]{6}$/.test(text) ? text : "";
}

// Imported/editor HTML gets converted to canonical relative metadata. Never
// store arbitrary CSS. Pixel sizes use the editor's 16px reference, not fixed
// public pixels (24px =>150% of that field's responsive template size).
export function richTextInlineSize(raw) {
  const match = /^(\d+(?:\.\d+)?)(%|em|rem|px)$/i.exec(String(raw || "").trim());
  if (!match) return 0;
  const number = Number(match[1]);
  if (!(number > 0)) return 0;
  const percent = match[2].toLowerCase() === "%" ? number : match[2].toLowerCase() === "px" ? number / 16 * 100 : number * 100;
  return RICH_TEXT_SIZES.reduce((best, size) => Math.abs(size - percent) < Math.abs(best - percent) ? size : best, 100);
}

function inlineProperty(attrs, name) {
  const style = attrValue(attrs, "style");
  let result = "";
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index >= 0 && part.slice(0, index).trim().toLowerCase() === name) result = part.slice(index + 1).trim();
  }
  return result;
}

// Parses any HTML into the allowed tree. Unknown tags are dropped but their
// text is kept; script-like elements are dropped with their content.
// A node is a string, { tag: "br" }, { tag: "strong"|"em"|"u", children }
// or { tag: "span", size, color, children }.
export function parseRichText(html) {
  const src = String(html ?? "")
    .slice(0, RICH_TEXT_MAX_HTML)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(DROP_WITH_CONTENT, "");
  const root = { tag: null, src: "", children: [] };
  const stack = [root];
  let skippedDepth = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (text) => {
    if (!text) return;
    const list = top().children;
    String(text).split(/\r\n?|\n/).forEach((line, index) => {
      if (index) list.push({ tag: "br" });
      if (!line) return;
      if (typeof list[list.length - 1] === "string") list[list.length - 1] += line;
      else list.push(line);
    });
  };
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(src))) {
    if (match[4] != null || match[5] != null) {
      pushText(decodeEntities(match[4] ?? match[5]));
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (name === "br") {
      if (!closing) top().children.push({ tag: "br" });
      continue;
    }
    if (name === "p" || name === "div" || name === "li") {
      if (closing) {
        top().children.push({ tag: "br" });
        if (name === "p") top().children.push({ tag: "br" });
      }
      continue;
    }
    const isFormat = Object.prototype.hasOwnProperty.call(FORMAT_TAGS, name);
    const isSpan = name === "span" || name === "font";
    if (!isFormat && !isSpan) continue;
    if (closing) {
      if (skippedDepth) { skippedDepth -= 1; continue; }
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].src === name) { stack.length = i; break; }
      }
      continue;
    }
    if (skippedDepth || stack.length > MAX_DEPTH) { skippedDepth += 1; continue; }
    let node;
    if (isFormat) node = { tag: FORMAT_TAGS[name], src: name, children: [] };
    else {
      const attrs = match[3];
      const fontSize = name === "font" ? { 1: 50, 2: 75, 3: 100, 4: 125, 5: 150, 6: 150, 7: 200 }[attrValue(attrs, "size")] || 0 : 0;
      const size = richTextSize(attrValue(attrs, "data-otra-size")) || richTextInlineSize(inlineProperty(attrs, "font-size")) || fontSize;
      const color = richTextColor(attrValue(attrs, "data-otra-color")) || richTextColor(inlineProperty(attrs, "color")) || (name === "font" ? richTextColor(attrValue(attrs, "color")) : "");
      node = size || color ? { tag: "span", src: name, size, color, children: [] } : { tag: null, src: name, children: [] };
    }
    top().children.push(node);
    stack.push(node);
  }
  return tidy(root.children, true);
}

function tidy(nodes, isRoot) {
  const out = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      if (!node) continue;
      if (typeof out[out.length - 1] === "string") out[out.length - 1] += node;
      else out.push(node);
      continue;
    }
    if (node.tag === "br") { out.push({ tag: "br" }); continue; }
    const children = tidy(node.children || [], false);
    if (!node.tag) {
      for (const child of children) {
        if (typeof child === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += child;
        else out.push(child);
      }
      continue;
    }
    if (!children.length) continue;
    const next = { tag: node.tag, children };
    if (node.tag === "span") { next.size = node.size || 0; next.color = node.color || ""; }
    out.push(next);
  }
  if (isRoot) {
    while (out.length && out[0].tag === "br") out.shift();
    while (out.length && out[out.length - 1].tag === "br") out.pop();
  }
  return out;
}

function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function serializeRichText(nodes) {
  return (nodes || []).map((node) => {
    if (typeof node === "string") return escapeText(node);
    if (node.tag === "br") return "<br>";
    const inner = serializeRichText(node.children);
    if (node.tag === "span") {
      const size = node.size ? ` data-otra-size="${node.size}"` : "";
      const color = node.color ? ` data-otra-color="${node.color}"` : "";
      return `<span${size}${color}>${inner}</span>`;
    }
    return `<${node.tag}>${inner}</${node.tag}>`;
  }).join("");
}

export function richTextHasFormatting(nodes) {
  return (nodes || []).some((node) => typeof node === "object" && node.tag !== "br");
}

export function richTextToPlain(nodes) {
  return (nodes || []).map((node) => {
    if (typeof node === "string") return node;
    if (node.tag === "br") return "\n";
    return richTextToPlain(node.children);
  }).join("");
}

// Canonical stored form of an html edit: "" when it has no formatting
// (the field then stays plain text, exactly as before rich text existed).
export function sanitizeRichText(html) {
  const nodes = parseRichText(html);
  return richTextHasFormatting(nodes) ? serializeRichText(nodes) : "";
}

// For a text field being saved or served: returns { value, html } where html
// is "" for plain fields. With formatting, value is rebuilt from the html so
// the two never disagree.
export function normalizeRichTextField(value, html) {
  const plain = typeof value === "string" ? value : "";
  if (typeof html !== "string" || !html || html.length > RICH_TEXT_MAX_HTML) return { value: plain, html: "" };
  const nodes = parseRichText(html);
  if (!richTextHasFormatting(nodes)) return { value: plain, html: "" };
  return { value: richTextToPlain(nodes), html: serializeRichText(nodes) };
}

// Composite information cells retain plain title/subtitle in value and keep
// sanitized rich versions separately. Old readers still understand value.
export function normalizeRichInfoField(value, htmlParts) {
  if (typeof value !== "string" || !value.startsWith("otra-info-cell:") || !htmlParts || typeof htmlParts !== "object") return null;
  let info;
  try { info = JSON.parse(value.slice("otra-info-cell:".length)); } catch { return null; }
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const title = normalizeRichTextField(info.title, htmlParts.title);
  const subtitle = normalizeRichTextField(info.subtitle, htmlParts.subtitle);
  if (!title.html && !subtitle.html) return null;
  const parts = {};
  if (title.html) parts.title = title.html;
  if (subtitle.html) parts.subtitle = subtitle.html;
  return {
    value: "otra-info-cell:" + JSON.stringify({ title: title.value, subtitle: subtitle.value }),
    htmlParts: parts,
  };
}

export function richTextAllowedForField(key, field) {
  return !!field && field.type === "text" && !(typeof field.value === "string" && field.value.startsWith("otra-info-cell:"));
}

// Display-only hero-line normalization: keep style and plain-card semantics
// aligned even when "Wednesday to Sunday: 12:00 PM" spans several tags.
export function normalizeRichHeroMeta(field) {
  const nodes = parseRichText(field.html);
  const text = richTextToPlain(nodes);
  const edits = heroMetaTextReplacements(text);
  const entries = [];
  let cursor = 0;
  const walk = (list) => list.forEach((node, index) => {
    if (typeof node === "string") {
      entries.push({ list, index, start: cursor, end: cursor + node.length });
      cursor += node.length;
    } else if (node.tag === "br") cursor += 1;
    else walk(node.children || []);
  });
  walk(nodes);
  for (const edit of edits.reverse()) {
    const insertAt = entries.findIndex((entry) => entry.end >= edit.start);
    entries.forEach((entry, index) => {
      if (entry.end < edit.start || entry.start > edit.end) return;
      const old = entry.list[entry.index];
      const from = Math.max(0, edit.start - entry.start);
      const to = Math.min(old.length, edit.end - entry.start);
      entry.list[entry.index] = old.slice(0, from) + (index === insertAt ? edit.text : "") + old.slice(Math.max(from, to));
    });
  }
  return { value: richTextToPlain(nodes), html: serializeRichText(nodes) };
}
