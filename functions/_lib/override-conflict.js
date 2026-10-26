// Conflict check for admin override saves.
//
// The editor sends the version it loaded (base.updatedAt) and, for every key
// it changed, the value it saw before the change (base.fields and the top
// level keys in base). When the stored document is still that version the
// save is applied as sent. When someone else saved in between, the save is
// merged key by key onto the newer document: a key the editor changed wins
// only when nobody else changed that same key, every other key keeps the
// newer stored value. If another save changed a key this editor also
// changed, the save is refused so neither edit is lost silently.

import { TOP_LEVEL_KEYS } from "./page-override.js";

export const OVERRIDE_CONFLICT_MESSAGE =
  "This page was changed in another tab or by another editor since you opened it. Reload the page to see the latest version, then make your edit again.";

function sameField(a, b) {
  if (!a || !b) return !a && !b;
  return a.type === b.type && a.value === b.value && (a.kind || "") === (b.kind || "") && (a.label || "") === (b.label || "");
}

// current: the stored override as the editor GET serves it (or null).
// incoming: the normalized override the editor sent.
// base: null for a client that sends no version (saved as sent), otherwise
// { updatedAt, fields: { key: field | null }, top: { key: value } }.
// Returns { override } to store, or { conflictKeys } when the save must be refused.
export function mergeOverrideSave(current, incoming, base) {
  if (!base) return { override: incoming };
  const currentVersion = (current && current.updatedAt) || null;
  if ((base.updatedAt || null) === currentVersion) return { override: incoming };

  const currentFields = (current && current.fields) || {};
  const merged = { fields: { ...currentFields } };
  for (const key of TOP_LEVEL_KEYS) merged[key] = (current && current[key]) || "";

  const conflictKeys = [];
  for (const [key, before] of Object.entries(base.top)) {
    if (merged[key] !== before) conflictKeys.push(key);
    else merged[key] = incoming[key];
  }
  for (const [key, before] of Object.entries(base.fields)) {
    if (!sameField(currentFields[key] || null, before)) conflictKeys.push(key);
    else if (incoming.fields[key]) merged.fields[key] = incoming.fields[key];
    else delete merged.fields[key];
  }
  return conflictKeys.length ? { conflictKeys } : { override: { ...incoming, ...merged } };
}
