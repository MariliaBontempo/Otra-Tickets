// Shared helpers for the /admin/api/* functions. Files starting with "_" are
// not routed by Pages — they're import-only.

export const OTRA_API = "https://otraguide.com/api";

// Verify a JWT belongs to a staff/admin account via Otra Guide.
export async function checkStaff(accessToken) {
  try {
    const resp = await fetch(`${OTRA_API}/users/user-role/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.is_staff_or_admin;
  } catch {
    return false;
  }
}

// Extract the Bearer token from a request and confirm it's a staff/admin.
// Returns the token if valid, else null. Use to gate every admin data call.
export async function requireStaff(request) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  return (await checkStaff(m[1])) ? m[1] : null;
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
