// Shared audit log for admin override saves and media uploads.
// Files starting with "_" are not routed by Pages. They are import-only.

import { decodeJwtPayload, fetchUserProfile } from "./_auth.js";

export const AUDIT_CAP = 200;
export const HOMEPAGE_AUDIT_ID = "homepage";
export const UNKNOWN_ACTOR = "Unknown";

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

export function isOpaqueActorId(value, userId) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (userId != null && userId !== "" && text === String(userId).trim()) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
  if (/^[0-9a-f]{32}$/i.test(text)) return true;
  return false;
}

function firstHumanString(userId, ...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() && !isOpaqueActorId(value, userId)) {
      return value.trim();
    }
  }
  return "";
}

function identitySources(role, payload) {
  const roleObj = role && typeof role === "object" ? role : {};
  const payloadObj = payload && typeof payload === "object" ? payload : {};
  return [roleObj, payloadObj, roleObj.user, payloadObj.user].filter((src) => src && typeof src === "object");
}

function joinNames(first, last) {
  return [first, last]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function pickUserId(sources, jwtSources = []) {
  for (const key of ["user_id", "userId", "sub"]) {
    for (const src of sources) {
      const value = src[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
  }
  // Only the JWT payload (not the profile) may contribute a bare .id, so a
  // Django profile row id cannot collide with another staff member's user id.
  for (const src of jwtSources) {
    const value = src && src.id;
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

export function actorFromSession(token, role) {
  const payload = decodeJwtPayload(token) || {};
  const sources = identitySources(role, payload);
  const jwtSources = [payload, payload.user].filter((src) => src && typeof src === "object");
  const userId = pickUserId(sources, jwtSources);
  const name = firstHumanString(
    userId,
    ...sources.flatMap((src) => [
      src.display_name,
      src.displayName,
      src.full_name,
      src.fullName,
      joinNames(src.first_name, src.last_name),
      joinNames(src.firstName, src.lastName),
      src.name,
    ])
  );
  const username = firstHumanString(
    userId,
    ...sources.flatMap((src) => [src.username, src.preferred_username, src.preferredUsername])
  );
  const email = firstString(...sources.map((src) => src.email), ...sources.map((src) => src.user_email));
  const actor = {};
  if (userId) actor.userId = userId;
  if (name) actor.name = name;
  if (email) actor.email = email;
  if (username) actor.username = username;
  if (!actor.userId && !actor.name && !actor.email && !actor.username) actor.label = "staff";
  return actor;
}

export async function actorForAudit(token, role, env) {
  try {
    const fromSession = actorFromSession(token, role);
    if (fromSession.name || fromSession.username || fromSession.email || !env) return fromSession;
    const profile = await fetchUserProfile(token, env);
    if (!profile) return fromSession;
    return actorFromSession(token, { ...(role && typeof role === "object" ? role : {}), ...profile });
  } catch {
    return actorFromSession(token, role);
  }
}

export function actorDisplayName(actor) {
  if (!actor || typeof actor !== "object") return UNKNOWN_ACTOR;
  const userId = actor.userId == null ? "" : String(actor.userId).trim();
  const candidates = [actor.name, actor.displayName, actor.display_name, actor.username, actor.email, actor.label];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() && !isOpaqueActorId(value, userId)) return value.trim();
  }
  return UNKNOWN_ACTOR;
}

function sanitizeActor(actor) {
  const src = actor && typeof actor === "object" ? actor : {};
  const userId = src.userId != null ? String(src.userId).trim().slice(0, 80) : "";
  const name = firstHumanString(userId, src.name, src.displayName, src.display_name);
  const email = firstString(src.email);
  const username = firstHumanString(userId, src.username);
  const next = {};
  if (userId) next.userId = userId;
  if (name) next.name = name.slice(0, 120);
  if (email) next.email = email.slice(0, 200);
  if (username) next.username = username.slice(0, 80);
  if (!next.userId && !next.name && !next.email && !next.username) {
    const label = firstHumanString("", src.label) || "staff";
    next.label = label.slice(0, 40);
  }
  return next;
}

export function resolveActorForRead(entryActor, sessionActor) {
  const stored = sanitizeActor(entryActor);
  if (actorDisplayName(stored) !== UNKNOWN_ACTOR) return stored;
  const session = sanitizeActor(sessionActor);
  if (stored.userId && session.userId && stored.userId === session.userId) {
    return sanitizeActor({
      ...stored,
      name: session.name,
      email: session.email,
      username: session.username,
    });
  }
  return stored;
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
    actor: sanitizeActor(entry && entry.actor),
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

export async function readAudit(kv, pageId, sessionActor) {
  if (!kv || !isAuditPageId(pageId)) return [];
  try {
    const raw = await kv.get(auditKey(pageId));
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice().reverse().map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      return { ...entry, actor: resolveActorForRead(entry.actor, sessionActor) };
    });
  } catch {
    return [];
  }
}
