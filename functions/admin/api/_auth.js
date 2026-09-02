// Shared helpers for the /admin/api/* functions. Files starting with "_" are
// not routed by Pages — they're import-only.

export const OTRA_API = "https://otraguide.com/api";

export function apiBase(env) {
  return String((env && env.OTRA_API_URL) || OTRA_API).replace(/\/$/, "");
}

// Decode a JWT payload without verifying the signature. requireStaff /
// checkStaff already proved the token is a living staff session.
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const data = JSON.parse(atob(b64));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function fetchStaffRole(accessToken, env) {
  try {
    const resp = await fetch(`${apiBase(env)}/users/user-role/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && data.is_staff_or_admin ? data : null;
  } catch {
    return null;
  }
}

// Best-effort profile for History names. A miss must never fail login or save.
export async function fetchUserProfile(accessToken, env) {
  try {
    const resp = await fetch(`${apiBase(env)}/users/profile/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (Array.isArray(data)) return data[0] && typeof data[0] === "object" ? data[0] : null;
    if (Array.isArray(data && data.results)) return data.results[0] && typeof data.results[0] === "object" ? data.results[0] : null;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// Verify a JWT belongs to a staff/admin account via Otra Guide.
export async function checkStaff(accessToken, env) {
  return !!(await fetchStaffRole(accessToken, env));
}

// One user-role round trip. Returns { token, role } for staff, else null.
export async function staffSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  const role = await fetchStaffRole(m[1], env);
  return role ? { token: m[1], role } : null;
}

// Extract the Bearer token from a request and confirm it's a staff/admin.
// Returns the token if valid, else null. Use to gate every admin data call.
export async function requireStaff(request, env) {
  const session = await staffSession(request, env);
  return session ? session.token : null;
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
