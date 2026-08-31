// Shared audit log for admin override saves and media uploads.
// Files starting with "_" are not routed by Pages. They are import-only.

import { decodeJwtPayload } from "./_auth.js";

export const AUDIT_CAP = 200;
export const HOMEPAGE_AUDIT_ID = "homepage";

export function auditKey(pageId) {
  return `audit:event:${pageId}`;
}

export function isEventPageId(value) {
  return /^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(String(value || "").trim());
}

export function isAuditPageId(value) {
  const id = String(value || "").trim();
  return isEventPageId(id) || id === HOMEPAGE_AUDIT_ID;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function actorFromSession(token, role) {
  const payload = decodeJwtPayload(token) || {};
  const roleObj = role && typeof role === "object" ? role : {};
  const userId = payload.user_id ?? payload.userId ?? payload.sub;
  const email = firstString(roleObj.email, payload.email);
  const username = firstString(roleObj.username, roleObj.name, payload.username, payload.name);
  const actor = {};
  if (userId !== undefined && userId !== null && String(userId).trim()) {
    actor.userId = String(userId);
  }
  if (email) actor.email = email;
  if (username) actor.username = username;
  if (!actor.userId && !actor.email && !actor.username) actor.label = "staff";
  return actor;
}

function fieldSnapshot(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

export function changedOverrideFields(previous, next) {
  const changed = [];
  for (const key of ["description", "image", "checkoutEventId", "accentColor"]) {
    const before = previous && previous[key] != null ? String(previous[key]) : "";
    const after = next && next[key] != null ? String(next[key]) : "";
    if (before !== after) changed.push(key);
  }
  const prevFields = previous && previous.fields && typeof previous.fields === "object" ? previous.fields : {};
  const nextFields = next && next.fields && typeof next.fields === "object" ? next.fields : {};
  const keys = new Set([...Object.keys(prevFields), ...Object.keys(nextFields)]);
  for (const fieldKey of keys) {
    if (fieldSnapshot(prevFields[fieldKey]) !== fieldSnapshot(nextFields[fieldKey])) {
      changed.push(`fields.${fieldKey}`);
    }
  }
  return changed;
}

function sanitizeEntry(entry) {
  const pageId = String((entry && entry.pageId) || "").trim();
  const next = {
    at: typeof entry.at === "string" && entry.at ? entry.at : new Date().toISOString(),
    actor: entry.actor && typeof entry.actor === "object" ? entry.actor : { label: "staff" },
    action: entry.action === "upload" ? "upload" : "save",
    pageId,
  };
  if (Array.isArray(entry.changedFields)) {
    next.changedFields = entry.changedFields.map((key) => String(key)).slice(0, 200);
  }
  if (entry.file && typeof entry.file === "object") {
    next.file = {
      name: String(entry.file.name || "upload").slice(0, 200),
      key: String(entry.file.key || "").slice(0, 500),
      contentType: String(entry.file.contentType || "").slice(0, 100),
    };
  }
  return next;
}

export async function appendAudit(kv, entry) {
  try {
    if (!kv || !entry || !isAuditPageId(entry.pageId)) return;
    const record = sanitizeEntry(entry);
    const key = auditKey(record.pageId);
    const raw = await kv.get(key);
    let entries = [];
    if (raw) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        entries = [];
      }
    }
    entries.push(record);
    if (entries.length > AUDIT_CAP) entries = entries.slice(-AUDIT_CAP);
    await kv.put(key, JSON.stringify(entries));
  } catch (error) {
    console.error("audit append failed", error && error.message ? error.message : error);
  }
}

export async function readAudit(kv, pageId) {
  if (!kv || !isAuditPageId(pageId)) return [];
  try {
    const raw = await kv.get(auditKey(pageId));
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice().reverse();
  } catch {
    return [];
  }
}
