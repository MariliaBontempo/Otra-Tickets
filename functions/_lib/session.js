// Server-side sign-in session: the Otra Guide access token lives in an
// HttpOnly cookie so page scripts never see it.

import { apiBase, fetchUserProfile } from "../admin/api/_auth.js";

export const SESSION_COOKIE = "otra_session";
const MAX_AGE = 5184000; // 60 days, matches the Guide access token lifetime

export function readSessionToken(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const value = part.slice(i + 1).trim();
      return value || null;
    }
  }
  return null;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Bearer header first, then the session cookie.
export function requestToken(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  return m ? m[1] : readSessionToken(request);
}

// Resolve the browser-facing user for a token.
// Returns { user } on success, { rejected: true } when Guide says 401,
// or { error: true } when Guide is unreachable or misbehaves.
export async function resolveUser(token, env) {
  let resp;
  try {
    resp = await fetch(`${apiBase(env)}/users/user-role/`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    return { error: true };
  }
  if (resp.status === 401) return { rejected: true };
  if (!resp.ok) return { error: true };
  const role = await resp.json().catch(() => ({}));
  const profile = (await fetchUserProfile(token, env)) || {};
  const email = String(profile.email || "").trim();
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return { user: { name: full || email, email, isStaff: !!(role && role.is_staff_or_admin) } };
}
